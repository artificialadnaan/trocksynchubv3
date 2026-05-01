import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runBidBoardCanary,
} from "../scripts/bidboard-canary-run";
import {
  captureBidBoardCanaryBaseline,
  diffBidBoardCanaryBaseline,
} from "../scripts/bidboard-canary-baseline";
import {
  buildBidBoardCanaryReport,
} from "../server/reports/bidboard-canary-report";

describe("BidBoard canary tooling", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bidboard-canary-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs canary sync only for the requested project numbers", async () => {
    const diffBidBoardStages = vi.fn().mockResolvedValue([
      {
        projectName: "Canary Project",
        projectNumber: "P-1",
        customerName: "Acme",
        previousStage: "Estimate Sent to Client",
        newStage: "Contract",
        totalSales: 100,
        synchubRecordId: "1",
        hubspotDealId: "deal-1",
      },
    ]);
    const syncStagesToHubSpot = vi.fn().mockResolvedValue({ success: 1, failed: 0, suppressed: 3, errors: [] });
    const resolveBidBoardHubSpotStage = vi.fn().mockResolvedValue({
      stageLabel: "Closed Won",
      mappingSource: "stage_mappings",
      normalizedStage: "Contract",
      triggerPortfolio: true,
    });

    const result = await runBidBoardCanary({
      projectNumbers: ["P-1", "P-2"],
      mode: "migration",
      forceExport: "/tmp/export.xlsx",
      deps: {
        getAutomationConfig: vi.fn().mockResolvedValue({ key: "bidboard_stage_sync", value: { enabled: true } }),
        exportBidBoardProjectList: vi.fn(),
        diffBidBoardStages,
        syncStagesToHubSpot,
        resolveBidBoardHubSpotStage,
        createBidboardAutomationLog: vi.fn().mockResolvedValue({}),
      },
    });

    expect(diffBidBoardStages).toHaveBeenCalledWith("/tmp/export.xlsx", expect.objectContaining({
      projectNumbers: ["P-1", "P-2"],
      modeConfigOverride: expect.objectContaining({
        mode: "migration",
        suppressHubSpotWrites: true,
        suppressPortfolioTriggers: true,
        suppressStageNotifications: true,
        canaryRunId: result.canaryRunId,
      }),
    }));
    expect(syncStagesToHubSpot).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      dryRun: false,
      modeConfigOverride: expect.objectContaining({ canaryRunId: result.canaryRunId }),
    }));
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toEqual(expect.objectContaining({
      mappingSource: "stage_mappings",
      wouldHaveAction: "portfolio_create_phase1 + hubspot_stage_update",
    }));
    expect(resolveBidBoardHubSpotStage).toHaveBeenCalledWith("Contract", expect.objectContaining({
      canaryRunId: result.canaryRunId,
      projectNumber: "P-1",
      previousStage: "Estimate Sent to Client",
    }));
  });

  it("refuses canary runs with more than 10 projects", async () => {
    await expect(runBidBoardCanary({
      projectNumbers: Array.from({ length: 11 }, (_, index) => `P-${index}`),
      deps: {
        getAutomationConfig: vi.fn(),
        exportBidBoardProjectList: vi.fn(),
        diffBidBoardStages: vi.fn(),
        syncStagesToHubSpot: vi.fn(),
        resolveBidBoardHubSpotStage: vi.fn(),
        createBidboardAutomationLog: vi.fn(),
      },
    })).rejects.toThrow("at most 10");
  });

  it("refuses canary runs when bidboard_stage_sync is disabled", async () => {
    await expect(runBidBoardCanary({
      projectNumbers: ["P-1"],
      deps: {
        getAutomationConfig: vi.fn().mockResolvedValue({ key: "bidboard_stage_sync", value: { enabled: false } }),
        exportBidBoardProjectList: vi.fn(),
        diffBidBoardStages: vi.fn(),
        syncStagesToHubSpot: vi.fn(),
        resolveBidBoardHubSpotStage: vi.fn(),
        createBidboardAutomationLog: vi.fn(),
      },
    })).rejects.toThrow("bidboard_stage_sync.enabled=false");
  });

  it("scopes canary reports by cycle_id, canary_run_id, and since timestamp", async () => {
    const logs = [
      { id: 1, projectId: "P-1", projectName: "P1", action: "bidboard_stage_sync:suppressed_hubspot_write", status: "suppressed", details: { cycleId: "cycle-1", canaryRunId: "canary-1", previousStage: "A", newStage: "B", mappingSource: "stage_mappings" }, createdAt: "2026-05-01T10:00:00Z" },
      { id: 2, projectId: "P-2", projectName: "P2", action: "bidboard_stage_sync:suppressed_hubspot_write", status: "suppressed", details: { cycleId: "cycle-2", canaryRunId: "canary-2", previousStage: "A", newStage: "B", mappingSource: "stage_mappings" }, createdAt: "2026-05-01T11:00:00Z" },
    ];
    const queryLogs = vi.fn(async () => logs);

    expect((await buildBidBoardCanaryReport({ cycleId: "cycle-1" }, { queryLogs })).totalSuppressedHubSpotWrites).toBe(1);
    expect((await buildBidBoardCanaryReport({ canaryRunId: "canary-2" }, { queryLogs })).rows.map((row) => row.id)).toEqual([2]);
    expect((await buildBidBoardCanaryReport({ since: "2026-05-01T10:30:00Z" }, { queryLogs })).rows.map((row) => row.id)).toEqual([2]);
  });

  it("reports PASS when migration-mode abort criteria are clean and FAIL when external calls occurred", async () => {
    const pass = await buildBidBoardCanaryReport({ canaryRunId: "canary-clean" }, {
      queryLogs: vi.fn(async () => [
        { id: 1, projectId: "P-1", projectName: "P1", action: "bidboard_stage_sync:suppressed_hubspot_write", status: "suppressed", details: { canaryRunId: "canary-clean", previousStage: "A", newStage: "B" }, createdAt: "2026-05-01T10:00:00Z" },
      ]),
    });

    const fail = await buildBidBoardCanaryReport({ canaryRunId: "canary-bad" }, {
      queryLogs: vi.fn(async () => [
        { id: 2, projectId: "P-2", projectName: "P2", action: "bidboard_stage_sync", status: "success", details: { canaryRunId: "canary-bad", previousStage: "A", newStage: "B", suppressed: false }, createdAt: "2026-05-01T10:00:00Z" },
        { id: 3, projectId: "P-3", projectName: "P3", action: "stage_notification_sent", status: "success", details: { canaryRunId: "canary-bad", route: "bb_closed_won" }, createdAt: "2026-05-01T10:01:00Z" },
      ]),
    });

    expect(pass.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(fail.redFlags).toHaveLength(2);
  });

  it("captures canary baseline and diffs after state", async () => {
    const baseline = await captureBidBoardCanaryBaseline({
      projectNumbers: ["P-1"],
      outputDir: dir,
      deps: {
        getBidboardSyncState: vi.fn().mockResolvedValue({ projectId: "P-1", currentStage: "Estimate Sent to Client" }),
        getSyncMappingByProcoreProjectNumber: vi.fn().mockResolvedValue({ hubspotDealId: "deal-1", portfolioProjectId: null }),
        getHubspotDealByHubspotId: vi.fn().mockResolvedValue({ hubspotId: "deal-1", dealStage: "Proposal Sent" }),
      },
    });
    const after = [{
      projectNumber: "P-1",
      bidboardStage: "Contract",
      hubspotDealId: "deal-1",
      hubspotStage: "Closed Won",
      portfolioProjectId: "portfolio-1",
      hasPortfolioProject: true,
    }];

    expect(JSON.parse(readFileSync(baseline.outputPath, "utf8")).projects).toHaveLength(1);
    expect(diffBidBoardCanaryBaseline(baseline, after)).toEqual([
      expect.objectContaining({
        projectNumber: "P-1",
        bidboardStage: { before: "Estimate Sent to Client", after: "Contract" },
        hubspotStage: { before: "Proposal Sent", after: "Closed Won" },
        hasPortfolioProject: { before: false, after: true },
      }),
    ]);
  });
});
