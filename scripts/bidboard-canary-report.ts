#!/usr/bin/env npx tsx

import { parseArgs, parseRange } from "./bidboard-stage-rename-common";
import { buildBidBoardCanaryReport } from "../server/reports/bidboard-canary-report";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cycleId = typeof args["cycle-id"] === "string" ? args["cycle-id"] : undefined;
  const canaryRunId = typeof args["canary-run-id"] === "string" ? args["canary-run-id"] : undefined;
  const since = typeof args.since === "string" ? args.since : undefined;
  const report = await buildBidBoardCanaryReport({
    cycleId,
    canaryRunId,
    since,
    expectedProductionSuppressedRange: parseRange(typeof args["production-range"] === "string" ? args["production-range"] : undefined, [0, 95]),
    expectedLostSuppressedRange: parseRange(typeof args["lost-range"] === "string" ? args["lost-range"] : undefined, [0, 115]),
    expectedEstimatingSuppressedRange: parseRange(typeof args["estimating-range"] === "string" ? args["estimating-range"] : undefined, [0, 210]),
  });

  console.log(`[BidBoard Canary Report] ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`Suppressed HubSpot writes: ${report.totalSuppressedHubSpotWrites}`);
  for (const [key, count] of Object.entries(report.suppressedHubSpotWritesByTransition)) console.log(`  ${key}: ${count}`);
  console.log(`Suppressed Portfolio triggers: ${report.totalSuppressedPortfolioTriggers}`);
  for (const [key, count] of Object.entries(report.suppressedPortfolioTriggersByStageAndMapping)) console.log(`  ${key}: ${count}`);
  console.log(`Suppressed notifications: ${report.totalSuppressedNotifications}`);
  for (const [key, count] of Object.entries(report.suppressedNotificationsByRoute)) console.log(`  ${key}: ${count}`);
  console.log(`Mapping fallback usages: ${report.totalMappingFallbackUsages}`);
  console.log(`Manual review queued: ${report.totalManualReviewQueued}`);
  if (report.baselineWarnings.length > 0) {
    console.log("Baseline warnings:");
    report.baselineWarnings.forEach((warning) => console.log(`  - ${warning}`));
  }
  if (report.redFlags.length > 0) {
    console.log("Red flags:");
    report.redFlags.forEach((flag) => console.log(`  - log#${flag.id} ${flag.projectId || ""} ${flag.action}: ${flag.reason}`));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("bidboard-canary-report.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Canary Report] Fatal:", error.message);
    process.exit(1);
  });
}
