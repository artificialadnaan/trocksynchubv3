import type { Express } from "express";
import { storage } from "../storage";
import { syncProcoreRoleAssignments, syncProcoreRoleAssignmentsBatch, runFullProcoreSync } from "../procore";
import { runFullHubSpotSync } from "../hubspot";
import { triggerPostSyncProcoreUpdates } from "../hubspot-procore-sync";
import { processNewDealWebhook } from "../deal-project-number";
import { runBidBoardPolling, getAutomationStatus, enableBidBoardAutomation } from "../bidboard-automation";
import { runBidBoardStageSync } from "../sync";

// ─── HubSpot polling state ────────────────────────────────────────────────────
let pollingTimer: ReturnType<typeof setInterval> | null = null;
let pollingRunning = false;
let lastPollAt: Date | null = null;
let lastPollResult: any = null;

// ─── Procore polling state ────────────────────────────────────────────────────
let procorePollingTimer: ReturnType<typeof setInterval> | null = null;
let procorePollingRunning = false;
let lastProcorePollAt: Date | null = null;
let lastProcorePollResult: any = null;
let lastRolePollAt: Date | null = null;
let lastRolePollResult: any = null;

// ─── Role polling state ───────────────────────────────────────────────────────
let rolePollingTimer: ReturnType<typeof setInterval> | null = null;
let rolePollingRunning = false;
let lastPollStartedAt: number | null = null;
const ROLE_SYNC_TIMEOUT_MS = 5 * 60 * 1000;
let rolePollingBatchCursor = 0;
let ROLE_POLLING_BATCH_SIZE = 50;

// ─── BidBoard polling state ───────────────────────────────────────────────────
let bidboardPollingTimer: ReturnType<typeof setInterval> | null = null;
let lastBidboardPollAt: Date | null = null;
let lastBidboardPollResult: any = null;
let bidboardPollingRunning = false;

// ─── BidBoard stage sync state ────────────────────────────────────────────────
let bidboardStageSyncTimer: ReturnType<typeof setInterval> | null = null;
let bidboardStageSyncRunning = false;
let lastBidboardStageSyncAt: Date | null = null;

// ─── Change order polling state ──────────────────────────────────────────────
let changeOrderPollingTimer: ReturnType<typeof setInterval> | null = null;
let changeOrderPollingRunning = false;
let lastChangeOrderPollAt: Date | null = null;
let lastChangeOrderPollResult: any = null;

// ─── Webhook role event tracking (used by webhooks.ts) ───────────────────────
let lastWebhookRoleEventAt: Date | null = null;

export function recordWebhookRoleEvent() {
  lastWebhookRoleEventAt = new Date();
}

// ─── HubSpot polling cycle ────────────────────────────────────────────────────
async function runPollingCycle() {
  if (pollingRunning) {
    console.log('[Polling] Skipping — previous cycle still running');
    return;
  }
  pollingRunning = true;
  console.log('[Polling] Starting HubSpot sync cycle...');
  try {
    const result = await runFullHubSpotSync();
    let procoreAutoSync = null;
    try {
      procoreAutoSync = await triggerPostSyncProcoreUpdates({
        companies: result.companies,
        contacts: result.contacts,
      });
    } catch (autoErr: any) {
      console.error('[Polling] Procore auto-sync failed:', autoErr.message);
      procoreAutoSync = { error: autoErr.message };
    }

    let projectNumberResults: any[] = [];
    if (result.deals.newDealIds && result.deals.newDealIds.length > 0) {
      console.log(`[Polling] ${result.deals.newDealIds.length} new deal(s) detected, assigning project numbers...`);
      for (const dealId of result.deals.newDealIds) {
        try {
          const pnResult = await processNewDealWebhook(dealId);
          projectNumberResults.push({ dealId, result: pnResult });
        } catch (pnErr: any) {
          console.error(`[Polling] Project number assignment failed for deal ${dealId}:`, pnErr.message);
          projectNumberResults.push({ dealId, error: pnErr.message });
        }
      }
    }

    lastPollAt = new Date();
    lastPollResult = {
      companies: result.companies,
      contacts: result.contacts,
      deals: result.deals,
      procoreAutoSync,
      projectNumberResults: projectNumberResults.length > 0 ? projectNumberResults : undefined,
      duration: result.duration,
    };

    const hasChanges = result.companies.created > 0 || result.companies.updated > 0 ||
      result.contacts.created > 0 || result.contacts.updated > 0;

    if (hasChanges) {
      await storage.createAuditLog({
        action: 'hubspot_polling_sync',
        entityType: 'all',
        source: 'polling',
        status: 'success',
        details: lastPollResult as any,
        durationMs: result.duration,
      });
    }

    console.log(`[Polling] Complete in ${(result.duration / 1000).toFixed(1)}s — Companies: ${result.companies.created} new, ${result.companies.updated} updated | Contacts: ${result.contacts.created} new, ${result.contacts.updated} updated`);
  } catch (e: any) {
    const isAuthError = e.message?.includes('expired') || e.message?.includes('401') || e.message?.includes('Unauthorized') || e.message?.includes('EXPIRED_AUTHENTICATION');
    if (isAuthError) {
      console.error('[Polling] HubSpot auth failed (token expired or invalid) — disabling polling. Please reconnect HubSpot.');
      stopPolling();
      try {
        await storage.upsertAutomationConfig({
          key: "hubspot_polling",
          value: { enabled: false, intervalMinutes: 10, disabledReason: 'auth_expired', disabledAt: new Date().toISOString() },
          description: "Automatic HubSpot polling sync configuration",
        });
      } catch (err) {
        console.warn('[Polling] Failed to disable HubSpot polling config on auth expiry:', err);
      }
    }
    console.error('[Polling] HubSpot sync failed:', e.message);
    lastPollAt = new Date();
    lastPollResult = { error: e.message };
  } finally {
    pollingRunning = false;
  }
}

function startPolling(intervalMinutes: number) {
  stopPolling();
  console.log(`[Polling] Starting automatic HubSpot sync every ${intervalMinutes} minutes`);
  pollingTimer = setInterval(() => runPollingCycle(), intervalMinutes * 60 * 1000);
  setTimeout(() => runPollingCycle(), 5000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[Polling] Stopped automatic HubSpot sync');
  }
}

// ─── Procore polling cycle ────────────────────────────────────────────────────
async function runProcorePollingCycle() {
  if (procorePollingRunning) {
    console.log('[ProcorePolling] Skipping — previous cycle still running');
    return;
  }
  procorePollingRunning = true;
  const startTime = Date.now();
  console.log('[ProcorePolling] Starting Procore data sync cycle...');
  try {
    const result = await runFullProcoreSync();
    const duration = Date.now() - startTime;
    lastProcorePollAt = new Date();
    lastProcorePollResult = { ...result, duration };
    lastRolePollAt = new Date();
    lastRolePollResult = { synced: result.roleAssignments.synced, newAssignments: result.roleAssignments.newAssignments, emails: { sent: 0, skipped: 0, failed: 0 }, duration: 0 };

    const hasChanges = result.projects.created > 0 || result.projects.updated > 0 ||
      result.vendors.created > 0 || result.vendors.updated > 0 ||
      result.users.created > 0 || result.users.updated > 0;

    if (hasChanges) {
      await storage.createAuditLog({
        action: 'procore_polling_sync',
        entityType: 'all',
        source: 'polling',
        status: 'success',
        details: lastProcorePollResult as any,
        durationMs: duration,
      });
    }

    console.log(`[ProcorePolling] Complete in ${(duration / 1000).toFixed(1)}s — Projects: ${result.projects.created} new, ${result.projects.updated} updated | Vendors: ${result.vendors.created} new, ${result.vendors.updated} updated | Users: ${result.users.created} new, ${result.users.updated} updated`);
  } catch (e: any) {
    const isAuthError = e.message?.includes('expired') || e.message?.includes('401') || e.message?.includes('Unauthorized');
    if (isAuthError) {
      console.error('[ProcorePolling] Procore auth failed — disabling polling. Please re-authenticate Procore.');
      stopProcorePolling();
      try {
        await storage.upsertAutomationConfig({
          key: "procore_polling",
          value: { enabled: false, intervalMinutes: 15, disabledReason: 'auth_expired', disabledAt: new Date().toISOString() },
          description: "Automatic Procore data polling sync configuration",
        });
      } catch (err) {
        console.warn('[ProcorePolling] Failed to disable Procore polling config on auth expiry:', err);
      }
    }
    console.error('[ProcorePolling] Procore sync failed:', e.message);
    lastProcorePollAt = new Date();
    lastProcorePollResult = { error: e.message };
  } finally {
    procorePollingRunning = false;
  }
}

function startProcorePolling(intervalMinutes: number) {
  stopProcorePolling();
  console.log(`[ProcorePolling] Starting automatic Procore sync every ${intervalMinutes} minutes`);
  procorePollingTimer = setInterval(() => runProcorePollingCycle(), intervalMinutes * 60 * 1000);
  setTimeout(() => runProcorePollingCycle(), 15000);
}

function stopProcorePolling() {
  if (procorePollingTimer) {
    clearInterval(procorePollingTimer);
    procorePollingTimer = null;
    console.log('[ProcorePolling] Stopped automatic Procore sync');
  }
}

// ─── Role polling cycle ───────────────────────────────────────────────────────
async function runRolePollingCycle(opts?: { fullSync?: boolean }) {
  // Stale lock cleanup: if stuck longer than timeout, force-clear
  if (rolePollingRunning && lastPollStartedAt) {
    const staleLockMs = Date.now() - lastPollStartedAt;
    if (staleLockMs > ROLE_SYNC_TIMEOUT_MS) {
      console.warn(`[RolePolling] Clearing stale lock (stuck for ${Math.round(staleLockMs / 1000)}s)`);
      rolePollingRunning = false;
    }
  }
  if (rolePollingRunning) {
    console.log('[RolePolling] Skipping — previous cycle still running');
    return;
  }
  rolePollingRunning = true;
  lastPollStartedAt = Date.now();
  const startTime = Date.now();
  const fullSync = opts?.fullSync ?? false;
  try {
    const result = fullSync
      ? await Promise.race([
          syncProcoreRoleAssignments(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Role sync timed out after 5 minutes')), ROLE_SYNC_TIMEOUT_MS)
          ),
        ])
      : await Promise.race([
          syncProcoreRoleAssignmentsBatch(ROLE_POLLING_BATCH_SIZE, rolePollingBatchCursor),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Role sync timed out after 5 minutes')), ROLE_SYNC_TIMEOUT_MS)
          ),
        ]);

    if (result.skipped) {
      console.log('[RolePolling] Skipped — Procore sync in progress, keeping previous result');
      return;
    }

    if (!fullSync && 'nextCursor' in result) {
      rolePollingBatchCursor = result.nextCursor;
      if (result.nextCursor === 0) {
        console.log('[RolePolling] Full sweep rotation complete');
      }
    }

    let emailResult = { sent: 0, skipped: 0, failed: 0 };
    if (result.newAssignments.length > 0) {
      try {
        const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('../email-notifications');
        emailResult = await sendRoleAssignmentEmails(result.newAssignments);
        await triggerKickoffForNewPmOnPortfolio(result.newAssignments);
      } catch (emailErr: any) {
        console.error('[RolePolling] Email notifications failed:', emailErr.message);
      }
    }
    const duration = Date.now() - startTime;
    lastRolePollAt = new Date();
    lastRolePollResult = {
      synced: result.synced,
      newAssignments: result.newAssignments.length,
      emails: emailResult,
      duration,
      ...(fullSync
        ? {}
        : 'batchProcessed' in result && 'totalProjects' in result && 'nextCursor' in result
          ? {
              batchProcessed: result.batchProcessed,
              totalProjects: result.totalProjects,
              nextCursor: result.nextCursor,
              fullRotationComplete: result.nextCursor === 0,
            }
          : {}),
    };
    if (result.newAssignments.length > 0) {
      await storage.createAuditLog({
        action: 'role_assignment_polling_sync',
        entityType: 'project_role_assignment',
        source: 'polling',
        status: 'success',
        details: lastRolePollResult as any,
        durationMs: duration,
      });
      const batchInfo = !fullSync && 'batchProcessed' in result ? ` batch ${result.batchProcessed} projects` : '';
      console.log(`[RolePolling] Complete in ${(duration / 1000).toFixed(1)}s${batchInfo} — ${result.newAssignments.length} new assignments, ${emailResult.sent} emails sent`);
    } else {
      const batchInfo = !fullSync && 'batchProcessed' in result && 'totalProjects' in result
        ? ` — batch ${result.batchProcessed} of ${result.totalProjects}`
        : '';
      console.log(`[RolePolling] Complete in ${(duration / 1000).toFixed(1)}s${batchInfo} — no new assignments`);
    }
  } catch (e: any) {
    console.error('[RolePolling] Role assignment sync failed:', e.message);
    lastRolePollAt = new Date();
    lastRolePollResult = { error: e.message };
  } finally {
    rolePollingRunning = false;
    lastPollStartedAt = null;
  }
}

function startRolePolling(intervalMinutes: number) {
  stopRolePolling();
  console.log(`[RolePolling] Starting automatic role assignment sync every ${intervalMinutes} minutes`);
  rolePollingTimer = setInterval(() => runRolePollingCycle(), intervalMinutes * 60 * 1000);
}

function stopRolePolling() {
  if (rolePollingTimer) {
    clearInterval(rolePollingTimer);
    rolePollingTimer = null;
    console.log('[RolePolling] Stopped automatic role assignment sync');
  }
}

// ─── BidBoard polling cycle ───────────────────────────────────────────────────
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

// ─── BidBoard stage sync cycle ────────────────────────────────────────────────
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
    const result = await runBidBoardStageSync({ dryRun });
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

// ─── Change order polling cycle ──────────────────────────────────────────────
async function runChangeOrderPollingCycle() {
  if (changeOrderPollingRunning) {
    console.log('[ChangeOrderPolling] Skipping — previous cycle still running');
    return;
  }
  changeOrderPollingRunning = true;
  console.log('[ChangeOrderPolling] Starting change order sync cycle...');
  try {
    const { syncAllProjectChangeOrders } = await import('../change-order-sync');
    const result = await syncAllProjectChangeOrders();
    lastChangeOrderPollAt = new Date();
    lastChangeOrderPollResult = result;
    console.log(`[ChangeOrderPolling] Complete: ${result.projectsChecked} checked, ${result.projectsUpdated} updated, ${result.errors.length} errors`);
  } catch (e: any) {
    console.error('[ChangeOrderPolling] Error:', e.message);
    lastChangeOrderPollResult = { error: e.message };
  } finally {
    changeOrderPollingRunning = false;
  }
}

function startChangeOrderPolling(intervalMinutes: number) {
  if (changeOrderPollingTimer) clearInterval(changeOrderPollingTimer);
  changeOrderPollingTimer = setInterval(() => runChangeOrderPollingCycle(), intervalMinutes * 60 * 1000);
  setTimeout(runChangeOrderPollingCycle, 30000); // first run 30s after startup
  console.log(`[ChangeOrderPolling] Scheduled every ${intervalMinutes} minutes`);
}

// ─── Startup: read persisted config and start pollers that were enabled ───────
export async function initPolling() {
  // HubSpot polling
  try {
    const config = await storage.getAutomationConfig("hubspot_polling");
    const val = (config?.value as any);
    if (val?.enabled) {
      startPolling(val.intervalMinutes || 10);
    }
  } catch (e) {
    console.log('[Polling] No saved config, polling disabled by default');
  }

  // Procore polling
  try {
    const config = await storage.getAutomationConfig("procore_polling");
    const val = (config?.value as any);
    if (val?.enabled) {
      startProcorePolling(val.intervalMinutes || 15);
    }
  } catch (e) {
    console.log('[ProcorePolling] No saved config, Procore polling disabled by default');
  }

  // Role polling
  try {
    const config = await storage.getAutomationConfig("role_assignment_polling");
    const val = (config?.value as any);
    if (val?.enabled) {
      if (val.batchSize != null) {
        ROLE_POLLING_BATCH_SIZE = Math.max(10, Math.min(200, Number(val.batchSize) || 50));
      }
      startRolePolling(val.intervalMinutes ?? 30);
    }
  } catch (e) {
    console.log('[RolePolling] No saved config, role polling disabled by default');
  }

  // BidBoard polling
  try {
    const config = await storage.getAutomationConfig("bidboard_automation");
    const val = (config?.value as any);
    if (val?.enabled) {
      startBidboardPolling(val.pollingIntervalMinutes || 60);
    }
  } catch (e) {
    console.log('[BidBoardPolling] No saved config, BidBoard polling disabled by default');
  }

  // BidBoard stage sync
  try {
    const config = await storage.getAutomationConfig("bidboard_stage_sync");
    const val = (config?.value as any);
    if (val?.enabled) {
      const interval = Math.min(60, Math.max(5, val.intervalMinutes || 15));
      bidboardStageSyncTimer = setInterval(runBidBoardStageSyncCycle, interval * 60 * 1000);
      setTimeout(runBidBoardStageSyncCycle, 15000);
      console.log(`[BidBoardStageSync] Scheduled every ${interval} minutes`);
    }
  } catch (e) {
    console.log('[BidBoardStageSync] No saved config, stage sync disabled by default');
  }

  // Change order polling
  try {
    const config = await storage.getAutomationConfig("sync_change_orders");
    const val = (config?.value as any);
    if (val?.enabled) {
      const interval = Math.min(60, Math.max(5, val.intervalMinutes || 15));
      startChangeOrderPolling(interval);
    }
  } catch (e) {
    console.log('[ChangeOrderPolling] No saved config, change order polling disabled by default');
  }
}

// ─── Route registration ───────────────────────────────────────────────────────
export function registerSettingsRoutes(app: Express, requireAuth: any) {
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), version: "2.0.0" });
  });

  // ── Automation dry-run status overview ─────────────────────────────────────
  app.get("/api/automation/status", requireAuth, async (_req, res) => {
    try {
      const configs = await storage.getAutomationConfigs();
      const configMap: Record<string, any> = {};
      for (const c of configs) {
        configMap[c.key] = c.value;
      }

      const getEnabled = (key: string) => (configMap[key] as any)?.enabled === true;

      res.json({
        automations: {
          hubspot_webhook_processing: { type: 'webhook', enabled: getEnabled('hubspot_webhook_processing'), description: 'HubSpot deal/contact/company webhook processing' },
          procore_webhook_processing: { type: 'webhook', enabled: getEnabled('procore_webhook_processing'), description: 'Procore project/role/budget webhook processing' },
          procore_project_webhook_processing: { type: 'webhook', enabled: getEnabled('procore_project_webhook_processing'), description: 'Procore project-events webhook (Phase 2 trigger)' },
          deal_project_number: { type: 'feature', enabled: getEnabled('deal_project_number'), description: 'Auto-assign project numbers on new HubSpot deals' },
          hubspot_polling: { type: 'polling', enabled: getEnabled('hubspot_polling'), active: pollingTimer !== null, lastRunAt: lastPollAt?.toISOString() || null, description: 'HubSpot companies/contacts/deals sync' },
          procore_polling: { type: 'polling', enabled: getEnabled('procore_polling'), active: procorePollingTimer !== null, lastRunAt: lastProcorePollAt?.toISOString() || null, description: 'Procore projects/vendors/users sync' },
          role_assignment_polling: { type: 'polling', enabled: getEnabled('role_assignment_polling'), active: rolePollingTimer !== null, lastRunAt: lastRolePollAt?.toISOString() || null, description: 'PM/Superintendent role assignment sync' },
          bidboard_polling: { type: 'polling', enabled: getEnabled('bidboard_automation'), active: bidboardPollingTimer !== null, lastRunAt: lastBidboardPollAt?.toISOString() || null, description: 'BidBoard Playwright scraper' },
          bidboard_stage_sync: { type: 'polling', enabled: getEnabled('bidboard_stage_sync'), active: bidboardStageSyncTimer !== null, lastRunAt: lastBidboardStageSyncAt?.toISOString() || null, description: 'BidBoard Excel export → HubSpot stage sync' },
          change_order_polling: { type: 'polling', enabled: getEnabled('sync_change_orders'), active: changeOrderPollingTimer !== null, lastRunAt: lastChangeOrderPollAt?.toISOString() || null, description: 'Procore approved COs → HubSpot deal amounts' },
          portfolio_auto_trigger: { type: 'config', enabled: getEnabled('portfolio_auto_trigger'), description: 'Auto-trigger Phase 2 on Procore project webhook (no Phase 1 required)' },
          procore_hubspot_stage_sync: { type: 'config', enabled: getEnabled('procore_hubspot_stage_sync'), description: 'Bi-directional Procore↔HubSpot stage sync' },
        },
        hint: 'Each automation is independently controlled. Enable webhook processing first, then individual features within it.',
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/automation-config", requireAuth, async (_req, res) => {
    try {
      const configs = await storage.getAutomationConfigs();
      res.json(configs);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/automation-config", requireAuth, async (req, res) => {
    try {
      const config = await storage.upsertAutomationConfig(req.body);
      res.json(config);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/poll-jobs", requireAuth, async (_req, res) => {
    try {
      const jobs = await storage.getPollJobs();
      res.json(jobs);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/poll-jobs/:jobName", requireAuth, async (req, res) => {
    try {
      const job = await storage.updatePollJob(req.params.jobName, req.body);
      if (!job) return res.status(404).json({ message: "Not found" });
      res.json(job);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  // ── HubSpot polling routes ──────────────────────────────────────────────────
  app.get("/api/automation/polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("hubspot_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 10,
        isRunning: pollingTimer !== null,
        lastPollAt: lastPollAt?.toISOString() || null,
        lastPollResult,
        currentlyPolling: pollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = intervalMinutes || 10;
      await storage.upsertAutomationConfig({
        key: "hubspot_polling",
        value: { enabled, intervalMinutes: interval },
        description: "Automatic HubSpot polling sync configuration",
      });

      if (enabled) {
        startPolling(interval);
      } else {
        stopPolling();
      }

      res.json({ success: true, enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (pollingRunning) {
        return res.json({ message: "Sync already in progress", running: true });
      }
      runPollingCycle();
      res.json({ message: "Sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Procore polling routes ──────────────────────────────────────────────────
  app.get("/api/automation/procore-polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("procore_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 15,
        isRunning: procorePollingTimer !== null,
        lastPollAt: lastProcorePollAt?.toISOString() || null,
        lastPollResult: lastProcorePollResult,
        currentlyPolling: procorePollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/procore-polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = intervalMinutes || 15;
      await storage.upsertAutomationConfig({
        key: "procore_polling",
        value: { enabled, intervalMinutes: interval },
        description: "Automatic Procore data polling sync configuration",
      });
      if (enabled) {
        startProcorePolling(interval);
      } else {
        stopProcorePolling();
      }
      res.json({ success: true, enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/procore-polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (procorePollingRunning) {
        return res.json({ message: "Procore sync already in progress", running: true });
      }
      runProcorePollingCycle();
      res.json({ message: "Procore sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Role polling routes ─────────────────────────────────────────────────────
  app.get("/api/automation/role-polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("role_assignment_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes ?? 30,
        isRunning: rolePollingTimer !== null,
        lastPollAt: lastRolePollAt?.toISOString() || null,
        lastPollResult: lastRolePollResult,
        currentlyPolling: rolePollingRunning,
        lastWebhookEventAt: lastWebhookRoleEventAt?.toISOString() || null,
        webhookActive: lastWebhookRoleEventAt
          ? (Date.now() - lastWebhookRoleEventAt.getTime()) < 30 * 60 * 1000
          : false,
        batchSize: ROLE_POLLING_BATCH_SIZE,
        batchCursor: rolePollingBatchCursor,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/role-polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes, batchSize: reqBatchSize } = req.body;
      const interval = intervalMinutes ?? 30;
      if (reqBatchSize !== undefined) {
        ROLE_POLLING_BATCH_SIZE = Math.max(10, Math.min(200, Number(reqBatchSize) || 50));
      }
      const stored = { enabled, intervalMinutes: interval, batchSize: ROLE_POLLING_BATCH_SIZE };
      await storage.upsertAutomationConfig({
        key: "role_assignment_polling",
        value: stored,
        description: "Automatic Procore role assignment polling configuration",
      });
      if (enabled) {
        startRolePolling(interval);
      } else {
        stopRolePolling();
      }
      res.json({ success: true, enabled, intervalMinutes: interval, batchSize: ROLE_POLLING_BATCH_SIZE });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual "Sync Now" uses full sync (all projects) — user expects complete check. Scheduled polling uses batched sync.
  app.post("/api/automation/role-polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (rolePollingRunning) {
        return res.json({ message: "Role assignment sync already in progress", running: true });
      }
      runRolePollingCycle({ fullSync: true });
      res.json({ message: "Role assignment sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── BidBoard polling routes ─────────────────────────────────────────────────
  app.get("/api/bidboard/status", requireAuth, async (_req, res) => {
    try {
      const status = await getAutomationStatus();
      res.json({
        ...status,
        isPolling: bidboardPollingTimer !== null,
        lastPollAt: lastBidboardPollAt?.toISOString() || null,
        lastPollResult: lastBidboardPollResult,
        currentlyPolling: bidboardPollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/bidboard/config", requireAuth, async (_req, res) => {
    try {
      const automationConfig = await storage.getAutomationConfig("bidboard_automation");
      const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");

      res.json({
        enabled: (automationConfig?.value as any)?.enabled || false,
        pollingIntervalMinutes: (automationConfig?.value as any)?.pollingIntervalMinutes || 60,
        hasCredentials: !!credentialsConfig?.value,
        sandbox: (credentialsConfig?.value as any)?.sandbox || false,
        email: (credentialsConfig?.value as any)?.email || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bidboard/config", requireAuth, async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bidboard/poll", requireAuth, async (_req, res) => {
    try {
      if (bidboardPollingRunning) {
        return res.json({ message: "BidBoard polling already in progress", running: true });
      }
      runBidboardPollingCycle();
      res.json({ message: "BidBoard polling triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── BidBoard stage sync routes ──────────────────────────────────────────────
  app.get("/api/bidboard/stage-sync/config", requireAuth, async (_req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bidboard/stage-sync/config", requireAuth, async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/bidboard/stage-sync/history", requireAuth, async (req, res) => {
    try {
      const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
      const runs = await storage.getBidboardStageSyncRuns(limit);
      res.json(runs);
    } catch (e: any) {
      if (e?.code === "42P01" || e?.message?.includes("does not exist") || e?.message?.includes("relation")) {
        res.json([]);
        return;
      }
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bidboard/stage-sync/trigger", requireAuth, async (_req, res) => {
    try {
      if (bidboardStageSyncRunning) {
        return res.json({ message: "Stage sync already in progress", running: true });
      }
      runBidBoardStageSyncCycle();
      res.json({ message: "Stage sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/bidboard/stage-sync/reset-baseline", requireAuth, async (_req, res) => {
    try {
      const deleted = await storage.deleteAllBidboardStageSyncRuns();
      console.log(`[BidBoardStageSync] Reset baseline: deleted ${deleted} sync run(s)`);
      res.json({ success: true, deleted, message: `Cleared ${deleted} sync run(s). Next trigger will re-initialize baseline.` });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post("/api/bidboard/stage-sync", requireAuth, async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ error: e.message, errors: [e.message] });
    }
  });

  // ── Change order polling routes ────────────────────────────────────────────
  app.get("/api/automation/change-order-polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("sync_change_orders");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 15,
        isRunning: changeOrderPollingTimer !== null,
        lastPollAt: lastChangeOrderPollAt?.toISOString() || null,
        lastPollResult: lastChangeOrderPollResult,
        currentlyPolling: changeOrderPollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/change-order-polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = Math.min(60, Math.max(5, parseInt(String(intervalMinutes)) || 15));
      await storage.upsertAutomationConfig({
        key: "sync_change_orders",
        value: { enabled: !!enabled, intervalMinutes: interval },
        description: "Sync approved Procore change order amounts back to HubSpot deals",
      });
      if (enabled) {
        startChangeOrderPolling(interval);
      } else {
        if (changeOrderPollingTimer) {
          clearInterval(changeOrderPollingTimer);
          changeOrderPollingTimer = null;
        }
      }
      res.json({ success: true, enabled: !!enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/change-order-polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (changeOrderPollingRunning) {
        return res.json({ message: "Change order sync already in progress", running: true });
      }
      runChangeOrderPollingCycle();
      res.json({ message: "Change order sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Internal: enable all automations (secret-gated, no session auth) ──────
  app.post("/api/internal/enable-all-automations", async (req, res) => {
    const secret = req.headers["x-internal-secret"] || req.body?.secret;
    if (secret !== (process.env.INTERNAL_API_SECRET || "synchub-test-2026")) {
      return res.status(403).json({ error: "Invalid secret" });
    }

    const results: Record<string, string> = {};

    try {
      // Webhook processing gates
      for (const key of [
        "hubspot_webhook_processing",
        "procore_webhook_processing",
        "procore_project_webhook_processing",
      ]) {
        await storage.upsertAutomationConfig({ key, value: { enabled: true }, description: `${key} (auto-enabled)` });
        results[key] = "enabled";
      }

      // Feature flags
      for (const key of ["deal_project_number", "hubspot_procore_auto_sync"]) {
        await storage.upsertAutomationConfig({ key, value: { enabled: true }, description: `${key} (auto-enabled)` });
        results[key] = "enabled";
      }

      // Config flags
      for (const key of ["portfolio_auto_trigger", "procore_hubspot_stage_sync"]) {
        await storage.upsertAutomationConfig({ key, value: { enabled: true }, description: `${key} (auto-enabled)` });
        results[key] = "enabled";
      }

      // HubSpot polling — 15 min
      await storage.upsertAutomationConfig({ key: "hubspot_polling", value: { enabled: true, intervalMinutes: 15 }, description: "HubSpot polling (auto-enabled)" });
      if (!pollingTimer) {
        pollingTimer = setInterval(async () => {
          if (pollingRunning) return;
          pollingRunning = true;
          try {
            const result = await runFullHubSpotSync();
            lastPollAt = new Date();
            lastPollResult = result;
          } catch (e: any) { console.error("[HubSpotPolling] Error:", e.message); }
          finally { pollingRunning = false; }
        }, 15 * 60 * 1000);
        setTimeout(async () => {
          if (pollingRunning) return;
          pollingRunning = true;
          try { const r = await runFullHubSpotSync(); lastPollAt = new Date(); lastPollResult = r; }
          catch (e: any) { console.error("[HubSpotPolling] Error:", e.message); }
          finally { pollingRunning = false; }
        }, 30000);
      }
      results["hubspot_polling"] = "enabled (15 min)";

      // Procore polling — 15 min
      await storage.upsertAutomationConfig({ key: "procore_polling", value: { enabled: true, intervalMinutes: 15 }, description: "Procore polling (auto-enabled)" });
      if (!procorePollingTimer) {
        procorePollingTimer = setInterval(async () => {
          if (procorePollingRunning) return;
          procorePollingRunning = true;
          try {
            const result = await runFullProcoreSync();
            lastProcorePollAt = new Date();
            lastProcorePollResult = result;
          } catch (e: any) { console.error("[ProcorePolling] Error:", e.message); }
          finally { procorePollingRunning = false; }
        }, 15 * 60 * 1000);
        setTimeout(async () => {
          if (procorePollingRunning) return;
          procorePollingRunning = true;
          try { const r = await runFullProcoreSync(); lastProcorePollAt = new Date(); lastProcorePollResult = r; }
          catch (e: any) { console.error("[ProcorePolling] Error:", e.message); }
          finally { procorePollingRunning = false; }
        }, 30000);
      }
      results["procore_polling"] = "enabled (15 min)";

      // Role assignment polling — 30 min
      await storage.upsertAutomationConfig({ key: "role_assignment_polling", value: { enabled: true, intervalMinutes: 30 }, description: "Role assignment polling (auto-enabled)" });
      if (!rolePollingTimer) {
        startRolePolling(30);
      }
      results["role_assignment_polling"] = "enabled (30 min)";

      // BidBoard stage sync — 15 min
      await storage.upsertAutomationConfig({ key: "bidboard_stage_sync", value: { enabled: true, intervalMinutes: 15, mode: "live" }, description: "BidBoard stage sync (auto-enabled)" });
      if (!bidboardStageSyncTimer) {
        bidboardStageSyncTimer = setInterval(runBidBoardStageSyncCycle, 15 * 60 * 1000);
        setTimeout(runBidBoardStageSyncCycle, 15000);
      }
      results["bidboard_stage_sync"] = "enabled (15 min, live)";

      // BidBoard automation — 60 min
      await storage.upsertAutomationConfig({ key: "bidboard_automation", value: { enabled: true, pollingIntervalMinutes: 60 }, description: "BidBoard Playwright automation (auto-enabled)" });
      await enableBidBoardAutomation(true);
      if (!bidboardPollingTimer) {
        startBidboardPolling(60);
      }
      results["bidboard_automation"] = "enabled (60 min)";

      // Change order polling — 15 min
      await storage.upsertAutomationConfig({ key: "sync_change_orders", value: { enabled: true, intervalMinutes: 15 }, description: "Change order sync (auto-enabled)" });
      if (!changeOrderPollingTimer) {
        startChangeOrderPolling(15);
      }
      results["sync_change_orders"] = "enabled (15 min)";

      console.log("[EnableAll] All automations enabled:", results);
      res.json({ success: true, automations: results });
    } catch (e: any) {
      console.error("[EnableAll] Error:", e.message);
      res.status(500).json({ error: e.message, partial: results });
    }
  });

  // ── Stage notification config routes ────────────────────────────────────────
  app.get("/api/stage-notifications/config", requireAuth, async (_req, res) => {
    try {
      const { getStageNotificationConfigs } = await import('../stage-notifications');
      const configs = await getStageNotificationConfigs();
      res.json(configs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/stage-notifications/config/:key", requireAuth, async (req, res) => {
    try {
      const { setStageNotificationEnabled } = await import('../stage-notifications');
      const { enabled } = req.body;
      const success = await setStageNotificationEnabled(req.params.key, !!enabled);
      if (!success) {
        return res.status(404).json({ error: `Unknown notification key: ${req.params.key}` });
      }
      res.json({ success: true, key: req.params.key, enabled: !!enabled });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Internal: send test stage notification email ──────────────────────────
  app.post("/api/internal/test-stage-notification", async (req, res) => {
    const secret = req.headers["x-internal-secret"] || req.body?.secret;
    if (secret !== (process.env.INTERNAL_API_SECRET || "synchub-test-2026")) {
      return res.status(403).json({ error: "Invalid secret" });
    }

    try {
      const { sendEmail } = await import('../email-service');
      const { buildStageNotificationEmail } = await import('../stage-notifications');
      const to = req.body?.to || 'adnaan.iqbal@gmail.com';
      const stage = req.body?.stage || 'Close Out - Final Invoice';
      const htmlBody = buildStageNotificationEmail('Test Project - DFW-4-08226-aa', 'Close Out', stage, '562949955661621');
      const result = await sendEmail({ to, subject: `Stage Update: Test Project → ${stage}`, htmlBody, fromName: 'T-Rock Sync Hub' });
      res.json({ success: result.success, provider: result.provider, error: result.error });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Internal: trigger change order sync for a specific project ────────────
  app.post("/api/internal/sync-change-orders", async (req, res) => {
    const secret = req.headers["x-internal-secret"] || req.body?.secret;
    if (secret !== (process.env.INTERNAL_API_SECRET || "synchub-test-2026")) {
      return res.status(403).json({ error: "Invalid secret" });
    }

    try {
      const { projectNumber, portfolioProjectId } = req.body || {};
      let projectId = portfolioProjectId;

      // Look up by project number if no direct ID provided
      if (!projectId && projectNumber) {
        const mappings = await storage.getSyncMappings();
        const pn = projectNumber.toLowerCase();
        const match = mappings.find(m =>
          m.projectNumber?.toLowerCase() === pn ||
          m.projectNumber?.toLowerCase().includes(pn) ||
          pn.includes(m.projectNumber?.toLowerCase() || '___') ||
          m.hubspotDealName?.toLowerCase().includes(pn)
        );
        if (!match) {
          // Return sample mappings for debugging
          const samples = mappings.slice(0, 10).map(m => ({
            projectNumber: m.projectNumber,
            hubspotDealName: m.hubspotDealName,
            procoreProjectId: m.procoreProjectId,
            portfolioProjectId: m.portfolioProjectId,
            bidboardProjectId: m.bidboardProjectId,
          }));
          return res.json({ error: `No sync mapping found for: ${projectNumber}`, mappingsChecked: mappings.length, samples });
        }
        projectId = match.portfolioProjectId || match.procoreProjectId;
        res.locals.mapping = match;
      }

      if (!projectId) {
        return res.status(400).json({ error: "Provide portfolioProjectId or projectNumber" });
      }

      const { syncChangeOrdersToHubSpot, calculateTotalContractValue, getPrimeContractAmount, getProjectChangeOrders } = await import('../change-order-sync');
      const { getProcoreClient, getCompanyId } = await import('../procore');

      // Raw API debug
      const client = await getProcoreClient();
      const compId = await getCompanyId();
      let rawPrimeContracts: any = null;
      let rawChangeOrders: any = null;
      let rawError: string | null = null;

      try {
        const pcResponse = await client.get(`/rest/v1.0/projects/${projectId}/prime_contracts`, { params: { company_id: compId } });
        rawPrimeContracts = pcResponse.data;
      } catch (e: any) {
        rawError = e.message;
      }

      try {
        const coResponse = await client.get(`/rest/v1.0/projects/${projectId}/change_order_packages`, { params: { company_id: compId } });
        rawChangeOrders = coResponse.data;
      } catch (e: any) {
        rawError = (rawError ? rawError + ' | ' : '') + e.message;
      }

      const contractValue = await calculateTotalContractValue(projectId);
      const syncResult = await syncChangeOrdersToHubSpot(projectId);

      res.json({
        projectId,
        companyId: compId,
        rawPrimeContracts,
        rawChangeOrders,
        rawError,
        contractValue,
        syncResult,
        mapping: res.locals.mapping || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
