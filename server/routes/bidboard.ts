import type { Express, RequestHandler } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { updateHubSpotDealStage } from "../hubspot";
import { testLogin as testProcoreLogin, saveProcoreCredentials, logout as logoutProcore } from "../playwright/auth";
import { runPortfolioTransition, runFullPortfolioWorkflow } from "../playwright/portfolio";
import { syncHubSpotClientToBidBoard } from "../playwright/bidboard";
import { runBidBoardStageSync } from "../sync";
import { syncHubSpotAttachmentsToBidBoard, syncBidBoardDocumentsToPortfolio } from "../playwright/documents";
import { closeBrowser } from "../playwright/browser";
import { runBidBoardPolling, getAutomationStatus, enableBidBoardAutomation, manualSyncProject, onBidBoardProjectCreated, detectAndProcessNewProjects } from "../bidboard-automation";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Module-level polling state
let bidboardPollingTimer: ReturnType<typeof setInterval> | null = null;
let lastBidboardPollAt: Date | null = null;
let lastBidboardPollResult: any = null;
let bidboardPollingRunning = false;

// Module-level stage sync state
let bidboardStageSyncTimer: ReturnType<typeof setInterval> | null = null;
let bidboardStageSyncRunning = false;
let lastBidboardStageSyncAt: Date | null = null;

async function runBidboardPollingCycle() {
  if (bidboardPollingRunning) {
    console.log('[BidBoardPolling] Already running, skipping');
    return;
  }

  bidboardPollingRunning = true;
  console.log('[BidBoardPolling] Starting polling cycle');
  const startTime = Date.now();

  try {
    const result = await runBidBoardPolling();
    lastBidboardPollAt = new Date();
    lastBidboardPollResult = result;

    const duration = Date.now() - startTime;
    console.log(`[BidBoardPolling] Complete in ${(duration / 1000).toFixed(1)}s — ${result.projectsScraped} projects, ${result.stageChanges.length} changes`);
  } catch (e: any) {
    console.error('[BidBoardPolling] Polling failed:', e.message);
    lastBidboardPollAt = new Date();
    lastBidboardPollResult = { error: e.message };
  } finally {
    bidboardPollingRunning = false;
  }
}

function startBidboardPolling(intervalMinutes: number) {
  stopBidboardPolling();
  console.log(`[BidBoardPolling] Starting automatic polling every ${intervalMinutes} minutes`);
  bidboardPollingTimer = setInterval(() => runBidboardPollingCycle(), intervalMinutes * 60 * 1000);
}

function stopBidboardPolling() {
  if (bidboardPollingTimer) {
    clearInterval(bidboardPollingTimer);
    bidboardPollingTimer = null;
    console.log('[BidBoardPolling] Stopped automatic polling');
  }
}

async function safeCreateBidboardStageSyncRun(data: Parameters<typeof storage.createBidboardStageSyncRun>[0]): Promise<void> {
  try {
    await storage.createBidboardStageSyncRun(data);
  } catch (e: any) {
    console.warn("[BidBoardStageSync] Could not persist run to bidboard_stage_sync_runs (table may not exist):", e.message);
  }
}

async function runBidBoardStageSyncCycle() {
  if (bidboardStageSyncRunning) {
    console.log("[BidBoardStageSync] Already running, skipping");
    return;
  }
  bidboardStageSyncRunning = true;
  console.log("[BidBoardStageSync] Starting sync cycle");
  try {
    const config = await storage.getAutomationConfig("bidboard_stage_sync");
    const val = (config?.value as any) || {};
    const dryRun = val.dryRun !== false;
    const { withBrowserLock } = await import("../playwright/browser");
    const result = await withBrowserLock("bidboard-stage-sync", () => runBidBoardStageSync({ dryRun }));
    lastBidboardStageSyncAt = new Date();
    const runStatus = result.initialized
      ? "initialized"
      : dryRun
        ? "dry_run"
        : (result.failed > 0 ? (result.changed > 0 ? "partial" : "failed") : "success");
    await safeCreateBidboardStageSyncRun({
      status: runStatus,
      totalChanges: result.total,
      syncedCount: result.changed,
      failedCount: result.failed,
      changes: result.changes,
      errors: result.errors,
      exportPath: result.exportPath,
    });
    console.log(`[BidBoardStageSync] Complete — ${dryRun ? "[DRY RUN] " : ""}${result.changed} synced, ${result.failed} failed`);
  } catch (e: any) {
    lastBidboardStageSyncAt = new Date();
    await safeCreateBidboardStageSyncRun({ status: "failed", errors: [e.message] });
    console.error("[BidBoardStageSync] Failed:", e.message);
  } finally {
    bidboardStageSyncRunning = false;
  }
}

export function registerBidboardRoutes(app: Express, requireAuth: RequestHandler) {
  // ── Import ────────────────────────────────────────────────────────────────

  app.post("/api/bidboard/import", requireAuth, upload.single("file"), asyncHandler(async (req: any, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet) as any[];

    if (!rows.length) return res.status(400).json({ message: "Empty spreadsheet" });

    const oldEstimates = await storage.getBidboardEstimates({ limit: 10000, offset: 0 });
    const oldStatusMap = new Map<string, string>();
    for (const est of oldEstimates.data) {
      if (est.name && est.status) {
        oldStatusMap.set(est.name.trim().toLowerCase(), est.status);
      }
    }

    const dbProjectNames = await storage.getProcoreProjects({ limit: 10000, offset: 0 });
    const dbNameMap = new Map<string, string>();
    for (const p of dbProjectNames.data) {
      dbNameMap.set((p.name || "").trim().toLowerCase(), String(p.procoreId));
    }

    await storage.clearBidboardEstimates();

    let imported = 0, matched = 0, unmatched = 0;
    const statusChanges: { name: string; oldStatus: string; newStatus: string }[] = [];

    for (const row of rows) {
      const name = (row.Name || "").trim();
      if (!name) continue;

      const newStatus = (row.Status || "").trim();

      let createdDate: Date | null = null;
      if (row["Created Date"]) {
        if (typeof row["Created Date"] === "number") {
          createdDate = new Date((row["Created Date"] - 25569) * 86400000);
        } else {
          createdDate = new Date(row["Created Date"]);
        }
      }
      let dueDate: Date | null = null;
      if (row["Due Date"]) {
        if (typeof row["Due Date"] === "number") {
          dueDate = new Date((row["Due Date"] - 25569) * 86400000);
        } else {
          dueDate = new Date(row["Due Date"]);
        }
      }

      const nameLC = name.toLowerCase();
      const exactMatch = dbNameMap.get(nameLC);
      let matchStatus = "unmatched";
      let procoreProjectId: string | null = null;

      if (exactMatch) {
        matchStatus = "matched";
        procoreProjectId = exactMatch;
        matched++;
      } else {
        for (const [dbName, dbId] of dbNameMap.entries()) {
          if (dbName.includes(nameLC) || nameLC.includes(dbName)) {
            matchStatus = "partial";
            procoreProjectId = dbId;
            matched++;
            break;
          }
        }
        if (matchStatus === "unmatched") unmatched++;
      }

      const oldStatus = oldStatusMap.get(nameLC);
      if (oldStatus && newStatus && oldStatus !== newStatus) {
        statusChanges.push({ name, oldStatus, newStatus });
      }

      await storage.upsertBidboardEstimate({
        name,
        estimator: (row.Estimator || "").trim() || null,
        office: (row.Office || "").trim() || null,
        status: newStatus || null,
        salesPricePerArea: (row["Sales Price Per Area"] || "").toString().trim() || null,
        projectCost: row["Project Cost"] != null ? String(row["Project Cost"]) : null,
        profitMargin: row["Profit Margin"] != null ? String(row["Profit Margin"]) : null,
        totalSales: row["Total Sales"] != null ? String(row["Total Sales"]) : null,
        createdDate,
        dueDate,
        customerName: (row["Customer Name"] || "").trim() || null,
        customerContact: (row["Customer Contact"] || "").trim() || null,
        projectNumber: row["Project #"] ? String(row["Project #"]).trim() : null,
        procoreProjectId,
        matchStatus,
      });
      imported++;
    }

    let hubspotSyncResult = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, details: [] as any[] };

    if (statusChanges.length > 0) {
      const mappingConfig = await storage.getAutomationConfig("bidboard_hubspot_stage_mapping");
      const mappingValue = mappingConfig?.value as { mappings?: Record<string, string>; enabled?: boolean } | undefined;

      if (mappingValue?.enabled && mappingValue.mappings && Object.keys(mappingValue.mappings).length > 0) {
        const changedNames = statusChanges.map(sc => sc.name);
        const matchingDeals = await storage.getHubspotDealsByDealNames(changedNames);
        const dealsByName = new Map<string, { hubspotId: string; dealName: string; dealStage: string | null }>();
        for (const d of matchingDeals) {
          if (d.dealName) {
            dealsByName.set(d.dealName.trim().toLowerCase(), {
              hubspotId: d.hubspotId,
              dealName: d.dealName,
              dealStage: d.dealStage,
            });
          }
        }

        for (const change of statusChanges) {
          const targetStageId = mappingValue.mappings[change.newStatus];
          if (!targetStageId) {
            hubspotSyncResult.skipped++;
            continue;
          }

          const deal = dealsByName.get(change.name.trim().toLowerCase());
          if (!deal) {
            hubspotSyncResult.skipped++;
            hubspotSyncResult.details.push({
              name: change.name,
              status: "skipped",
              reason: "No matching HubSpot deal",
            });
            continue;
          }

          if (deal.dealStage === targetStageId) {
            hubspotSyncResult.skipped++;
            continue;
          }

          hubspotSyncResult.attempted++;
          const result = await updateHubSpotDealStage(deal.hubspotId, targetStageId);
          if (result.success) {
            hubspotSyncResult.succeeded++;
            hubspotSyncResult.details.push({
              name: change.name,
              hubspotId: deal.hubspotId,
              status: "updated",
              oldBidBoardStatus: change.oldStatus,
              newBidBoardStatus: change.newStatus,
              newHubSpotStage: targetStageId,
            });
            await storage.createAuditLog({
              action: "hubspot_stage_sync",
              entityType: "deal",
              entityId: deal.hubspotId,
              source: "bidboard_import",
              status: "success",
              details: {
                dealName: deal.dealName,
                oldBidBoardStatus: change.oldStatus,
                newBidBoardStatus: change.newStatus,
                newHubSpotStageId: targetStageId,
              },
            });
          } else {
            hubspotSyncResult.failed++;
            hubspotSyncResult.details.push({
              name: change.name,
              hubspotId: deal.hubspotId,
              status: "failed",
              error: result.message,
            });
          }
        }
      }
    }

    await storage.createAuditLog({
      action: "bidboard_import",
      entityType: "bidboard",
      entityId: null,
      source: "upload",
      status: "success",
      details: {
        imported, matched, unmatched, totalRows: rows.length,
        statusChanges: statusChanges.length,
        hubspotSync: hubspotSyncResult,
      },
    });

    res.json({
      success: true, imported, matched, unmatched, totalRows: rows.length,
      statusChanges: statusChanges.length,
      hubspotSync: hubspotSyncResult,
    });
  }));

  app.post("/api/bidboard/import-url", requireAuth, asyncHandler(async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ message: "URL is required" });

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(400).json({ message: `Failed to download file: ${response.status} ${response.statusText}. The link may have expired — S3 links are only valid for about 3 minutes.` });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet) as any[];

    if (!rows.length) return res.status(400).json({ message: "Empty spreadsheet" });

    const oldEstimates = await storage.getBidboardEstimates({ limit: 10000, offset: 0 });
    const oldStatusMap = new Map<string, string>();
    for (const est of oldEstimates.data) {
      if (est.name && est.status) {
        oldStatusMap.set(est.name.trim().toLowerCase(), est.status);
      }
    }

    const dbProjectNames = await storage.getProcoreProjects({ limit: 10000, offset: 0 });
    const dbNameMap = new Map<string, string>();
    for (const p of dbProjectNames.data) {
      dbNameMap.set((p.name || "").trim().toLowerCase(), String(p.procoreId));
    }

    await storage.clearBidboardEstimates();

    let imported = 0, matched = 0, unmatched = 0;
    const statusChanges: { name: string; oldStatus: string; newStatus: string }[] = [];

    for (const row of rows) {
      const name = (row.Name || "").trim();
      if (!name) continue;

      const newStatus = (row.Status || "").trim();

      let createdDate: Date | null = null;
      if (row["Created Date"]) {
        if (typeof row["Created Date"] === "number") {
          createdDate = new Date((row["Created Date"] - 25569) * 86400000);
        } else {
          createdDate = new Date(row["Created Date"]);
        }
      }
      let dueDate: Date | null = null;
      if (row["Due Date"]) {
        if (typeof row["Due Date"] === "number") {
          dueDate = new Date((row["Due Date"] - 25569) * 86400000);
        } else {
          dueDate = new Date(row["Due Date"]);
        }
      }

      const nameLC = name.toLowerCase();
      const exactMatch = dbNameMap.get(nameLC);
      let matchStatus = "unmatched";
      let procoreProjectId: string | null = null;

      if (exactMatch) {
        matchStatus = "matched";
        procoreProjectId = exactMatch;
        matched++;
      } else {
        for (const [dbName, dbId] of dbNameMap.entries()) {
          if (dbName.includes(nameLC) || nameLC.includes(dbName)) {
            matchStatus = "partial";
            procoreProjectId = dbId;
            matched++;
            break;
          }
        }
        if (matchStatus === "unmatched") unmatched++;
      }

      const oldStatus = oldStatusMap.get(nameLC);
      if (oldStatus && newStatus && oldStatus !== newStatus) {
        statusChanges.push({ name, oldStatus, newStatus });
      }

      await storage.upsertBidboardEstimate({
        name,
        estimator: (row.Estimator || "").trim() || null,
        office: (row.Office || "").trim() || null,
        status: newStatus || null,
        salesPricePerArea: (row["Sales Price Per Area"] || "").toString().trim() || null,
        projectCost: row["Project Cost"] != null ? String(row["Project Cost"]) : null,
        profitMargin: row["Profit Margin"] != null ? String(row["Profit Margin"]) : null,
        totalSales: row["Total Sales"] != null ? String(row["Total Sales"]) : null,
        createdDate,
        dueDate,
        customerName: (row["Customer Name"] || "").trim() || null,
        customerContact: (row["Customer Contact"] || "").trim() || null,
        projectNumber: row["Project #"] ? String(row["Project #"]).trim() : null,
        procoreProjectId,
        matchStatus,
      });
      imported++;
    }

    let hubspotSyncResult = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, details: [] as any[] };

    if (statusChanges.length > 0) {
      const mappingConfig = await storage.getAutomationConfig("bidboard_hubspot_stage_mapping");
      const mappingValue = mappingConfig?.value as { mappings?: Record<string, string>; enabled?: boolean } | undefined;

      if (mappingValue?.enabled && mappingValue.mappings && Object.keys(mappingValue.mappings).length > 0) {
        const changedNames = statusChanges.map(sc => sc.name);
        const matchingDeals = await storage.getHubspotDealsByDealNames(changedNames);
        const dealsByName = new Map<string, { hubspotId: string; dealName: string; dealStage: string | null }>();
        for (const d of matchingDeals) {
          if (d.dealName) {
            dealsByName.set(d.dealName.trim().toLowerCase(), {
              hubspotId: d.hubspotId,
              dealName: d.dealName,
              dealStage: d.dealStage,
            });
          }
        }

        for (const change of statusChanges) {
          const targetStageId = mappingValue.mappings[change.newStatus];
          if (!targetStageId) {
            hubspotSyncResult.skipped++;
            continue;
          }

          const deal = dealsByName.get(change.name.trim().toLowerCase());
          if (!deal) {
            hubspotSyncResult.skipped++;
            hubspotSyncResult.details.push({
              name: change.name,
              status: "skipped",
              reason: "No matching HubSpot deal",
            });
            continue;
          }

          if (deal.dealStage === targetStageId) {
            hubspotSyncResult.skipped++;
            continue;
          }

          hubspotSyncResult.attempted++;
          const result = await updateHubSpotDealStage(deal.hubspotId, targetStageId);
          if (result.success) {
            hubspotSyncResult.succeeded++;
            hubspotSyncResult.details.push({
              name: change.name,
              hubspotId: deal.hubspotId,
              status: "updated",
              oldBidBoardStatus: change.oldStatus,
              newBidBoardStatus: change.newStatus,
              newHubSpotStage: targetStageId,
            });
            await storage.createAuditLog({
              action: "hubspot_stage_sync",
              entityType: "deal",
              entityId: deal.hubspotId,
              source: "bidboard_url_import",
              status: "success",
              details: {
                dealName: deal.dealName,
                oldBidBoardStatus: change.oldStatus,
                newBidBoardStatus: change.newStatus,
                newHubSpotStageId: targetStageId,
              },
            });
          } else {
            hubspotSyncResult.failed++;
            hubspotSyncResult.details.push({
              name: change.name,
              hubspotId: deal.hubspotId,
              status: "failed",
              error: result.message,
            });
          }
        }
      }
    }

    await storage.createAuditLog({
      action: "bidboard_import",
      entityType: "bidboard",
      entityId: null,
      source: "url_fetch",
      status: "success",
      details: {
        imported, matched, unmatched, totalRows: rows.length,
        statusChanges: statusChanges.length,
        hubspotSync: hubspotSyncResult,
      },
    });

    res.json({
      success: true, imported, matched, unmatched, totalRows: rows.length,
      statusChanges: statusChanges.length,
      hubspotSync: hubspotSyncResult,
    });
  }));

  app.get("/api/bidboard/estimates", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getBidboardEstimates({
      search: req.query.search as string,
      status: req.query.status as string,
      matchStatus: req.query.matchStatus as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/bidboard/count", requireAuth, asyncHandler(async (_req, res) => {
    const count = await storage.getBidboardEstimateCount();
    res.json({ count });
  }));

  // ── Stage mapping config ──────────────────────────────────────────────────

  app.get("/api/stage-mapping/config", requireAuth, asyncHandler(async (_req, res) => {
    const config = await storage.getAutomationConfig("bidboard_hubspot_stage_mapping");
    res.json(config?.value || { mappings: {}, enabled: false });
  }));

  app.post("/api/stage-mapping/config", requireAuth, asyncHandler(async (req, res) => {
    const { mappings, enabled } = req.body;
    await storage.upsertAutomationConfig({
      key: "bidboard_hubspot_stage_mapping",
      value: { mappings: mappings || {}, enabled: !!enabled },
      description: "Maps BidBoard estimate statuses to HubSpot deal stages",
      isActive: true,
    });
    res.json({ success: true });
  }));

  app.get("/api/stage-mapping/hubspot-stages", requireAuth, asyncHandler(async (_req, res) => {
    let pipelines = await storage.getHubspotPipelines();

    if (pipelines.length === 0) {
      try {
        const { syncHubSpotPipelines } = await import('../hubspot');
        pipelines = await syncHubSpotPipelines();
        console.log(`[stage-mapping] Synced ${pipelines.length} pipelines from HubSpot`);
      } catch (syncError: any) {
        console.log('[stage-mapping] Could not sync pipelines from HubSpot:', syncError.message);
      }
    }

    const stages: { stageId: string; label: string; pipelineLabel: string; pipelineId: string }[] = [];
    for (const p of pipelines) {
      const pStages = (p.stages as any[]) || [];
      for (const s of pStages) {
        stages.push({
          stageId: s.stageId,
          label: s.label,
          pipelineLabel: p.label,
          pipelineId: p.hubspotId,
        });
      }
    }
    res.json(stages);
  }));

  app.post("/api/stage-mapping/refresh-hubspot-pipelines", requireAuth, asyncHandler(async (_req, res) => {
    console.log('[refresh-pipelines] Starting pipeline refresh...');
    const { syncHubSpotPipelines } = await import('../hubspot');
    const pipelines = await syncHubSpotPipelines();

    const stages: { stageId: string; label: string; pipelineLabel: string; pipelineId: string }[] = [];
    for (const p of pipelines) {
      const pStages = (p.stages as any[]) || [];
      for (const s of pStages) {
        stages.push({
          stageId: s.stageId,
          label: s.label,
          pipelineLabel: p.label,
          pipelineId: p.hubspotId,
        });
      }
    }

    console.log('[refresh-pipelines] Complete:', pipelines.length, 'pipelines,', stages.length, 'stages');

    res.json({
      success: true,
      message: `Synced ${pipelines.length} pipelines with ${stages.length} stages`,
      pipelines: pipelines.length,
      stages,
    });
  }));

  app.get("/api/stage-mapping/bidboard-statuses", requireAuth, asyncHandler(async (_req, res) => {
    const result = await storage.getBidboardDistinctStatuses();
    res.json(result);
  }));

  // ── BidBoard Playwright Automation ────────────────────────────────────────

  app.get("/api/bidboard/status", requireAuth, asyncHandler(async (_req, res) => {
    const status = await getAutomationStatus();
    res.json({
      ...status,
      isPolling: bidboardPollingTimer !== null,
      lastPollAt: lastBidboardPollAt?.toISOString() || null,
      lastPollResult: lastBidboardPollResult,
      currentlyPolling: bidboardPollingRunning,
    });
  }));

  app.get("/api/bidboard/config", requireAuth, asyncHandler(async (_req, res) => {
    const automationConfig = await storage.getAutomationConfig("bidboard_automation");
    const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");

    res.json({
      enabled: (automationConfig?.value as any)?.enabled || false,
      pollingIntervalMinutes: (automationConfig?.value as any)?.pollingIntervalMinutes || 60,
      hasCredentials: !!credentialsConfig?.value,
      sandbox: (credentialsConfig?.value as any)?.sandbox || false,
      email: (credentialsConfig?.value as any)?.email || null,
    });
  }));

  app.post("/api/bidboard/config", requireAuth, asyncHandler(async (req, res) => {
    const { enabled, pollingIntervalMinutes } = req.body;
    const interval = pollingIntervalMinutes || 60;

    await storage.upsertAutomationConfig({
      key: "bidboard_automation",
      value: { enabled, pollingIntervalMinutes: interval },
      description: "BidBoard Playwright automation configuration",
    });

    await enableBidBoardAutomation(enabled);

    if (enabled) {
      startBidboardPolling(interval);
    } else {
      stopBidboardPolling();
    }

    res.json({ success: true, enabled, pollingIntervalMinutes: interval });
  }));

  app.post("/api/bidboard/test-credentials", requireAuth, asyncHandler(async (req, res) => {
    const { email, password, sandbox } = req.body;
    const result = await testProcoreLogin(email, password, sandbox);
    res.json(result);
  }));

  app.post("/api/bidboard/credentials", requireAuth, asyncHandler(async (req, res) => {
    const { email, password, sandbox } = req.body;
    await saveProcoreCredentials(email, password, sandbox);
    res.json({ success: true });
  }));

  app.post("/api/bidboard/poll", requireAuth, asyncHandler(async (_req, res) => {
    if (bidboardPollingRunning) {
      return res.json({ message: "BidBoard polling already in progress", running: true });
    }
    runBidboardPollingCycle();
    res.json({ message: "BidBoard polling triggered", running: true });
  }));

  // ── Stage sync ────────────────────────────────────────────────────────────

  app.get("/api/bidboard/stage-sync/config", requireAuth, asyncHandler(async (_req, res) => {
    const config = await storage.getAutomationConfig("bidboard_stage_sync");
    const val = (config?.value as any) || {};
    res.json({
      enabled: val.enabled || false,
      intervalMinutes: val.intervalMinutes || 15,
      dryRun: val.dryRun !== false,
      isRunning: bidboardStageSyncTimer !== null,
      lastSyncAt: lastBidboardStageSyncAt?.toISOString() || null,
      currentlySyncing: bidboardStageSyncRunning,
    });
  }));

  app.post("/api/bidboard/stage-sync/config", requireAuth, asyncHandler(async (req, res) => {
    const { enabled, intervalMinutes, dryRun } = req.body;
    const interval = Math.min(60, Math.max(5, parseInt(String(intervalMinutes)) || 15));
    const config = await storage.getAutomationConfig("bidboard_stage_sync");
    const val = (config?.value as any) || {};
    const nextDryRun = dryRun !== undefined ? dryRun !== false : (val.dryRun !== false);
    await storage.upsertAutomationConfig({
      key: "bidboard_stage_sync",
      value: { enabled: !!enabled, intervalMinutes: interval, dryRun: nextDryRun },
      description: "BidBoard Excel → HubSpot stage sync schedule",
    });
    if (enabled) {
      bidboardStageSyncTimer = setInterval(runBidBoardStageSyncCycle, interval * 60 * 1000);
      setTimeout(runBidBoardStageSyncCycle, 10000);
    } else {
      if (bidboardStageSyncTimer) {
        clearInterval(bidboardStageSyncTimer);
        bidboardStageSyncTimer = null;
      }
    }
    res.json({ success: true });
  }));

  app.get("/api/bidboard/stage-sync/history", requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
    try {
      const runs = await storage.getBidboardStageSyncRuns(limit);
      res.json(runs);
    } catch (e: any) {
      if (e?.code === "42P01" || e?.message?.includes("does not exist") || e?.message?.includes("relation")) {
        res.json([]);
        return;
      }
      throw e;
    }
  }));

  app.post("/api/bidboard/stage-sync/trigger", requireAuth, asyncHandler(async (_req, res) => {
    if (bidboardStageSyncRunning) {
      return res.json({ message: "Stage sync already in progress", running: true });
    }
    runBidBoardStageSyncCycle();
    res.json({ message: "Stage sync triggered", running: true });
  }));

  app.post("/api/bidboard/stage-sync/reset-baseline", requireAuth, asyncHandler(async (_req, res) => {
    const deleted = await storage.deleteAllBidboardStageSyncRuns();
    console.log(`[BidBoardStageSync] Reset baseline: deleted ${deleted} sync run(s)`);
    res.json({ success: true, deleted, message: `Cleared ${deleted} sync run(s). Next trigger will re-initialize baseline.` });
  }));

  app.post("/api/bidboard/stage-sync", requireAuth, asyncHandler(async (req, res) => {
    const { dryRun, forceExport, initialize } = req.body || {};
    const result = await runBidBoardStageSync({
      dryRun: dryRun === undefined ? true : !!dryRun,
      forceExport: typeof forceExport === "string" ? forceExport : undefined,
      initialize: !!initialize,
    });
    const usedDryRun = dryRun === undefined ? true : !!dryRun;
    if (!initialize) {
      const runStatus = usedDryRun ? "dry_run" : (result.failed > 0 ? (result.changed > 0 ? "partial" : "failed") : "success");
      await safeCreateBidboardStageSyncRun({
        status: runStatus,
        totalChanges: result.total,
        syncedCount: result.changed,
        failedCount: result.failed,
        changes: result.changes,
        errors: result.errors,
        exportPath: result.exportPath,
      });
    }
    res.json(result);
  }));

  // ── Projects & logs ───────────────────────────────────────────────────────

  app.get("/api/bidboard/projects", requireAuth, asyncHandler(async (_req, res) => {
    const states = await storage.getBidboardSyncStates();
    res.json(states);
  }));

  app.get("/api/bidboard/logs", requireAuth, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = await storage.getBidboardAutomationLogs(limit);
    res.json(logs);
  }));

  app.post("/api/bidboard/sync-project/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const result = await manualSyncProject(projectId);
    res.json(result || { success: false, error: "Project not found" });
  }));

  app.post("/api/bidboard/push-client-data", requireAuth, asyncHandler(async (req, res) => {
    const { projectId, hubspotDealId } = req.body;
    const result = await syncHubSpotClientToBidBoard(projectId, hubspotDealId);
    res.json(result);
  }));

  app.post("/api/bidboard/setup-new-project", requireAuth, asyncHandler(async (req, res) => {
    const { projectId, hubspotDealId, syncClientData, syncAttachments } = req.body;
    const result = await onBidBoardProjectCreated(projectId, hubspotDealId, {
      syncClientData,
      syncAttachments,
    });
    res.json(result);
  }));

  app.post("/api/bidboard/detect-new-projects", requireAuth, asyncHandler(async (_req, res) => {
    const result = await detectAndProcessNewProjects();
    res.json(result);
  }));

  app.post("/api/bidboard/create-from-deal", requireAuth, asyncHandler(async (req, res) => {
    const { dealId, stage } = req.body;
    if (!dealId) {
      return res.status(400).json({ error: "dealId is required" });
    }
    const { triggerBidBoardCreationForDeal } = await import("../hubspot-bidboard-trigger");
    const result = await triggerBidBoardCreationForDeal(dealId, stage || "Estimate in Progress");
    res.json(result);
  }));

  // ── Auto-create config ────────────────────────────────────────────────────

  app.get("/api/bidboard/auto-create-config", requireAuth, asyncHandler(async (_req, res) => {
    const enabledConfig = await storage.getAutomationConfig("hubspot_bidboard_auto_create");
    const stagesConfig = await storage.getAutomationConfig("hubspot_bidboard_trigger_stages");

    res.json({
      enabled: (enabledConfig?.value as any)?.enabled || false,
      triggerStages: (stagesConfig?.value as any)?.stages || [
        { hubspotStageId: "rfp", hubspotStageLabel: "RFP", bidboardStage: "Estimate in Progress" },
        { hubspotStageId: "service_rfp", hubspotStageLabel: "Service RFP", bidboardStage: "Service – Estimating" },
      ],
    });
  }));

  app.post("/api/bidboard/auto-create-config", requireAuth, asyncHandler(async (req, res) => {
    const { enabled, triggerStages } = req.body;

    if (typeof enabled === "boolean") {
      await storage.upsertAutomationConfig({
        key: "hubspot_bidboard_auto_create",
        value: { enabled },
        description: "HubSpot BidBoard auto-create configuration",
      });
    }

    if (Array.isArray(triggerStages)) {
      await storage.upsertAutomationConfig({
        key: "hubspot_bidboard_trigger_stages",
        value: { stages: triggerStages },
        description: "HubSpot BidBoard trigger stages",
      });
    }

    res.json({ success: true });
  }));

  // ── Export sync ───────────────────────────────────────────────────────────

  app.post("/api/bidboard/export-sync", requireAuth, asyncHandler(async (_req, res) => {
    const { runBidBoardExportSync } = await import('../playwright/bidboard');
    const result = await runBidBoardExportSync();

    await storage.createAuditLog({
      action: "bidboard_export_sync",
      entityType: "bidboard",
      source: "playwright",
      status: result.errors.length > 0 ? "partial" : "success",
      details: {
        projectCount: result.projects.length,
        changeCount: result.changes.length,
        errors: result.errors,
      },
    });

    res.json({
      success: result.errors.length === 0,
      projects: result.projects.length,
      changes: result.changes,
      errors: result.errors,
    });
  }));

  app.post("/api/bidboard/send-to-portfolio/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const { importToBudget, createPrimeContract, sendKickoffEmail, addClientToDirectory, clientData } = req.body;

    if (importToBudget || createPrimeContract || sendKickoffEmail || addClientToDirectory) {
      const result = await runFullPortfolioWorkflow(projectId, {
        importToBudget,
        createPrimeContract,
        sendKickoffEmail,
        addClientToDirectory,
        clientData,
      });
      res.json(result);
    } else {
      const result = await runPortfolioTransition(projectId);
      res.json(result);
    }
  }));

  app.post("/api/bidboard/sync-documents/hubspot-to-bidboard", requireAuth, asyncHandler(async (req, res) => {
    const { projectId, hubspotDealId } = req.body;
    const result = await syncHubSpotAttachmentsToBidBoard(projectId, hubspotDealId);
    res.json(result);
  }));

  app.post("/api/bidboard/sync-documents/bidboard-to-portfolio", requireAuth, asyncHandler(async (req, res) => {
    const { bidboardProjectId, portfolioProjectId } = req.body;
    const result = await syncBidBoardDocumentsToPortfolio(bidboardProjectId, portfolioProjectId);
    res.json(result);
  }));

  app.post("/api/bidboard/logout", requireAuth, asyncHandler(async (_req, res) => {
    await logoutProcore();
    res.json({ success: true });
  }));

  app.post("/api/bidboard/close-browser", requireAuth, asyncHandler(async (_req, res) => {
    await closeBrowser();
    res.json({ success: true });
  }));

  // ── Deal linking ──────────────────────────────────────────────────────────

  app.post("/api/bidboard/link-deal", requireAuth, asyncHandler(async (req, res) => {
    const { hubspotDealId, bidboardProjectId, bidboardProjectName, hubspotDealName } = req.body;

    if (!hubspotDealId || !bidboardProjectId) {
      return res.status(400).json({ message: "hubspotDealId and bidboardProjectId are required" });
    }

    let mapping = await storage.getSyncMappingByHubspotDealId(hubspotDealId);

    if (mapping) {
      const updated = await storage.updateSyncMapping(mapping.id, {
        bidboardProjectId,
        bidboardProjectName: bidboardProjectName || mapping.bidboardProjectName,
        procoreProjectId: bidboardProjectId,
        procoreProjectName: bidboardProjectName || mapping.procoreProjectName,
        projectPhase: 'bidboard',
        lastSyncAt: new Date(),
      });

      await storage.createAuditLog({
        action: "bidboard_deal_linked",
        entityType: "sync_mapping",
        entityId: String(mapping.id),
        source: "api",
        status: "success",
        details: { hubspotDealId, bidboardProjectId, action: "updated" },
      });

      return res.json({ success: true, mapping: updated, action: "updated" });
    }

    const newMapping = await storage.createSyncMapping({
      hubspotDealId,
      hubspotDealName,
      bidboardProjectId,
      bidboardProjectName,
      procoreProjectId: bidboardProjectId,
      procoreProjectName: bidboardProjectName,
      projectPhase: 'bidboard',
      lastSyncAt: new Date(),
      lastSyncStatus: 'linked',
    });

    await storage.createAuditLog({
      action: "bidboard_deal_linked",
      entityType: "sync_mapping",
      entityId: String(newMapping.id),
      source: "api",
      status: "success",
      details: { hubspotDealId, bidboardProjectId, action: "created" },
    });

    res.json({ success: true, mapping: newMapping, action: "created" });
  }));

  app.post("/api/bidboard/transition-to-portfolio", requireAuth, asyncHandler(async (req, res) => {
    let { bidboardProjectId, portfolioProjectId, portfolioProjectName } = req.body;

    if (!bidboardProjectId || !portfolioProjectId) {
      return res.status(400).json({ message: "bidboardProjectId and portfolioProjectId are required" });
    }

    if (!portfolioProjectName) {
      try {
        const { fetchProcoreProjectDetail } = await import("../procore");
        const detail = await fetchProcoreProjectDetail(portfolioProjectId);
        portfolioProjectName = detail?.name || detail?.display_name || null;
      } catch (e: any) {
        console.warn(`[transition] Could not fetch Portfolio project name for ${portfolioProjectId}:`, e.message);
      }
    }

    const mapping = await storage.transitionToPortfolio(bidboardProjectId, portfolioProjectId, portfolioProjectName);

    if (!mapping) {
      return res.status(404).json({ message: "No mapping found for BidBoard project" });
    }

    await storage.createAuditLog({
      action: "portfolio_transition",
      entityType: "sync_mapping",
      entityId: String(mapping.id),
      source: "api",
      status: "success",
      details: { bidboardProjectId, portfolioProjectId, hubspotDealId: mapping.hubspotDealId },
    });

    res.json({ success: true, mapping });
  }));

  // ── Project phase ─────────────────────────────────────────────────────────

  app.get("/api/deals/:dealId/project-phase", requireAuth, asyncHandler(async (req, res) => {
    const { dealId } = req.params;
    const mapping = await storage.getSyncMappingByHubspotDealId(dealId);

    if (!mapping) {
      return res.json({
        phase: null,
        message: "No project linked to this deal",
      });
    }

    res.json({
      phase: mapping.projectPhase || 'unknown',
      bidboardProjectId: mapping.bidboardProjectId,
      bidboardProjectName: mapping.bidboardProjectName,
      portfolioProjectId: mapping.portfolioProjectId,
      portfolioProjectName: mapping.portfolioProjectName,
      sentToPortfolioAt: mapping.sentToPortfolioAt,
      procoreProjectId: mapping.procoreProjectId,
      procoreProjectName: mapping.procoreProjectName,
    });
  }));

  // ── Startup init (called by registerRoutes after setup) ───────────────────

  return {
    initPolling: async () => {
      try {
        const config = await storage.getAutomationConfig("bidboard_automation");
        const val = (config?.value as any);
        if (val?.enabled) {
          startBidboardPolling(val.pollingIntervalMinutes || 60);
        }
      } catch {
        console.log('[BidBoardPolling] No saved config, BidBoard polling disabled by default');
      }

      try {
        const config = await storage.getAutomationConfig("bidboard_stage_sync");
        const val = (config?.value as any);
        if (val?.enabled) {
          const interval = Math.min(60, Math.max(5, val.intervalMinutes || 15));
          bidboardStageSyncTimer = setInterval(runBidBoardStageSyncCycle, interval * 60 * 1000);
          setTimeout(runBidBoardStageSyncCycle, 15000);
          console.log(`[BidBoardStageSync] Scheduled every ${interval} minutes`);
        }
      } catch {
        console.log('[BidBoardStageSync] No saved config, stage sync disabled by default');
      }

      // Orphan Phase 2 failsafe — picks up pending jobs that weren't direct-chained
      setInterval(async () => {
        try {
          const { processOrphanedPhase2Jobs } = await import("../orchestrator/portfolio-orchestrator");
          await processOrphanedPhase2Jobs();
        } catch (err: any) {
          console.error(`[OrphanFailsafe] Error: ${err.message}`);
        }
      }, 5 * 60 * 1000); // Every 5 minutes
      console.log(`[OrphanFailsafe] Scheduled every 5 minutes`);
    },
  };
}
