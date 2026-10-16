/**
 * Pending RFP Digest Scheduler — end-of-day reminder of un-approved RFPs.
 * =======================================================================
 * Fires Mon–Sat at 5:00 PM America/Chicago. Reads every still-pending
 * rfp_approval_requests row and builds a PER-RECIPIENT digest (buildPendingRfpDigest):
 * each approver gets one email listing only the RFPs they're authorized to approve, so a
 * recipient never receives an actionable link for an RFP outside their routing. Sends one
 * scoped email per approver (bypassing GLOBAL_CC so links aren't fanned out to observers).
 * Skips entirely when no approver has an actionable pending RFP.
 */

import cron from "node-cron";
import { eq, asc } from "drizzle-orm";
import { db } from "../db";
import { rfpApprovalRequests } from "@shared/schema";
import { checkRfpApprovalSourceEligibility, getRfpReviewRecipients, isRfpApprovalRequestExpired } from "../rfp-approval";
import { buildPendingRfpDigest } from "../pendingRfpDigest";
import { parseOlderThanDays, selectOpenPendingRfps } from "../pendingRfpOpen";

/**
 * PENDING_RFP_DIGEST_OPEN_ONLY (exactly "true"; default OFF; owner 2026-10-15 via 68): list only RFPs whose source
 * deal is still open (the approve gate's own eligibility rule, fail-open on a failed check), and fold any pending
 * longer than PENDING_RFP_DIGEST_OLDER_DAYS (default 30) into one "Older (n)" line per approver. Off: today's digest.
 */
export function pendingRfpDigestOptions(env: NodeJS.ProcessEnv = process.env): { openOnly: boolean; olderThanDays: number | undefined } {
  if (env.PENDING_RFP_DIGEST_OPEN_ONLY !== "true") return { openOnly: false, olderThanDays: undefined };
  return { openOnly: true, olderThanDays: parseOlderThanDays(env.PENDING_RFP_DIGEST_OLDER_DAYS) };
}
import { sendEmail } from "../email-service";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

async function runPendingRfpDigest(): Promise<void> {
  try {
    // Review links must use the public base URL. If it isn't configured, skip the
    // send entirely rather than email out unusable localhost links.
    const appUrl = process.env.APP_URL?.trim();
    if (!appUrl) {
      console.error(
        "[pending-rfp-digest] APP_URL is not configured — skipping the digest to avoid sending unusable review links."
      );
      return;
    }

    const pending = await db
      .select()
      .from(rfpApprovalRequests)
      .where(eq(rfpApprovalRequests.status, "pending"))
      .orderBy(asc(rfpApprovalRequests.createdAt));
    const options = pendingRfpDigestOptions();
    // Only the RFPs still open in their source (flag on): won, lost, deactivated or no-longer-RFP deals drop out.
    const rows = options.openOnly
      ? await selectOpenPendingRfps(pending, checkRfpApprovalSourceEligibility, isRfpApprovalRequestExpired)
      : pending;

    // jsonb columns infer as `unknown`; cast at the boundary (same as rfp-reports.ts) so the
    // pure builder keeps its strict, documented row shape.
    const digest = await buildPendingRfpDigest(
      rows.map((r) => ({
        token: r.token,
        createdAt: r.createdAt,
        dealData: (r.dealData as Record<string, unknown> | null) ?? null,
        editedFields: (r.editedFields as Record<string, unknown> | null) ?? null,
        sourceSystem: r.sourceSystem,
        tokenExpiresAt: r.tokenExpiresAt,
      })),
      getRfpReviewRecipients,
      appUrl,
      isRfpApprovalRequestExpired,
      options.olderThanDays === undefined ? {} : { olderThanDays: options.olderThanDays }
    );
    if (digest.skip || digest.perRecipient.length === 0) {
      console.log(
        `[pending-rfp-digest] No email sent (fetched=${pending.length}, open=${rows.length}, actionable=${digest.pendingCount}, recipients=${digest.perRecipient.length})`
      );
      return;
    }

    // One SCOPED email per approver — each gets only the RFPs they may approve. bypassGlobalCc
    // keeps each approver's links from being fanned out to GLOBAL_CC observers (which would
    // re-create the cross-type-approval exposure this per-recipient design exists to close).
    let sent = 0;
    let failed = 0;
    for (const r of digest.perRecipient) {
      // sendEmail can resolve { success: false, error } WITHOUT throwing (e.g. "Gmail not
      // connected"); capture each result so a swallowed failure is logged, not silent.
      const result = await sendEmail({
        to: r.recipient,
        subject: r.subject,
        htmlBody: r.htmlBody,
        bypassGlobalCc: true,
      });
      if (result.success) {
        sent += 1;
      } else {
        failed += 1;
        console.error(
          `[pending-rfp-digest] Digest send FAILED to ${r.recipient} (count=${r.count}, provider=${result.provider}): ${result.error ?? "unknown error"}`
        );
      }
    }
    console.log(
      `[pending-rfp-digest] Per-recipient digest complete: pendingActionable=${digest.pendingCount}, recipients=${digest.perRecipient.length}, sent=${sent}, failed=${failed}`
    );
  } catch (e: unknown) {
    console.error(
      "[pending-rfp-digest] Scheduled digest failed:",
      e instanceof Error ? e.message : e
    );
  }
}

export function startPendingRfpDigestScheduler() {
  stopPendingRfpDigestScheduler();
  // Mon–Sat at 5:00 PM Central — end-of-day reminder before approvers leave.
  cronTask = cron.schedule("0 17 * * 1-6", runPendingRfpDigest, {
    timezone: "America/Chicago",
  });
  console.log("[pending-rfp-digest] EOD pending-RFP digest scheduler started (Mon–Sat 5:00 PM CT)");
}

export function stopPendingRfpDigestScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
