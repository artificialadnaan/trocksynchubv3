import type { Express, RequestHandler } from "express";
import path from "path";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";

const DOWNLOADS_DIR = path.join(process.cwd(), "data", "portfolio-automation-downloads");
const PLAYWRIGHT_STORAGE = process.env.PLAYWRIGHT_STORAGE_DIR || ".playwright-storage";

const testJobResults = new Map<
  string,
  { status: "running" | "completed"; result?: unknown; error?: string; completedAt?: string }
>();

function safeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes("..");
}

export function registerPortfolioRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/portfolio-automation/runs", requireAuth, asyncHandler(async (_req, res) => {
    const logs = await storage.getPortfolioAutomationLogs(300);
    const RUN_WINDOW_MS = 30 * 60 * 1000;
    const runsMap = new Map<string, typeof logs>();

    for (const log of logs) {
      const projectId = log.projectId || log.projectName || "unknown";
      const ts = log.createdAt ? new Date(log.createdAt).getTime() : 0;
      const bucket = Math.floor(ts / RUN_WINDOW_MS);
      const key = `${projectId}:${bucket}`;

      if (!runsMap.has(key)) runsMap.set(key, []);
      runsMap.get(key)!.push(log);
    }

    const runs: Array<{
      id: string;
      projectId: string;
      projectName: string;
      startedAt: string;
      completedAt: string;
      status: "success" | "failed" | "partial";
      duration: number;
      totalSteps: number;
      completedSteps: number;
      failedSteps: number;
      steps: Array<{
        step: string;
        status: string;
        duration: number;
        error?: string;
        screenshotPath?: string;
        pageUrl?: string;
        diagnostics?: Record<string, unknown>;
      }>;
    }> = [];

    const keys = Array.from(runsMap.keys()).slice(0, 50);
    for (const key of keys) {
      const runLogs = runsMap.get(key)!;
      const sorted = [...runLogs].sort(
        (a, b) =>
          (a.createdAt ? new Date(a.createdAt).getTime() : 0) -
          (b.createdAt ? new Date(b.createdAt).getTime() : 0)
      );

      const steps = sorted.map((l) => {
        const step = (l.action || "").replace(/^portfolio_automation:/, "") || "unknown";
        const details = (l.details as Record<string, unknown>) || {};
        return {
          step,
          status: l.status || "unknown",
          duration: (details.duration as number) || 0,
          error: l.errorMessage || undefined,
          screenshotPath: l.screenshotPath || undefined,
          pageUrl: (details.pageUrl as string) || undefined,
          diagnostics: (details.diagnostics as Record<string, unknown>) || undefined,
        };
      });

      const firstTs = sorted[0]?.createdAt;
      const lastTs = sorted[sorted.length - 1]?.createdAt;
      const startTs = firstTs != null ? new Date(firstTs).getTime() : 0;
      const endTs = lastTs != null ? new Date(lastTs).getTime() : startTs;
      const duration = endTs - startTs;

      const completedSteps = steps.filter((s) => s.status === "success").length;
      const failedSteps = steps.filter((s) => s.status === "failed").length;
      const totalSteps = steps.length;

      let status: "success" | "failed" | "partial" = "success";
      if (failedSteps > 0) status = totalSteps === failedSteps ? "failed" : "partial";

      const firstCreated = sorted[0]?.createdAt ?? undefined;
      const lastCreated = sorted[sorted.length - 1]?.createdAt ?? undefined;
      runs.push({
        id: key,
        projectId: runLogs[0]?.projectId || "unknown",
        projectName: runLogs[0]?.projectName || runLogs[0]?.projectId || "Unknown",
        startedAt: new Date((firstCreated as Date | string) || Date.now()).toISOString(),
        completedAt: new Date((lastCreated as Date | string) || Date.now()).toISOString(),
        status,
        duration,
        totalSteps,
        completedSteps,
        failedSteps,
        steps,
      });
    }

    res.json({ runs });
  }));

  app.get("/api/portfolio-automation/documents", requireAuth, asyncHandler(async (_req, res) => {
    const fs = await import("fs/promises");
    const pathMod = await import("path");
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});
    const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
    const documents: Array<{
      filename: string;
      type: "estimate-excel" | "proposal-pdf";
      createdAt: string;
      size: number;
      downloadUrl: string;
    }> = [];

    for (const e of entries) {
      if (!e.isFile()) continue;
      const fullPath = pathMod.join(DOWNLOADS_DIR, e.name);
      const stat = await fs.stat(fullPath);
      const type = e.name.startsWith("estimate-") && e.name.endsWith(".xlsx")
        ? "estimate-excel"
        : e.name.startsWith("proposal-") && e.name.endsWith(".pdf")
        ? "proposal-pdf"
        : null;
      if (type) {
        documents.push({
          filename: e.name,
          type,
          createdAt: stat.mtime.toISOString(),
          size: stat.size,
          downloadUrl: `/api/portfolio-automation/documents/${encodeURIComponent(e.name)}`,
        });
      }
    }

    documents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ documents });
  }));

  app.get("/api/portfolio-automation/documents/:filename", requireAuth, asyncHandler(async (req, res) => {
    const filename = decodeURIComponent(req.params.filename || "");
    if (!safeFilename(path.basename(filename))) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const fullPath = path.join(DOWNLOADS_DIR, filename);
    const fs = await import("fs/promises");
    await fs.access(fullPath);
    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === ".xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const stream = (await import("fs")).createReadStream(fullPath);
    stream.pipe(res);
  }));

  app.get("/api/portfolio-automation/screenshots/:filename", requireAuth, asyncHandler(async (req, res) => {
    const filename = decodeURIComponent(req.params.filename || "");
    if (!safeFilename(path.basename(filename))) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const fullPath = path.join(PLAYWRIGHT_STORAGE, filename);
    const fs = await import("fs/promises");
    await fs.access(fullPath);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    const stream = (await import("fs")).createReadStream(fullPath);
    stream.pipe(res);
  }));

  app.get("/api/portfolio-automation/config", requireAuth, asyncHandler(async (_req, res) => {
    const [automationConfig, emailConfig] = await Promise.all([
      storage.getAutomationConfig("portfolio_automation"),
      storage.getAutomationConfig("portfolio_automation_email_config"),
    ]);

    const av = (automationConfig?.value as { enabled?: boolean }) || {};
    const ev = (emailConfig?.value as { enabled?: boolean; recipients?: string[]; frequency?: string }) || {};

    res.json({
      enabled: av.enabled ?? false,
      emailConfig: {
        enabled: ev.enabled ?? false,
        recipients: ev.recipients ?? [],
        frequency: ev.frequency ?? "on_failure",
      },
    });
  }));

  app.post("/api/portfolio-automation/config", requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled === "boolean") {
      await storage.upsertAutomationConfig({
        key: "portfolio_automation",
        value: { enabled: body.enabled },
        description: "Portfolio automation enable/disable",
      });
    }
    if (body.emailConfig) {
      const ec = body.emailConfig as { enabled?: boolean; recipients?: string[]; frequency?: string };
      await storage.upsertAutomationConfig({
        key: "portfolio_automation_email_config",
        value: {
          enabled: ec.enabled ?? false,
          recipients: ec.recipients ?? [],
          frequency: ec.frequency ?? "on_failure",
        },
        description: "Portfolio automation email reports config",
      });
    }
    res.json({ ok: true });
  }));

  app.post("/api/portfolio-automation/trigger", requireAuth, asyncHandler(async (req, res) => {
    const { bidboardProjectId, projectNumber } = req.body || {};
    const input = String(bidboardProjectId || projectNumber || "").trim();
    if (!input) {
      return res.status(400).json({ error: "bidboardProjectId or projectNumber required" });
    }

    const config = await storage.getAutomationConfig("procore_config");
    const companyId = (config?.value as { companyId?: string })?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: "Procore company ID not configured" });
    }

    let bidboardId: string | null = null;
    let proposalId: string | null = null;

    // 15+ digit numeric string → treat as Bid Board project ID directly
    if (/^\d{15,}$/.test(input)) {
      bidboardId = input;
      const mapping = await storage.getSyncMappingByBidboardProjectId(input);
      proposalId = (mapping?.metadata as any)?.proposalId || null;
    } else {
      // Contains letters/dashes → project number; look up in sync mappings
      const allMappings = await storage.getSyncMappings();
      // Prefer mapping with bidboardProjectId
      const match = allMappings.find(
        (m) => m.procoreProjectNumber === input && m.bidboardProjectId
      ) || allMappings.find((m) => m.procoreProjectNumber === input);
      if (match?.bidboardProjectId) {
        bidboardId = match.bidboardProjectId;
        proposalId = (match.metadata as any)?.proposalId || null;
      }
    }

    if (!bidboardId) {
      return res.status(400).json({
        error: "Project number not found in sync mappings. Use a 15+ digit Bid Board project ID for direct lookup.",
      });
    }

    const url = proposalId
      ? `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardId}/details?proposalId=${proposalId}`
      : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardId}/details`;
    const jobId = `portfolio-auto-${Date.now()}`;
    res.json({ jobId, message: "Automation started", bidboardId, proposalId, url });

    setImmediate(async () => {
      try {
        const { runPhase1WithRetry } = await import("../portfolio-automation-runner");
        await runPhase1WithRetry(url, bidboardId!, { triggerSource: "manual" });
      } catch (err) {
        console.error("[portfolio-auto] Manual trigger failed:", (err as Error).message);
      }
    });
  }));

  // ═══ Internal test trigger (no auth, secured by secret) ─────────────────────
  app.post("/api/internal/portfolio-trigger", asyncHandler(async (req, res) => {
    const secret = req.headers["x-internal-secret"] || req.body?.secret;
    if (secret !== (process.env.INTERNAL_API_SECRET || "synchub-test-2026")) {
      return res.status(403).json({ error: "Invalid secret" });
    }

    const { bidboardProjectId } = req.body || {};
    if (!bidboardProjectId) return res.status(400).json({ error: "bidboardProjectId required" });

    const config = await storage.getAutomationConfig("procore_config");
    const companyId = (config?.value as { companyId?: string })?.companyId;
    if (!companyId) return res.status(400).json({ error: "Procore not configured" });

    const mapping = await storage.getSyncMappingByBidboardProjectId(bidboardProjectId);
    const proposalId = (mapping?.metadata as any)?.proposalId || null;
    const url = proposalId
      ? `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details?proposalId=${proposalId}`
      : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details`;

    res.json({ message: "Automation started", bidboardProjectId, proposalId, url });

    setImmediate(async () => {
      try {
        const { runPhase1WithRetry } = await import("../portfolio-automation-runner");
        await runPhase1WithRetry(url, bidboardProjectId, {
          projectName: mapping?.hubspotDealName || mapping?.bidboardProjectName || undefined,
          triggerSource: "manual",
        });
      } catch (err) {
        console.error("[portfolio-auto] Internal trigger failed:", (err as Error).message);
      }
    });
  }));

  // ═══ Internal Phase 2 trigger (no auth, secured by secret) ─────────────────
  app.post("/api/internal/portfolio-phase2", asyncHandler(async (req, res) => {
    const secret = req.headers["x-internal-secret"] || req.body?.secret;
    if (secret !== (process.env.INTERNAL_API_SECRET || "synchub-test-2026")) {
      return res.status(403).json({ error: "Invalid secret" });
    }
    const { companyId, portfolioProjectId, bidboardProjectId } = req.body || {};
    if (!companyId || !portfolioProjectId) {
      return res.status(400).json({ error: "companyId and portfolioProjectId required" });
    }

    // Look up mapping to get bidboardProjectUrl and proposalId for Phase 3 chaining
    let bidboardProjectUrl: string | undefined;
    let proposalPdfPath: string | null = null;
    if (bidboardProjectId) {
      const mapping = await storage.getSyncMappingByBidboardProjectId(bidboardProjectId);
      const proposalId = (mapping?.metadata as any)?.proposalId;
      bidboardProjectUrl = proposalId
        ? `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details?proposalId=${proposalId}`
        : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details`;

      // Look up proposal PDF from pending Phase 2 job or recent downloads
      try {
        const { getPendingPhase2ForBidboard } = await import("../orchestrator/portfolio-orchestrator");
        const pendingJob = await getPendingPhase2ForBidboard(bidboardProjectId);
        if (pendingJob?.proposalPdfPath) {
          proposalPdfPath = pendingJob.proposalPdfPath;
        }
      } catch { /* non-blocking */ }
    }

    res.json({ message: "Phase 2+3 started", companyId, portfolioProjectId, bidboardProjectId, bidboardProjectUrl });
    setImmediate(async () => {
      try {
        const { withBrowserLock } = await import("../playwright/browser");
        const { runPhase2 } = await import("../playwright/portfolio-automation");
        const phase2Input = bidboardProjectUrl ? {
          bidboardProjectUrl,
          proposalPdfPath,
          customerName: undefined,
        } : undefined;
        const result = await withBrowserLock(`phase2-${portfolioProjectId}`, () =>
          runPhase2(companyId, portfolioProjectId, bidboardProjectId, phase2Input)
        );
        console.log(`[portfolio-auto] Phase 2+3 internal trigger: ${result.success ? "success" : "failed"} (${result.steps.length} steps)`);
      } catch (err) {
        console.error("[portfolio-auto] Phase 2+3 internal trigger failed:", (err as Error).message);
      }
    });
  }));

  // ═══ Portfolio Automation Test Endpoints (phase-by-phase) ───────────────────

  app.post("/api/portfolio-automation/test/phase1", requireAuth, asyncHandler(async (req, res) => {
    const { bidboardProjectUrl, bidboardProjectId } = req.body || {};
    if (!bidboardProjectUrl || !bidboardProjectId) {
      return res.status(400).json({ error: "bidboardProjectUrl and bidboardProjectId are required" });
    }
    const jobId = `phase1-${Date.now()}`;
    testJobResults.set(jobId, { status: "running" });
    res.json({ jobId, status: "started" });

    setImmediate(async () => {
      try {
        console.log(`[portfolio-test] Phase 1 started: ${jobId}`);
        const { runPhase1 } = await import("../playwright/portfolio-automation");
        const output = await runPhase1(bidboardProjectUrl, bidboardProjectId);
        testJobResults.set(jobId, {
          status: "completed",
          result: output,
          completedAt: new Date().toISOString(),
        });
        console.log(`[portfolio-test] Phase 1 completed: ${jobId} success=${output.result.success}`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[portfolio-test] Phase 1 failed: ${jobId}`, msg);
        testJobResults.set(jobId, { status: "completed", error: msg, completedAt: new Date().toISOString() });
      }
    });
  }));

  app.post("/api/portfolio-automation/test/phase2", requireAuth, asyncHandler(async (req, res) => {
    const { companyId, portfolioProjectId, bidboardProjectId } = req.body || {};
    if (!companyId || !portfolioProjectId) {
      return res.status(400).json({ error: "companyId and portfolioProjectId are required" });
    }
    const jobId = `phase2-${Date.now()}`;
    testJobResults.set(jobId, { status: "running" });
    res.json({ jobId, status: "started" });

    setImmediate(async () => {
      try {
        console.log(`[portfolio-test] Phase 2 started: ${jobId}`);
        const { runPhase2 } = await import("../playwright/portfolio-automation");
        const result = await runPhase2(companyId, portfolioProjectId, bidboardProjectId);
        testJobResults.set(jobId, {
          status: "completed",
          result,
          completedAt: new Date().toISOString(),
        });
        console.log(`[portfolio-test] Phase 2 completed: ${jobId} success=${result.success}`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[portfolio-test] Phase 2 failed: ${jobId}`, msg);
        testJobResults.set(jobId, { status: "completed", error: msg, completedAt: new Date().toISOString() });
      }
    });
  }));

  app.post("/api/portfolio-automation/test/phase3", requireAuth, asyncHandler(async (req, res) => {
    const { companyId, portfolioProjectId, bidboardProjectUrl, proposalPdfPath, bidboardProjectId, customerName } = req.body || {};
    if (!companyId || !portfolioProjectId || !bidboardProjectUrl) {
      return res.status(400).json({ error: "companyId, portfolioProjectId, and bidboardProjectUrl are required" });
    }
    const jobId = `phase3-${Date.now()}`;
    testJobResults.set(jobId, { status: "running" });
    res.json({ jobId, status: "started" });

    setImmediate(async () => {
      try {
        console.log(`[portfolio-test] Phase 3 started: ${jobId}`);
        const { runPhase3 } = await import("../playwright/portfolio-automation");
        const result = await runPhase3(
          companyId,
          portfolioProjectId,
          bidboardProjectUrl,
          proposalPdfPath || null,
          bidboardProjectId,
          undefined,
          customerName || undefined
        );
        testJobResults.set(jobId, {
          status: "completed",
          result,
          completedAt: new Date().toISOString(),
        });
        console.log(`[portfolio-test] Phase 3 completed: ${jobId} success=${result.success}`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[portfolio-test] Phase 3 failed: ${jobId}`, msg);
        testJobResults.set(jobId, { status: "completed", error: msg, completedAt: new Date().toISOString() });
      }
    });
  }));

  app.get("/api/portfolio-automation/test/status/:jobId", requireAuth, asyncHandler(async (req, res) => {
    const { jobId } = req.params;
    const job = testJobResults.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found", jobId });
    }
    res.json(job);
  }));

  app.get("/api/portfolio-automation/test/downloads", requireAuth, asyncHandler(async (_req, res) => {
    const fs = await import("fs/promises");
    await fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});
    const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true });
    const files: Array<{ filename: string; size: number; mtime: string }> = [];

    for (const e of entries) {
      if (!e.isFile()) continue;
      const fullPath = path.join(DOWNLOADS_DIR, e.name);
      const stat = await fs.stat(fullPath);
      files.push({
        filename: e.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }

    files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
    res.json({ files });
  }));
}
