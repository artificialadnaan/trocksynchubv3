#!/usr/bin/env npx tsx

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createTimestamp, parseArgs } from "./bidboard-stage-rename-common";

export type CanaryBaselineProject = {
  projectNumber: string;
  bidboardStage: string | null;
  hubspotDealId: string | null;
  hubspotStage: string | null;
  portfolioProjectId: string | null;
  hasPortfolioProject: boolean;
};

export type CanaryBaseline = {
  timestamp: string;
  createdAt: string;
  outputPath: string;
  projects: CanaryBaselineProject[];
};

export type CanaryBaselineDeps = {
  getBidboardSyncState(projectNumber: string): Promise<any>;
  getSyncMappingByProcoreProjectNumber(projectNumber: string): Promise<any>;
  getHubspotDealByHubspotId(hubspotDealId: string): Promise<any>;
};

async function defaultDeps(): Promise<CanaryBaselineDeps> {
  const { storage } = await import("../server/storage");
  return {
    getBidboardSyncState: (projectNumber) => storage.getBidboardSyncState(projectNumber),
    getSyncMappingByProcoreProjectNumber: (projectNumber) => storage.getSyncMappingByProcoreProjectNumber(projectNumber),
    getHubspotDealByHubspotId: (hubspotDealId) => storage.getHubspotDealByHubspotId(hubspotDealId),
  };
}

export async function captureBidBoardCanaryBaseline(input: {
  projectNumbers: string[];
  outputDir?: string;
  deps?: CanaryBaselineDeps;
}): Promise<CanaryBaseline> {
  if (input.projectNumbers.length === 0) throw new Error("--project-numbers is required");
  const deps = input.deps || await defaultDeps();
  const timestamp = createTimestamp();
  const outputDir = input.outputDir || path.resolve(process.cwd(), "bidboard-canary-baselines");
  mkdirSync(outputDir, { recursive: true });
  const projects: CanaryBaselineProject[] = [];

  for (const projectNumber of input.projectNumbers) {
    const state = await deps.getBidboardSyncState(projectNumber);
    const mapping = await deps.getSyncMappingByProcoreProjectNumber(projectNumber);
    const hubspotDealId = mapping?.hubspotDealId || null;
    const hubspotDeal = hubspotDealId ? await deps.getHubspotDealByHubspotId(hubspotDealId) : null;
    const portfolioProjectId = mapping?.portfolioProjectId || null;
    projects.push({
      projectNumber,
      bidboardStage: state?.currentStage || null,
      hubspotDealId,
      hubspotStage: hubspotDeal?.dealStage || hubspotDeal?.dealStageName || null,
      portfolioProjectId,
      hasPortfolioProject: Boolean(portfolioProjectId),
    });
  }

  const outputPath = path.join(outputDir, `bidboard-canary-baseline-${timestamp}.json`);
  const baseline: CanaryBaseline = {
    timestamp,
    createdAt: new Date().toISOString(),
    outputPath,
    projects,
  };
  writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

export function diffBidBoardCanaryBaseline(
  baseline: Pick<CanaryBaseline, "projects">,
  afterProjects: CanaryBaselineProject[]
) {
  const afterMap = new Map(afterProjects.map((project) => [project.projectNumber, project]));
  return baseline.projects.map((before) => {
    const after = afterMap.get(before.projectNumber);
    return {
      projectNumber: before.projectNumber,
      bidboardStage: { before: before.bidboardStage, after: after?.bidboardStage ?? null },
      hubspotStage: { before: before.hubspotStage, after: after?.hubspotStage ?? null },
      hasPortfolioProject: { before: before.hasPortfolioProject, after: after?.hasPortfolioProject ?? false },
      portfolioProjectId: { before: before.portfolioProjectId, after: after?.portfolioProjectId ?? null },
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectNumbers = typeof args["project-numbers"] === "string"
    ? args["project-numbers"].split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const outputDir = typeof args["output-dir"] === "string" ? args["output-dir"] : undefined;
  const baseline = await captureBidBoardCanaryBaseline({ projectNumbers, outputDir });
  console.log("[BidBoard Canary Baseline] Baseline captured");
  for (const project of baseline.projects) {
    console.log(`${project.projectNumber}: BidBoard=${project.bidboardStage || "unmapped"} HubSpot=${project.hubspotStage || "unmapped"} Portfolio=${project.portfolioProjectId || "none"}`);
  }
  console.log(`Baseline: ${baseline.outputPath}`);
  console.log(`Next: npx tsx scripts/bidboard-canary-run.ts --project-numbers ${projectNumbers.join(",")} --mode migration`);
}

if (process.argv[1]?.endsWith("bidboard-canary-baseline.ts")) {
  main().catch((error) => {
    console.error("[BidBoard Canary Baseline] Fatal:", error.message);
    process.exit(1);
  });
}
