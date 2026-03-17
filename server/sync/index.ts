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
import { diffBidBoardStages, syncStagesToHubSpot, type StageChange } from "./bidboard-stage-sync";
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
}

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
    const xlsx = entries
      .filter((e) => e.endsWith(".xlsx"))
      .map((e) => path.join(EXPORTS_DIR, e));
    const stats = await Promise.all(
      xlsx.map(async (p) => ({ path: p, mtime: (await fs.stat(p)).mtime.getTime() }))
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    for (let i = KEEP_LAST_N; i < stats.length; i++) {
      await fs.unlink(stats[i].path).catch(() => {});
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
