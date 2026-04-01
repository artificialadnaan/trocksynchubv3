/**
 * Portfolio Automation Runner
 * ===========================
 *
 * Wraps Phase 1, Phase 2, and Phase 3 with retry logic and
 * sends a branded completion/failure email after all attempts.
 */

import { storage } from "./storage";
import { sendEmail } from "./email-service";
import { log } from "./index";
import type {
  PortfolioAutomationResult,
  Phase1Output,
  Phase2Input,
} from "./playwright/portfolio-automation";

const MAX_RETRIES = 3; // Total attempts (1 original + 2 retries)
const RETRY_DELAY_MS = 30 * 1000; // 30 seconds between retries
const RETRY_BACKOFF_MULTIPLIER = 1.5; // Each retry waits longer: 30s, 45s, 67s

const DEFAULT_RECIPIENTS: string[] = [];

// ─── Phase 1 ────────────────────────────────────────────────────

export async function runPhase1WithRetry(
  bidboardProjectUrl: string,
  bidboardProjectId: string,
  context: {
    projectName?: string;
    projectNumber?: string;
    customerName?: string;
    triggerSource: "stage_sync" | "manual" | "rfp_approval";
  }
): Promise<Phase1Output> {
  const attempts: Array<{
    attempt: number;
    result: PortfolioAutomationResult;
    output?: Phase1Output;
    timestamp: Date;
  }> = [];
  const firstAttemptStart = new Date();
  let lastOutput: Phase1Output | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const attemptStart = new Date();
    log(
      `[portfolio-runner] Phase 1 attempt ${attempt}/${MAX_RETRIES} for bidboard ${bidboardProjectId}`,
      "playwright"
    );

    const { runPhase1 } = await import("./playwright/portfolio-automation");

    const completedStepNames =
      attempt > 1 && lastOutput
        ? lastOutput.result.steps
            .filter((s) => s.status === "success")
            .map((s) => s.step)
        : [];
    const previousOutput =
      attempt > 1 && lastOutput ? { estimateExcelPath: lastOutput.estimateExcelPath, proposalPdfPath: lastOutput.proposalPdfPath } : undefined;

    const output = await runPhase1(bidboardProjectUrl, bidboardProjectId, {
      completedStepNames,
      previousOutput,
    });
    lastOutput = output;
    const { result } = output;
    result.completedAt = result.completedAt ?? new Date();

    attempts.push({
      attempt,
      result,
      output,
      timestamp: new Date(),
    });

    if (result.success) {
      log(
        `[portfolio-runner] Phase 1 succeeded on attempt ${attempt}`,
        "playwright"
      );

      // Pre-register pending Phase 2 BEFORE attempting direct chain.
      // This ensures the Procore webhook can find the job even if it fires
      // during Phase 1 (race condition fix). If direct chain succeeds, we
      // mark it complete. If it fails, the webhook picks it up as fallback.
      const { registerPendingPhase2, markPhase2Complete: markComplete } = await import("./orchestrator/portfolio-orchestrator");
      let pendingJobRegistered = false;
      try {
        await registerPendingPhase2(bidboardProjectId, {
          bidboardProjectUrl,
          proposalPdfPath: output.proposalPdfPath ?? null,
          estimateExcelPath: output.estimateExcelPath ?? null,
          customerName: context.customerName,
        });
        pendingJobRegistered = true;
      } catch (regErr) {
        log(
          `[portfolio-runner] Warning: Could not pre-register pending Phase 2: ${regErr instanceof Error ? regErr.message : String(regErr)}`,
          "playwright"
        );
      }

      // If portfolioProjectId is missing (URL didn't redirect), try sync mapping lookup
      if (!result.portfolioProjectId) {
        try {
          const mapping = await storage.getSyncMappingByBidboardProjectId(bidboardProjectId);
          if (mapping?.portfolioProjectId) {
            result.portfolioProjectId = mapping.portfolioProjectId;
            log(`[portfolio-runner] Recovered portfolio project ID from sync mapping: ${mapping.portfolioProjectId}`, "playwright");
          }
        } catch { /* non-blocking */ }
      }

      // Chain Phase 2 and Phase 3 directly (primary path). Webhook remains as fallback if this fails.
      const companyId = (await storage.getAutomationConfig("procore_config"))?.value as { companyId?: string } | undefined;
      const cid = companyId?.companyId;
      let directChainSucceeded = false;
      if (cid && result.portfolioProjectId) {
        try {
          log(
            `[portfolio-runner] Chaining Phase 2 directly for portfolio ${result.portfolioProjectId}`,
            "playwright"
          );
          const { withBrowserLock } = await import("./playwright/browser");
          const { runPhase2 } = await import("./playwright/portfolio-automation");
          const phase2Result = await withBrowserLock(`phase2-${result.portfolioProjectId}`, () =>
            runPhase2(cid, result.portfolioProjectId!, bidboardProjectId, {
              bidboardProjectUrl,
              proposalPdfPath: output.proposalPdfPath ?? null,
              customerName: context.customerName,
            })
          );
          // Merge Phase 2 (and Phase 3) steps into result
          phase2Result.steps.forEach((s) => result.steps.push(s));
          result.success = result.success && phase2Result.success;
          result.completedAt = phase2Result.completedAt ?? result.completedAt;
          if (phase2Result.error) result.error = phase2Result.error;
          directChainSucceeded = phase2Result.success;
          log(
            `[portfolio-runner] Phase 2+3 direct chain ${phase2Result.success ? "succeeded" : "failed"}`,
            "playwright"
          );
        } catch (err) {
          log(
            `[portfolio-runner] Phase 2 direct chain failed (webhook fallback): ${err instanceof Error ? err.message : String(err)}`,
            "playwright"
          );
          result.error = (result.error ? result.error + "; " : "") + (err instanceof Error ? err.message : String(err));
          result.success = false;
        }
      } else {
        log(
          `[portfolio-runner] Cannot direct-chain Phase 2: companyId=${cid || 'MISSING'}, portfolioProjectId=${result.portfolioProjectId || 'MISSING'}`,
          "playwright"
        );
      }

      // If direct chain succeeded, mark pre-registered pending job as complete
      if (directChainSucceeded && pendingJobRegistered) {
        try {
          const { takeNextPendingPhase2 } = await import("./orchestrator/portfolio-orchestrator");
          const claimed = await takeNextPendingPhase2();
          if (claimed) {
            await markComplete(claimed.id);
            log(`[portfolio-runner] Marked pre-registered Phase 2 job #${claimed.id} as complete (direct chain succeeded)`, "playwright");
          }
        } catch (cleanupErr) {
          // Non-critical — job will expire naturally
        }
      }

      await sendPortfolioAutomationEmail(result, attempts, {
        projectName: context.projectName,
        projectNumber: context.projectNumber,
        bidboardProjectId,
        portfolioProjectId: result.portfolioProjectId,
        triggerSource: context.triggerSource,
        phase: cid && result.portfolioProjectId ? "phase2+3" : "phase1",
        firstAttemptStart,
        lastAttemptEnd: result.completedAt ?? new Date(),
      });
      return output;
    }

    const failedStep =
      result.steps.find((s) => s.status === "failed")?.step ?? "unknown";
    log(
      `[portfolio-runner] Phase 1 attempt ${attempt} failed at step "${failedStep}": ${result.error ?? "unknown"}`,
      "playwright"
    );

    if (attempt < MAX_RETRIES) {
      const delayMs =
        RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, attempt - 1);
      const delaySeconds = Math.round(delayMs / 1000);
      log(
        `[portfolio-runner] Phase 1 attempt ${attempt} failed at step "${failedStep}", retrying in ${delaySeconds}s...`,
        "playwright"
      );
      await sleep(delayMs);
    }
  }

  const finalResult = lastOutput!.result;
  finalResult.completedAt = finalResult.completedAt ?? new Date();

  await sendPortfolioAutomationEmail(finalResult, attempts, {
    projectName: context.projectName,
    projectNumber: context.projectNumber,
    bidboardProjectId,
    portfolioProjectId: finalResult.portfolioProjectId,
    triggerSource: context.triggerSource,
    phase: "phase1",
    firstAttemptStart,
    lastAttemptEnd: finalResult.completedAt,
  });

  return lastOutput!;
}

// ─── Phase 2 ────────────────────────────────────────────────────

export async function runPhase2WithRetry(
  companyId: string,
  portfolioProjectId: string,
  bidboardProjectId?: string,
  phase2Input?: Phase2Input,
  context?: {
    projectName?: string;
    triggerSource: "webhook" | "manual";
  }
): Promise<PortfolioAutomationResult> {
  const attempts: Array<{
    attempt: number;
    result: PortfolioAutomationResult;
    timestamp: Date;
  }> = [];
  const firstAttemptStart = new Date();
  let lastResult: PortfolioAutomationResult | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(
      `[portfolio-runner] Phase 2 attempt ${attempt}/${MAX_RETRIES} for portfolio ${portfolioProjectId}`,
      "playwright"
    );

    const { runPhase2 } = await import("./playwright/portfolio-automation");
    const result = await runPhase2(
      companyId,
      portfolioProjectId,
      bidboardProjectId ?? "unknown",
      phase2Input
    );
    lastResult = result;
    result.completedAt = result.completedAt ?? new Date();

    attempts.push({
      attempt,
      result,
      timestamp: new Date(),
    });

    if (result.success) {
      log(
        `[portfolio-runner] Phase 2 succeeded on attempt ${attempt}`,
        "playwright"
      );
      await sendPortfolioAutomationEmail(result, attempts, {
        projectName: context?.projectName,
        bidboardProjectId: bidboardProjectId ?? result.bidboardProjectId,
        portfolioProjectId,
        triggerSource: context?.triggerSource ?? "webhook",
        phase: phase2Input?.bidboardProjectUrl || phase2Input?.proposalPdfPath
          ? "phase2+3"
          : "phase2",
        firstAttemptStart,
        lastAttemptEnd: result.completedAt,
      });
      return result;
    }

    const failedStep =
      result.steps.find((s) => s.status === "failed")?.step ?? "unknown";
    log(
      `[portfolio-runner] Phase 2 attempt ${attempt} failed at step "${failedStep}": ${result.error ?? "unknown"}`,
      "playwright"
    );

    if (attempt < MAX_RETRIES) {
      const delayMs =
        RETRY_DELAY_MS * Math.pow(RETRY_BACKOFF_MULTIPLIER, attempt - 1);
      const delaySeconds = Math.round(delayMs / 1000);
      log(
        `[portfolio-runner] Phase 2 attempt ${attempt} failed at step "${failedStep}", retrying in ${delaySeconds}s...`,
        "playwright"
      );
      await sleep(delayMs);
    }
  }

  const finalResult = lastResult!;
  finalResult.completedAt = finalResult.completedAt ?? new Date();

  await sendPortfolioAutomationEmail(finalResult, attempts, {
    projectName: context?.projectName,
    bidboardProjectId: bidboardProjectId ?? finalResult.bidboardProjectId,
    portfolioProjectId,
    triggerSource: context?.triggerSource ?? "webhook",
    phase: phase2Input?.bidboardProjectUrl || phase2Input?.proposalPdfPath
      ? "phase2+3"
      : "phase2",
    firstAttemptStart,
    lastAttemptEnd: finalResult.completedAt,
  });

  return finalResult;
}

// ─── Email ──────────────────────────────────────────────────────

async function sendPortfolioAutomationEmail(
  finalResult: PortfolioAutomationResult,
  allAttempts: Array<{
    attempt: number;
    result: PortfolioAutomationResult;
    timestamp: Date;
  }>,
  ctx: {
    projectName?: string;
    projectNumber?: string;
    bidboardProjectId: string;
    portfolioProjectId?: string;
    triggerSource: string;
    phase: "phase1" | "phase2" | "phase2+3";
    firstAttemptStart: Date;
    lastAttemptEnd: Date;
  }
): Promise<void> {
  const config = await storage.getAutomationConfig(
    "portfolio_automation_email_config"
  );
  const emailConfig = (config?.value as {
    enabled?: boolean;
    recipients?: string[];
    frequency?: string;
  }) || {};
  const enabled = emailConfig.enabled ?? false;
  const frequency = emailConfig.frequency ?? "on_failure";
  const recipients =
    (emailConfig.recipients && emailConfig.recipients.length > 0
      ? emailConfig.recipients
      : DEFAULT_RECIPIENTS
    ).filter((e) => e && e.includes("@"));

  if (!enabled || recipients.length === 0) {
    log(
      `[portfolio-runner] Email disabled or no recipients, skipping completion email`,
      "playwright"
    );
    return;
  }

  if (frequency === "never") return;
  if (frequency === "on_failure" && finalResult.success) {
    log(
      `[portfolio-runner] Email frequency is on_failure and run succeeded, skipping`,
      "playwright"
    );
    return;
  }

  const projectName =
    ctx.projectName ?? finalResult.bidboardProjectId ?? "Unknown Project";
  const totalDurationMs =
    ctx.lastAttemptEnd.getTime() - ctx.firstAttemptStart.getTime();
  const totalDurationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;

  const statusColor = finalResult.success ? "#22c55e" : "#d11921";
  const statusText = finalResult.success
    ? "SUCCESS"
    : `FAILED after ${allAttempts.length} attempts`;

  const stepsRows = (finalResult.steps || [])
    .map((s) => {
      const emoji =
        s.status === "success"
          ? "✅"
          : s.status === "failed"
            ? "❌"
            : "⏭";
      const bg = finalResult.steps.indexOf(s) % 2 === 0 ? "#fff" : "#f5f5f5";
      return `<tr style="background-color: ${bg};"><td style="padding: 8px;">${escapeHtml(s.step)}</td><td style="padding: 8px; text-align: center;">${emoji} ${escapeHtml(s.status)}</td><td style="padding: 8px; text-align: right;">${s.duration}ms</td></tr>`;
    })
    .join("");

  const firstFailedStep =
    finalResult.steps.find((s) => s.status === "failed")?.step ?? null;

  const errorSection =
    !finalResult.success && (finalResult.error || firstFailedStep)
      ? `
<div style="padding: 20px 30px;">
  <h3 style="color: #d11921;">Error Details</h3>
  <p style="background: #fef2f2; padding: 12px; border-left: 4px solid #d11921; font-family: monospace;">
    ${escapeHtml(finalResult.error || "Unknown error")}
  </p>
  ${firstFailedStep ? `<p>Failed at step: <strong>${escapeHtml(firstFailedStep)}</strong></p>` : ""}
</div>
`
      : "";

  const retryHistoryRows =
    allAttempts.length > 1
      ? allAttempts
          .map(
            (a) => `
    <tr>
      <td style="padding: 8px;">${a.attempt}</td>
      <td style="padding: 8px;">${a.timestamp.toISOString()}</td>
      <td style="padding: 8px;">${a.result.success ? "✅" : "❌"}</td>
      <td style="padding: 8px;">${escapeHtml(a.result.steps.find((s) => s.status === "failed")?.step ?? "—")}</td>
    </tr>
`
          )
          .join("")
      : "";

  const retryHistorySection =
    allAttempts.length > 1
      ? `
<div style="padding: 0 30px;">
  <h3>Attempt History</h3>
  <table style="width: 100%; border-collapse: collapse;">
    <tr style="background-color: #2c2f32; color: #fff;">
      <th style="padding: 8px;">Attempt</th>
      <th style="padding: 8px;">Time</th>
      <th style="padding: 8px;">Result</th>
      <th style="padding: 8px;">Failed Step</th>
    </tr>
    ${retryHistoryRows}
  </table>
</div>
`
      : "";

  const htmlBody = `
<div style="font-family: sans-serif; max-width: 640px; margin: 0 auto;">
  <div style="background-color: #2c2f32; padding: 20px 30px; text-align: center;">
    <h1 style="color: #ffffff; margin: 0; font-size: 20px;">T-Rock Sync Hub</h1>
    <p style="color: #d11921; margin: 5px 0 0; font-size: 14px;">Portfolio Automation Report</p>
  </div>

  <div style="background-color: ${statusColor}; color: #fff; padding: 15px 30px; text-align: center;">
    <h2 style="margin: 0;">${statusText}</h2>
  </div>

  <div style="padding: 20px 30px;">
    <table>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Project:</strong></td><td>${escapeHtml(projectName)}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Project #:</strong></td><td>${escapeHtml(ctx.projectNumber ?? "—")}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Bid Board ID:</strong></td><td>${escapeHtml(ctx.bidboardProjectId)}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Portfolio ID:</strong></td><td>${escapeHtml(ctx.portfolioProjectId ?? "N/A")}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Triggered By:</strong></td><td>${escapeHtml(ctx.triggerSource)}</td></tr>
      <tr><td style="padding: 4px 8px 4px 0;"><strong>Total Duration:</strong></td><td>${totalDurationStr}</td></tr>
    </table>
  </div>

  <div style="padding: 0 30px;">
    <h3>Automation Steps (Final Attempt)</h3>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background-color: #2c2f32; color: #fff;">
          <th style="padding: 8px; text-align: left;">Step</th>
          <th style="padding: 8px; text-align: center;">Status</th>
          <th style="padding: 8px; text-align: right;">Duration</th>
        </tr>
      </thead>
      <tbody>
        ${stepsRows || "<tr><td colspan='3'>No steps recorded</td></tr>"}
      </tbody>
    </table>
  </div>

  ${errorSection}
  ${retryHistorySection}

  <div style="background-color: #2c2f32; padding: 15px 30px; text-align: center;">
    <p style="color: #999; margin: 0; font-size: 12px;">T-Rock Sync Hub — Automated Portfolio Workflow</p>
  </div>
</div>
`;

  const subject = finalResult.success
    ? `✅ Portfolio Automation Complete — ${projectName}`
    : `❌ Portfolio Automation Failed — ${projectName} (after ${allAttempts.length} attempts)`;

  const dedupeBase = `portfolio_automation:${ctx.bidboardProjectId}:${ctx.phase}:${ctx.lastAttemptEnd.getTime()}`;

  for (const email of recipients) {
    try {
      const result = await sendEmail({
        to: email,
        subject,
        htmlBody,
        fromName: "T-Rock Sync Hub",
      });
      await storage.createEmailSendLog({
        templateKey: "portfolio_automation_report",
        recipientEmail: email,
        recipientName: null,
        subject,
        dedupeKey: `${dedupeBase}:${email}`,
        status: result.success ? "sent" : "failed",
        errorMessage: result.error ?? null,
        metadata: {
          bidboardProjectId: ctx.bidboardProjectId,
          phase: ctx.phase,
          success: finalResult.success,
          attempts: allAttempts.length,
        },
        sentAt: new Date(),
      });
      log(
        `[portfolio-runner] Email ${result.success ? "sent" : "failed"} to ${email}`,
        "playwright"
      );
    } catch (err) {
      log(
        `[portfolio-runner] Failed to send email to ${email}: ${err instanceof Error ? err.message : String(err)}`,
        "playwright"
      );
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
