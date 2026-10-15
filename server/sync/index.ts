/**
 * Bid Board Stage Sync Orchestrator
 * ==================================
 *
 * Runs the full Bid Board → HubSpot stage sync pipeline:
 * 1. Export Excel from Bid Board (Playwright RPA)
 * 2. Parse Excel, diff against SyncHub, compute stage changes
 * 3. Push changes to HubSpot, update local state
 *
 * Usage:
 * - Cron: run every 15–30 minutes
 * - CLI: npx tsx server/sync/index.ts [--dry-run] [--force-export /path/to/file.xlsx] [--initialize]
 *
 * @module sync
 */

import * as fs from "fs/promises";
import * as path from "path";
import { exportBidBoardProjectList } from "../playwright/bidboard-export";
import {
  diffBidBoardStages,
  parseActiveProjectsSheet,
  syncStagesToHubSpot,
  type StageChange,
} from "./bidboard-stage-sync";
import { pushBidBoardRowsToCrm } from "./bidboard-crm-ingestion";
import { pushBidBoardRowsToCore } from "./bidboard-core-ingestion";
import { recordPushOutcomeAndMaybeAlert } from "./bidboard-crm-alert";
import { log } from "../index";
import { storage } from "../storage";

const EXPORTS_DIR = path.join(process.cwd(), "data", "exports");
const KEEP_LAST_N = 5;

export interface BidBoardStageSyncResult {
  total: number;
  changed: number;
  failed: number;
  changes: StageChange[];
  exportPath?: string;
  errors: string[];
  initialized?: boolean;
  /** BIDBOARD_STAGE_SYNC_EXPORT_ONLY: the export was downloaded and summarised, and nothing was pushed. */
  exportOnly?: boolean;
}

/**
 * BIDBOARD_STAGE_SYNC_EXPORT_ONLY=true: download + parse + summarise the Bid Board export and save its rows
 * next to it as <export>.rows.json, then STOP: no CRM push (so no push alert), no Core push, no HubSpot diff.
 * For a first run that must be looked at before it writes anything (the 2026-09-11 stale-export incident).
 */
export function isBidBoardExportOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.BIDBOARD_STAGE_SYNC_EXPORT_ONLY ?? "").trim());
}

const SERVICE_PROJECT_NUMBER_RE = /-4-/;

export { stageSyncRunStatus } from "./run-status";

export interface RunOptions {
  dryRun?: boolean;
  forceExport?: string;
  initialize?: boolean;
}

/**
 * Clean up old export files, keeping the last KEEP_LAST_N.
 */
async function cleanupOldExports(): Promise<void> {
  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
    const entries = await fs.readdir(EXPORTS_DIR);
    // The workbooks and the export-only .rows.json snapshots next to them, each kept to the newest KEEP_LAST_N.
    for (const suffix of [".xlsx", ".xlsx.rows.json"]) {
      const files = entries
        .filter((e) => e.endsWith(suffix))
        .map((e) => path.join(EXPORTS_DIR, e));
      const stats = await Promise.all(
        files.map(async (p) => ({ path: p, mtime: (await fs.stat(p)).mtime.getTime() }))
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      for (let i = KEEP_LAST_N; i < stats.length; i++) {
        await fs.unlink(stats[i].path).catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Run the full Bid Board stage sync pipeline.
 */
export async function runBidBoardStageSync(
  options: RunOptions = {}
): Promise<BidBoardStageSyncResult> {
  const { dryRun = true, forceExport, initialize = false } = options;
  const result: BidBoardStageSyncResult = {
    total: 0,
    changed: 0,
    failed: 0,
    changes: [],
    errors: [],
  };

  let exportPath: string | null = null;

  if (forceExport) {
    try {
      await fs.access(forceExport);
      exportPath = forceExport;
      log(`Using forced export file: ${forceExport}`, "sync");
    } catch {
      result.errors.push(`Export file not found: ${forceExport}`);
      return result;
    }
  } else {
    const exported = await exportBidBoardProjectList();
    exportPath = exported;
    if (!exportPath) {
      result.errors.push("Failed to export Bid Board project list from Procore");
      return result;
    }
    result.exportPath = exportPath;
  }

  try {
    const rows = parseActiveProjectsSheet(exportPath);
    if (isBidBoardExportOnly()) {
      const projectNumber = (r: (typeof rows)[number]) => {
        const v = r["Project #"];
        return typeof v === "string" && v.trim() ? v.trim() : null;
      };
      const statuses: Record<string, number> = {};
      for (const r of rows) {
        const k = String(r.Status ?? "").trim() || "(blank)";
        statuses[k] = (statuses[k] ?? 0) + 1;
      }
      const numbered = rows.filter((r) => projectNumber(r) !== null).length;
      const service = rows.filter((r) => SERVICE_PROJECT_NUMBER_RE.test(projectNumber(r) ?? "")).length;
      const rowsPath = `${exportPath}.rows.json`;
      await fs.writeFile(
        rowsPath,
        JSON.stringify(rows.map((r) => ({ projectNumber: projectNumber(r), name: r.Name ?? null, status: r.Status ?? null })))
      );
      log(
        `[BidBoardStageSync] EXPORT-ONLY: ${path.basename(exportPath)}: ${rows.length} rows ` +
          `(${numbered} with a project #, ${service} service (-4-)); statuses ` +
          `${Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}: ${n}`).join(", ")}; ` +
          `rows saved to ${rowsPath}; NOTHING pushed (CRM, Core, HubSpot)`,
        "sync"
      );
      result.exportPath = exportPath;
      result.exportOnly = true;
      await cleanupOldExports();
      return result;
    }
    // ONE extraction instant for both targets: Core keys newest-wins on it, and the two copies are the same snapshot.
    const extractedAt = new Date().toISOString();
    const pushResult = await pushBidBoardRowsToCrm({
      rows,
      sourceFilename: exportPath,
      extractedAt,
    });
    if (!pushResult.ok && !pushResult.skipped) {
      const reason = pushResult.terminalFailure
        ? "reached a terminal processing failure"
        : pushResult.rejected
          ? "was rejected by the CRM (deterministic client error)"
          : "could not be confirmed as durably accepted (ambiguous response)";
      log(`[BidBoardCRM] CRM ingestion ${reason} after ${pushResult.attempts} attempt(s); continuing stage sync`, "sync");
    }
    // Record the push outcome and email on retry-exhausted failure / recovery. Never throws — a
    // skipped (unconfigured) push is ignored. This is the failure half of the alerting pair; the CRM
    // heartbeat covers absence-of-success independently.
    await recordPushOutcomeAndMaybeAlert({
      pushResult,
      officeSlug: process.env.CRM_BID_BOARD_SYNC_OFFICE_SLUG ?? "dallas",
      sourceFilename: exportPath,
    });
    // The second target, Core (trock-core #1836), AFTER the CRM push and its alerting, so it can never delay or alter
    // them. Dark unless ENABLE_CORE_BID_BOARD_EXPORT; never throws.
    await pushBidBoardRowsToCore({ rows, sourceFilename: exportPath, extractedAt });

    if (initialize) {
      await diffBidBoardStages(exportPath, { initializeOnly: true });
      log("Initialization complete: populated bidboard_status for all projects", "sync");
      result.total = 0;
      result.changed = 0;
      return result;
    }

    const hasSuccessfulRun = await storage.hasSuccessfulBidboardStageSyncRun();
    if (!hasSuccessfulRun) {
      await diffBidBoardStages(exportPath, { initializeOnly: true });
      log("First run: seeded bidboard_status baseline only (no HubSpot calls)", "sync");
      result.total = 0;
      result.changed = 0;
      result.initialized = true;
      return result;
    }

    const changes = await diffBidBoardStages(exportPath);
    result.changes = changes;
    result.total = changes.length;
    result.changed = changes.length;

    if (changes.length === 0) {
      log("No stage changes detected", "sync");
      return result;
    }

    const syncResult = await syncStagesToHubSpot(changes, { dryRun });
    result.changed = syncResult.success;
    result.failed = syncResult.failed;
    result.errors.push(...syncResult.errors);

    if (dryRun) {
      log(`[DRY RUN] Would have synced ${changes.length} stage changes to HubSpot`, "sync");
    } else {
      log(`Synced ${syncResult.success} stage changes, ${syncResult.failed} failed`, "sync");
    }

    await cleanupOldExports();
  } catch (err: any) {
    result.errors.push(err.message || String(err));
    log(`BidBoard stage sync error: ${err.message}`, "sync");
  }

  return result;
}
