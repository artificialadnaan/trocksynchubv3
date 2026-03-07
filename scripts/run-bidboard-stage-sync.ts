#!/usr/bin/env npx tsx
/**
 * CLI for Bid Board → HubSpot Stage Sync
 *
 * Usage:
 *   npx tsx scripts/run-bidboard-stage-sync.ts [options]
 *
 * Options:
 *   --dry-run         Compute diff and log what WOULD change, no HubSpot calls
 *   --force-export    Use a manually downloaded Excel file (path required)
 *   --initialize      First run: populate bidboard_status for all projects, no HubSpot push
 *
 * Examples:
 *   npx tsx scripts/run-bidboard-stage-sync.ts --dry-run
 *   npx tsx scripts/run-bidboard-stage-sync.ts --force-export ./data/exports/my-export.xlsx
 *   npx tsx scripts/run-bidboard-stage-sync.ts --initialize
 */

import { runBidBoardStageSync } from "../server/sync";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const initialize = args.includes("--initialize");
const forceExportIdx = args.indexOf("--force-export");
const forceExport =
  forceExportIdx >= 0 && args[forceExportIdx + 1]
    ? args[forceExportIdx + 1]
    : undefined;

async function main() {
  console.log("[BidBoard Stage Sync] Starting...");
  if (dryRun) console.log("[BidBoard Stage Sync] DRY-RUN mode — no HubSpot writes");
  if (initialize) console.log("[BidBoard Stage Sync] INITIALIZE mode — populate status only");
  if (forceExport) console.log(`[BidBoard Stage Sync] Using export file: ${forceExport}`);

  const result = await runBidBoardStageSync({
    dryRun,
    forceExport,
    initialize,
  });

  console.log("\n[BidBoard Stage Sync] Summary:");
  console.log(`  Total changes: ${result.total}`);
  console.log(`  Synced: ${result.changed}`);
  console.log(`  Failed: ${result.failed}`);
  if (result.exportPath) console.log(`  Export: ${result.exportPath}`);
  if (result.errors.length > 0) {
    console.log("\nErrors:");
    result.errors.forEach((e) => console.log(`  - ${e}`));
  }
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[BidBoard Stage Sync] Fatal error:", e.message);
  process.exit(1);
});
