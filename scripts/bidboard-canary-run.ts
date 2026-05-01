#!/usr/bin/env -S npx tsx

import { createTimestamp, parseArgs } from "./bidboard-stage-rename-common";
import type {
  BidBoardStageSyncModeConfig,
  StageChange,
  StageSyncResult,
} from "../server/sync/bidboard-stage-sync";
import type { ResolvedBidBoardStage } from "../server/sync/stage-mapping";

export type CanaryRunDeps = {
  getAutomationConfig(key: string): Promise<any>;
  exportBidBoardProjectList(): Promise<string | null>;
  diffBidBoardStages(exportPath: string, options: any): Promise<StageChange[]>;
  syncStagesToHubSpot(changes: StageChange[], options: any): Promise<StageSyncResult>;
  resolveBidBoardHubSpotStage(stage: string, context: any): Promise<ResolvedBidBoardStage | null>;
  createBidboardAutomationLog(data: any): Promise<any>;
};

export type CanaryRunProjectResult = {
  projectNumber: string | null;
  projectName: string;
  previousStage: string;
  newStage: string;
  mappingSource: string;
  wouldHaveAction: string;
  suppressionStatus: string;
  hubspotDealId: string | null;
};

export type CanaryRunResult = {
  canaryRunId: string;
  cycleId: string;
  exportPath: string;
  mode: "migration" | "live";
  projects: CanaryRunProjectResult[];
  syncResult: StageSyncResult;
};

async function defaultDeps(): Promise<CanaryRunDeps> {
  const { storage } = await import("../server/storage");
  const { exportBidBoardProjectList } = await import("../server/playwright/bidboard-export");
  const { diffBidBoardStages, syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync");
  const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping");
  return {
    getAutomationConfig: (key) => storage.getAutomationConfig(key),
    exportBidBoardProjectList,
    diffBidBoardStages,
    syncStagesToHubSpot,
    resolveBidBoardHubSpotStage,
    createBidboardAutomationLog: (data) => storage.createBidboardAutomationLog(data),
  };
}

function createModeOverride(input: {
  mode: "migration" | "live";
  canaryRunId: string;
  cycleId: string;
  allowPortfolioTrigger: boolean;
}): BidBoardStageSyncModeConfig {
  return {
    mode: input.mode,
    canaryRunId: input.canaryRunId,
    cycleId: input.cycleId,
    suppressHubSpotWrites: input.mode === "migration",
    suppressPortfolioTriggers: input.mode === "migration" || !input.allowPortfolioTrigger,
    suppressStageNotifications: input.mode === "migration",
    logSuppressedActions: true,
  };
}

async function summarizeProject(
  change: StageChange,
  modeOverride: BidBoardStageSyncModeConfig,
  deps: Pick<CanaryRunDeps, "resolveBidBoardHubSpotStage">
): Promise<CanaryRunProjectResult> {
  const resolvedMapping = await deps.resolveBidBoardHubSpotStage(change.newStage, {
    projectName: change.projectName,
    projectNumber: change.projectNumber,
    previousStage: change.previousStage,
    cycleId: modeOverride.cycleId,
    canaryRunId: modeOverride.canaryRunId,
  });
  const portfolioCandidate = resolvedMapping?.triggerPortfolio === true;
  return {
    projectNumber: change.projectNumber,
    projectName: change.projectName,
    previousStage: change.previousStage,
    newStage: change.newStage,
    mappingSource: resolvedMapping?.mappingSource || "unresolved",
    wouldHaveAction: portfolioCandidate ? "portfolio_create_phase1 + hubspot_stage_update" : "hubspot_stage_update",
    suppressionStatus: modeOverride.suppressHubSpotWrites ? "suppressed" : "live",
    hubspotDealId: change.hubspotDealId || null,
  };
}

export async function runBidBoardCanary(input: {
  projectNumbers: string[];
  mode?: "migration" | "live";
  allowPortfolioTrigger?: boolean;
  forceExport?: string;
  canaryRunId?: string;
  deps?: CanaryRunDeps;
}): Promise<CanaryRunResult> {
  const projectNumbers = input.projectNumbers.map((projectNumber) => projectNumber.trim()).filter(Boolean);
  if (projectNumbers.length === 0) throw new Error("--project-numbers is required");
  if (projectNumbers.length > 10) throw new Error("Canary runs are limited to at most 10 project numbers");

  const deps = input.deps || await defaultDeps();
  const config = await deps.getAutomationConfig("bidboard_stage_sync");
  if ((config?.value as any)?.enabled !== true) {
    throw new Error("Refusing canary run because bidboard_stage_sync.enabled=false");
  }

  const mode = input.mode || "migration";
  const canaryRunId = input.canaryRunId || `bidboard-canary-${createTimestamp()}-${Math.random().toString(36).slice(2, 8)}`;
  const cycleId = canaryRunId;
  const modeConfigOverride = createModeOverride({
    mode,
    canaryRunId,
    cycleId,
    allowPortfolioTrigger: input.allowPortfolioTrigger === true,
  });
  const exportPath = input.forceExport || await deps.exportBidBoardProjectList();
  if (!exportPath) throw new Error("Failed to export Bid Board project list");

  await deps.createBidboardAutomationLog({
    projectId: projectNumbers.join(","),
    projectName: "BidBoard canary run",
    action: "bidboard_canary_run:start",
    status: "running",
    details: { canaryRunId, cycleId, projectNumbers, mode, allowPortfolioTrigger: input.allowPortfolioTrigger === true },
  });

  const changes = await deps.diffBidBoardStages(exportPath, {
    projectNumbers,
    modeConfigOverride,
  });
  const syncResult = await deps.syncStagesToHubSpot(changes, {
    dryRun: false,
    modeConfigOverride,
  });

  await deps.createBidboardAutomationLog({
    projectId: projectNumbers.join(","),
    projectName: "BidBoard canary run",
    action: "bidboard_canary_run:complete",
    status: syncResult.failed > 0 ? "failed" : "success",
    details: { canaryRunId, cycleId, projectNumbers, mode, syncResult },
  });

  const projects = await Promise.all(changes.map((change) => summarizeProject(change, modeConfigOverride, deps)));

  return {
    canaryRunId,
    cycleId,
    exportPath,
    mode,
    projects,
    syncResult,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectNumbers = typeof args["project-numbers"] === "string"
    ? args["project-numbers"].split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const mode = args.mode === "live" ? "live" : "migration";
  const allowPortfolioTrigger = args["allow-portfolio-trigger"] === true;
  const forceExport = typeof args["force-export"] === "string" ? args["force-export"] : undefined;
  const result = await runBidBoardCanary({ projectNumbers, mode, allowPortfolioTrigger, forceExport });
  console.log(`[BidBoard Canary] Run ID: ${result.canaryRunId}`);
  for (const project of result.projects) {
    console.log(`${project.projectNumber || "(no project #)"} | ${project.previousStage} -> ${project.newStage} | ${project.mappingSource} | ${project.wouldHaveAction} | ${project.suppressionStatus} | HubSpot=${project.hubspotDealId || "unmapped"}`);
  }
  console.log(`Next: npx tsx scripts/bidboard-canary-report.ts --canary-run-id ${result.canaryRunId}`);
}

if (process.argv[1]?.endsWith("bidboard-canary-run.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Canary] Fatal:", error.message);
    process.exit(1);
  });
}
