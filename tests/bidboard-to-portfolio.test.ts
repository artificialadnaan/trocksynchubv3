/**
 * Bid Board → Portfolio Project Creation Flow
 * ============================================
 *
 * Tests for:
 * - diffBidBoardStages (stage diff detection from Excel parsing)
 * - syncStagesToHubSpot (stage sync to HubSpot with guards)
 * - BIDBOARD_TO_HUBSPOT_STAGE mapping (pure lookup)
 * - triggerPortfolioAutomationFromStageChange trigger conditions
 *
 * @module tests/bidboard-to-portfolio
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Module-level mocks – must come before any server-module imports
// ---------------------------------------------------------------------------

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    // Core sync state
    getBidboardSyncStates: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    getManualReviewQueueEntry: vi.fn(),
    createManualReviewQueueEntry: vi.fn(),

    // Mapping lookups
    getSyncMappings: vi.fn(),
    getSyncMapping: vi.fn(),
    getSyncMappingByProcoreProjectNumber: vi.fn(),
    getSyncMappingByHubspotDealId: vi.fn(),
    createSyncMapping: vi.fn(),
    updateSyncMapping: vi.fn(),
    searchSyncMappings: vi.fn(),
    transitionToPortfolio: vi.fn(),

    // HubSpot deal lookups
    getHubspotDeals: vi.fn(),
    getHubspotDealByHubspotId: vi.fn(),
    getHubspotDealByProjectNumber: vi.fn(),
    getHubspotDealsByDealNames: vi.fn(),

    // Stage mappings
    getStageMappings: vi.fn(),
    createStageMapping: vi.fn(),
    updateStageMapping: vi.fn(),
    deleteStageMapping: vi.fn(),

    // HubSpot pipelines
    getHubspotPipelines: vi.fn(),
    upsertHubspotPipeline: vi.fn(),

    // Settings / auth
    getSettings: vi.fn(),
    upsertSettings: vi.fn(),
    getOAuthToken: vi.fn(),
    upsertOAuthToken: vi.fn(),
    getAutomationConfigs: vi.fn(),
    getAutomationConfig: vi.fn(),
    upsertAutomationConfig: vi.fn(),

    // Webhook / audit / idempotency
    createWebhookLog: vi.fn(),
    updateWebhookLog: vi.fn(),
    getWebhookLogs: vi.fn(),
    createAuditLog: vi.fn(),
    getAuditLogs: vi.fn(),
    checkIdempotencyKey: vi.fn(),
    createIdempotencyKey: vi.fn(),

    // Misc
    getContractCounter: vi.fn(),
    incrementContractCounter: vi.fn(),
    getRfpApprovalRequests: vi.fn(),
    getRfpApprovalRequest: vi.fn(),
    createRfpApprovalRequest: vi.fn(),
    updateRfpApprovalRequest: vi.fn(),
    getCloseoutSurveys: vi.fn(),
    getCloseoutSurvey: vi.fn(),
    createCloseoutSurvey: vi.fn(),
    updateCloseoutSurvey: vi.fn(),
    getEmailLogs: vi.fn(),
    createEmailLog: vi.fn(),
  },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: vi.fn().mockReturnValue({ setCredentials: vi.fn(), getAccessToken: vi.fn() }) },
    gmail: vi.fn().mockReturnValue({ users: { messages: { send: vi.fn() } } }),
  },
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }) },
  createTransport: vi.fn().mockReturnValue({ sendMail: vi.fn() }),
}));

vi.mock("../server/hubspot.ts", () => ({
  hubspotClient: {},
  getHubSpotClient: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  updateHubSpotDeal: vi.fn(),
}));

vi.mock("../server/procore.ts", () => ({
  getProcoreToken: vi.fn(),
  procoreRequest: vi.fn(),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
  getTerminalStageGuard: vi.fn(),
}));

vi.mock("../server/playwright/portfolio-automation.ts", () => ({
  triggerPortfolioAutomationFromStageChange: vi.fn(),
}));

vi.mock("../server/stage-notifications.ts", () => ({
  processStageNotification: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers — build a minimal in-memory Excel workbook for testing
// ---------------------------------------------------------------------------

function buildExcelBuffer(rows: Record<string, unknown>[], sheetName = "Active Projects"): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/** Write a temp xlsx file and return its path. Vitest runs in-process so fs.writeFileSync works. */
function writeTempXlsx(rows: Record<string, unknown>[], sheetName = "Active Projects"): string {
  const buf = buildExcelBuffer(rows, sheetName);
  const tmp = `/tmp/bidboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`;
  fs.writeFileSync(tmp, buf);
  return tmp;
}

// ---------------------------------------------------------------------------
// #1 – BIDBOARD_TO_HUBSPOT_STAGE mapping (pure, no I/O)
// ---------------------------------------------------------------------------

describe("BIDBOARD_TO_HUBSPOT_STAGE stage mapping", () => {
  it('maps "Estimate in Progress" → "Estimating"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Estimate in Progress"]).toBe("Estimating");
  });

  it('maps "Estimate Under Review" → "Internal Review"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Estimate Under Review"]).toBe("Internal Review");
  });

  it('maps "Estimate Sent to Client" → "Proposal Sent"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Estimate Sent to Client"]).toBe("Proposal Sent");
  });

  it('maps "Sent to Production" → "Closed Won"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Sent to Production"]).toBe("Closed Won");
  });

  it('maps "Service - Sent to Production" → "Service \u2013 Won"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Service - Sent to Production"]).toBe("Service \u2013 Won");
  });

  it('maps "Service - Estimating" → "Service \u2013 Estimating"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Service - Estimating"]).toBe("Service \u2013 Estimating");
  });

  it('maps "Production Lost" → "Closed Lost"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Production Lost"]).toBe("Closed Lost");
  });

  it('maps "Service - Lost" → "Service \u2013 Lost"', async () => {
    const { BIDBOARD_TO_HUBSPOT_STAGE } = await import("../server/sync/stage-mapping.ts");
    expect(BIDBOARD_TO_HUBSPOT_STAGE["Service - Lost"]).toBe("Service \u2013 Lost");
  });

  it("normalizeStageLabel converts Unicode en-dash to ASCII hyphen", async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Service \u2013 Lost")).toBe("Service - Lost");
  });

  it("normalizeStageLabel converts em-dash to ASCII hyphen", async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Service \u2014 Lost")).toBe("Service - Lost");
  });

  it("normalizeStageLabel leaves ASCII hyphen strings unchanged", async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Estimate in Progress")).toBe("Estimate in Progress");
  });

  it('normalizeStageLabel leaves canonical "Service - Estimating" unchanged', async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Service - Estimating")).toBe("Service - Estimating");
  });

  it('normalizeStageLabel canonicalizes "Service Estimating" to "Service - Estimating"', async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Service Estimating")).toBe("Service - Estimating");
  });

  it("normalizeStageLabel canonicalizes multi-space service estimating aliases", async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("Service   Estimating")).toBe("Service - Estimating");
  });

  it("normalizeStageLabel canonicalizes service estimating aliases case-insensitively", async () => {
    const { normalizeStageLabel } = await import("../server/sync/stage-mapping.ts");
    expect(normalizeStageLabel("service estimating")).toBe("Service - Estimating");
  });
});

// ---------------------------------------------------------------------------
// #2 – diffBidBoardStages: stage diff detection
// ---------------------------------------------------------------------------

describe("diffBidBoardStages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("detects a stage change when previous state differs from Excel status", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    const projectNumber = "TP-001";
    const hubspotDealId = "hs-deal-111";

    // Previous state: Estimating
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: projectNumber, currentStage: "Estimate in Progress", projectName: "Test Project", metadata: {} } as any,
    ]);

    // Mapping resolves to a known HubSpot deal
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue({
      id: 1,
      hubspotDealId,
      procoreProjectName: "Test Project",
    } as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Test Project", Status: "Estimate Under Review", "Project #": projectNumber, "Total Sales": 50000, "Customer Name": "Acme Corp" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(1);
    expect(changes[0].projectName).toBe("Test Project");
    expect(changes[0].previousStage).toBe("Estimate in Progress");
    expect(changes[0].newStage).toBe("Estimate Under Review");
    expect(changes[0].hubspotDealId).toBe(hubspotDealId);

    fs.unlinkSync(xlsxPath);
  });

  it('uses "(new)" as previousStage when no previous state exists', async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    // No previous sync state
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]);

    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue({
      id: 2,
      hubspotDealId: "hs-deal-222",
      procoreProjectName: "Brand New Project",
    } as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Brand New Project", Status: "Estimate in Progress", "Project #": "TP-002", "Total Sales": 20000, "Customer Name": "Beta Inc" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(1);
    expect(changes[0].previousStage).toBe("(new)");

    fs.unlinkSync(xlsxPath);
  });

  it("produces no change when Excel status matches previous state", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-003", currentStage: "Estimate in Progress", projectName: "Same Stage Project", metadata: {} } as any,
    ]);

    const xlsxPath = writeTempXlsx([
      { Name: "Same Stage Project", Status: "Estimate in Progress", "Project #": "TP-003", "Total Sales": 0, "Customer Name": "Gamma LLC" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(0);

    fs.unlinkSync(xlsxPath);
  });

  it("updates sync state but skips HubSpot changes when no mapping is found", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]);

    // All mapping lookups return nothing
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Orphan Project", Status: "Estimate in Progress", "Project #": "TP-999", "Total Sales": 0, "Customer Name": "Unknown Co" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    // No HubSpot deal → not added to changes array
    expect(changes).toHaveLength(0);
    // Sync state is still updated so we don't re-process on next cycle
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-999", currentStage: "Estimate in Progress" })
    );

    fs.unlinkSync(xlsxPath);
  });

  it("falls back to composite name+customer key when no Project # is present", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({
      data: [{ hubspotId: "hs-deal-fallback", dealName: "Roof Job", associatedCompanyName: "Delta Corp" } as any],
      total: 1,
    });
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue({
      id: 10,
      hubspotDealId: "hs-deal-fallback",
    } as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Roof Job", Status: "Estimate in Progress", "Customer Name": "Delta Corp", "Total Sales": 5000 },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(1);
    expect(changes[0].hubspotDealId).toBe("hs-deal-fallback");
    expect(changes[0].projectNumber).toBeNull();

    fs.unlinkSync(xlsxPath);
  });

  it("in initializeOnly mode upserts state without pushing to changes array", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Init Project", Status: "Estimate in Progress", "Project #": "TP-INIT", "Total Sales": 0, "Customer Name": "Epsilon" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath, { initializeOnly: true });

    expect(changes).toHaveLength(0);
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-INIT", currentStage: "Estimate in Progress" })
    );

    fs.unlinkSync(xlsxPath);
  });
});

// ---------------------------------------------------------------------------
// #3 – syncStagesToHubSpot: HubSpot sync with guards
// ---------------------------------------------------------------------------

describe("syncStagesToHubSpot", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { storage } = await import("../server/storage.ts");
    const { updateHubSpotDeal } = await import("../server/hubspot.ts");
    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
  });

  function makeChange(overrides: Partial<{
    projectName: string;
    projectNumber: string | null;
    customerName: string;
    previousStage: string;
    newStage: string;
    hubspotDealId: string;
    totalSales: number;
    synchubRecordId: string;
  }> = {}) {
    return {
      projectName: "Test Project",
      projectNumber: "TP-001",
      customerName: "Acme Corp",
      previousStage: "Estimate in Progress",
      newStage: "Estimate Under Review",
      hubspotDealId: "hs-deal-111",
      totalSales: 50000,
      synchubRecordId: "1",
      ...overrides,
    };
  }

  it("calls updateHubSpotDealStage with the resolved stageId on success", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-456", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    const result = await syncStagesToHubSpot([makeChange()]);

    expect(vi.mocked(updateHubSpotDealStage)).toHaveBeenCalledWith("hs-deal-111", "stage-id-456");
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("syncs HubSpot amount from Bid Board total sales, including zero", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-456", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    await syncStagesToHubSpot([makeChange({ totalSales: 0 })]);

    expect(vi.mocked(updateHubSpotDeal)).toHaveBeenCalledWith("hs-deal-111", { amount: "0" });
  });

  it("increments failed count when no BidBoard stage mapping exists", async () => {
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue(null);

    const result = await syncStagesToHubSpot([makeChange({ newStage: "Unknown Stage" })]);

    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
    expect(result.errors[0]).toContain("No BidBoard stage mapping");
  });

  it("increments failed count when mapped HubSpot stage cannot be resolved", async () => {
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue(null);

    const result = await syncStagesToHubSpot([makeChange({ newStage: "Estimate Under Review" })]);

    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
    expect(result.errors[0]).toContain("No HubSpot stage");
  });

  it("blocks update and skips when deal is in a terminal stage", async () => {
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue("Closed Won");

    const result = await syncStagesToHubSpot([makeChange({ newStage: "Estimate Under Review" })]);

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(result.errors[0]).toContain("refusing stage regression");
    expect(result.success).toBe(0);
  });

  it("in dry-run mode increments success but does NOT call updateHubSpotDealStage", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-ir", stageName: "Internal Review" });

    const result = await syncStagesToHubSpot([makeChange()], { dryRun: true });

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.upsertBidboardSyncState)).not.toHaveBeenCalled();
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("in dry-run mode resolves hardcoded fallback without writing fallback audit logs", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-ir", stageName: "Internal Review" });

    const result = await syncStagesToHubSpot([makeChange()], { dryRun: true });

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).not.toHaveBeenCalled();
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("in migration mode suppresses HubSpot writes, logs the suppression, and still advances local state", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-001",
          },
        } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-ir", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await syncStagesToHubSpot([makeChange()]);

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-001", projectName: "Test Project", currentStage: "Estimate Under Review" })
    );
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-001",
        projectName: "Test Project",
        action: "bidboard_stage_sync:suppressed_hubspot_write",
        status: "suppressed",
        details: expect.objectContaining({
          cycleId: "cycle-001",
          previousStage: "Estimate in Progress",
          newStage: "Estimate Under Review",
          wouldHaveAction: "hubspot_stage_update",
          targetValue: "Internal Review",
          hubspotDealId: "hs-deal-111",
          mappingSource: "hardcoded_fallback",
          mode: "migration",
        }),
      })
    );
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.suppressed).toBe(2);
  });

  it("in migration mode can suppress HubSpot writes while still sending stage notifications", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { processStageNotification } = await import("../server/stage-notifications.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: false,
            logSuppressedActions: true,
            cycleId: "cycle-independent-flags",
          },
        } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-ir", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue({
      procoreProjectId: "procore-123",
      bidboardProjectId: "bidboard-123",
    } as any);

    const result = await syncStagesToHubSpot([makeChange()]);

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(processStageNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(processStageNotification)).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Estimate Under Review",
        source: "bidboard",
        projectName: "Test Project",
        oldStage: "Estimate in Progress",
        procoreProjectId: "procore-123",
        bidboardProjectId: "bidboard-123",
        bidboardProjectNumber: "TP-001",
        hubspotDealId: "hs-deal-111",
      })
    );
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.suppressed).toBe(1);
  });

  it("in migration mode suppresses Contract stage notification with the standard suppression log shape", async () => {
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { processStageNotification } = await import("../server/stage-notifications.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-contract-notify",
          },
        } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await syncStagesToHubSpot([makeChange({ newStage: "Contract" })]);

    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(processStageNotification)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-001",
        projectName: "Test Project",
        action: "bidboard_stage_sync:suppressed_stage_notification",
        status: "suppressed",
        details: expect.objectContaining({
          cycleId: "cycle-contract-notify",
          previousStage: "Estimate in Progress",
          newStage: "Contract",
          wouldHaveAction: "send_stage_notification",
          targetValue: "Contract",
          hubspotDealId: "hs-deal-111",
          mappingSource: "stage_mappings",
          mode: "migration",
        }),
      })
    );
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.suppressed).toBe(3);
  });

  it("processes multiple changes and sums success/failed independently", async () => {
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId)
      .mockResolvedValueOnce({ stageId: "stage-a", stageName: "Estimating" })
      .mockResolvedValueOnce(null); // second change has no mapping

    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    const result = await syncStagesToHubSpot([
      makeChange({ projectName: "Project A", hubspotDealId: "hs-a", newStage: "Estimate in Progress" }),
      makeChange({ projectName: "Project B", hubspotDealId: "hs-b", newStage: "Unmapped Stage" }),
    ]);

    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("records failure and logs when updateHubSpotDealStage returns success=false", async () => {
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-id-ir", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: false, message: "HubSpot API rate limit" });
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await syncStagesToHubSpot([makeChange()]);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("HubSpot API rate limit");
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });
});

// ---------------------------------------------------------------------------
// #4 – Portfolio automation trigger conditions
// ---------------------------------------------------------------------------

describe("Portfolio automation trigger", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { storage } = await import("../server/storage.ts");
    const { updateHubSpotDeal } = await import("../server/hubspot.ts");
    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
  });

  function makeProductionChange(newStage: string) {
    return {
      projectName: "Production Project",
      projectNumber: "TP-PROD",
      customerName: "Zeta Corp",
      previousStage: "Estimate in Progress",
      newStage,
      hubspotDealId: "hs-deal-prod",
      totalSales: 100000,
      synchubRecordId: "5",
    };
  }

  it('triggers portfolio automation when newStage is "Sent to Production"', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Sent to Production")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledWith(
      "Production Project",
      "TP-PROD",
      "Zeta Corp",
      "hs-deal-prod"
    );
  });

  it('keeps the legacy "Sent to Production" portfolio trigger when a transition-window DB row exists with triggerPortfolio false', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Sent to Production",
        hubspotStageLabel: "Closed Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: false,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Sent to Production")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledWith(
      "Production Project",
      "TP-PROD",
      "Zeta Corp",
      "hs-deal-prod"
    );
  });

  it('triggers portfolio automation for "Contract" when stage_mappings.triggerPortfolio is true', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Contract")]);

    expect(vi.mocked(storage.createManualReviewQueueEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledWith(
      "Production Project",
      "TP-PROD",
      "Zeta Corp",
      "hs-deal-prod"
    );
  });

  // Regression insurance (post-HubSpot): "Won" is the live Bid Board label. Even if the
  // DB stage_mappings row for "Won" drifts to triggerPortfolio=false (e.g. a future rename
  // re-seed), the hardcoded fallback must keep "Won" firing portfolio — this is the exact
  // class of bug this whole effort started as.
  it('STILL triggers portfolio automation for "Won" even when the DB triggerPortfolio flag is false (hardcoded fallback safety net)', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: false,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger portfolio automation when no BidBoard mapping exists", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: false } } as any;
      }
      return undefined;
    });

    const result = await syncStagesToHubSpot([makeProductionChange("Contract")]);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("No BidBoard stage mapping");
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
  });

  it("in migration mode suppresses DB-driven Contract portfolio trigger with the existing suppression log shape", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-contract",
          },
        } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await syncStagesToHubSpot([makeProductionChange("Contract")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-PROD",
        projectName: "Production Project",
        action: "bidboard_stage_sync:suppressed_portfolio_trigger",
        status: "suppressed",
        details: expect.objectContaining({
          cycleId: "cycle-contract",
          previousStage: "Estimate in Progress",
          newStage: "Contract",
          wouldHaveAction: "portfolio_create_phase1",
          targetValue: "Contract",
          hubspotDealId: "hs-deal-prod",
          mappingSource: "stage_mappings",
          mode: "migration",
        }),
      })
    );
    expect(result.success).toBe(1);
    expect(result.suppressed).toBeGreaterThanOrEqual(2);
  });

  it("in migration mode suppresses mapped portfolio trigger and logs the would-have action", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-prod",
          },
        } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await syncStagesToHubSpot([makeProductionChange("Sent to Production")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-PROD",
        projectName: "Production Project",
        action: "bidboard_stage_sync:suppressed_portfolio_trigger",
        status: "suppressed",
        details: expect.objectContaining({
          cycleId: "cycle-prod",
          previousStage: "Estimate in Progress",
          newStage: "Sent to Production",
          wouldHaveAction: "portfolio_create_phase1",
          targetValue: "Sent to Production",
          hubspotDealId: "hs-deal-prod",
          mappingSource: "hardcoded_fallback",
          mode: "migration",
        }),
      })
    );
    expect(result.success).toBe(1);
    expect(result.suppressed).toBeGreaterThanOrEqual(2);
  });

  it("fires Portfolio when global trigger is disabled but the project is allowlisted", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: false, allowlist: ["TP-PROD"], requireHubspotDeal: true } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledWith(
      "Production Project",
      "TP-PROD",
      "Zeta Corp",
      "hs-deal-prod"
    );
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-PROD",
        action: "bidboard_stage_sync:portfolio_trigger_allowlist_match",
        status: "success",
        details: expect.objectContaining({
          projectNumber: "TP-PROD",
          targetValue: "Won",
          mappingSource: "stage_mappings",
          portfolioTriggerEnabled: false,
        }),
      })
    );
  });

  it("suppresses Portfolio when global trigger is disabled and the project is not allowlisted", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: false, allowlist: ["OTHER"], requireHubspotDeal: true } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-PROD",
        action: "bidboard_stage_sync:portfolio_trigger_disabled_skip",
        status: "skipped",
      })
    );
  });

  it("fires Portfolio when global trigger is enabled regardless of allowlist", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: true, allowlist: [], requireHubspotDeal: true } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
  });

  it("suppresses all Portfolio triggers when global trigger is disabled and allowlist is empty", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: false, allowlist: [], requireHubspotDeal: true } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
  });

  it("queues manual review instead of firing when an allowlisted trigger project has no HubSpot deal", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-PROD", currentStage: "Estimate in Progress", projectName: "Production Project", metadata: {} } as any,
    ]);
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return { key, value: { cycleId: "cycle-allowlist-no-hs" } } as any;
      }
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: false, allowlist: ["TP-PROD"], requireHubspotDeal: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Production Project", Status: "Won", "Project #": "TP-PROD", "Total Sales": 100000, "Customer Name": "Zeta Corp" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(0);
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectNumber: "TP-PROD",
        currentStage: "Won",
        previousStage: "Estimate in Progress",
      })
    );
  });

  it("in migration mode fires Portfolio for an allowlisted project even when suppressPortfolioTriggers is true", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-allowlist-precedence",
          },
        } as any;
      }
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: false, allowlist: ["TP-PROD"], requireHubspotDeal: true } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Won")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.createBidboardAutomationLog)).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bidboard_stage_sync:suppressed_portfolio_trigger",
      })
    );
  });

  it('triggers portfolio automation when newStage is "Service - Sent to Production"', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-sw", stageName: "Service \u2013 Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    await syncStagesToHubSpot([makeProductionChange("Service - Sent to Production")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledWith(
      "Production Project",
      "TP-PROD",
      "Zeta Corp",
      "hs-deal-prod"
    );
  });

  it('does NOT trigger portfolio automation for "Estimate Under Review"', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-ir", stageName: "Internal Review" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    await syncStagesToHubSpot([makeProductionChange("Estimate Under Review")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
  });

  it('does NOT trigger portfolio automation for "Production Lost"', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cl", stageName: "Closed Lost" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    await syncStagesToHubSpot([makeProductionChange("Production Lost")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
  });

  it('does NOT trigger portfolio automation for "Estimate in Progress"', async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-est", stageName: "Estimating" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(storage.getSyncMappingByHubspotDealId).mockResolvedValue(undefined);

    await syncStagesToHubSpot([makeProductionChange("Estimate in Progress")]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
  });

  it('queues manual review and does NOT trigger portfolio automation when no HubSpot deal mapping exists for "Contract"', async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    // Previous state shows a different stage so a change is detected
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-NOHUB", currentStage: "Estimate in Progress", projectName: "No HubSpot Project", metadata: {} } as any,
    ]);

    // No HubSpot mapping exists anywhere, but Contract is a mapped Portfolio trigger stage.
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "bidboard_stage_sync",
      value: { cycleId: "cycle-manual-review" },
    } as any);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const xlsxPath = writeTempXlsx([
      { Name: "No HubSpot Project", Status: "Contract", "Project #": "TP-NOHUB", "Total Sales": 75000, "Customer Name": "Omega Inc" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(0);
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectNumber: "TP-NOHUB",
        projectName: "No HubSpot Project",
        customer: "Omega Inc",
        currentStage: "Contract",
        previousStage: "Estimate in Progress",
        cycleId: "cycle-manual-review",
        reason: "unmapped_contract_no_hubspot_deal",
      })
    );
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-NOHUB",
        projectName: "No HubSpot Project",
        action: "bidboard_stage_sync:manual_review_queued",
        status: "queued",
        details: expect.objectContaining({
          projectNumber: "TP-NOHUB",
          currentStage: "Contract",
          previousStage: "Estimate in Progress",
          cycleId: "cycle-manual-review",
          reason: "unmapped_contract_no_hubspot_deal",
          mappingSource: "stage_mappings",
        }),
      })
    );

    fs.unlinkSync(xlsxPath);
  });

  it("refreshes an unresolved manual review queue entry for the same project and cycle", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-NOHUB", currentStage: "Estimate in Progress", projectName: "No HubSpot Project", metadata: {} } as any,
    ]);
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "bidboard_stage_sync",
      value: { cycleId: "cycle-dedupe" },
    } as any);
    vi.mocked(storage.getManualReviewQueueEntry)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        id: 1,
        projectNumber: "TP-NOHUB",
        cycleId: "cycle-dedupe",
        currentStage: "Contract",
        previousStage: "Estimate in Progress",
        createdAt: new Date("2026-05-01T10:00:00Z"),
        resolvedAt: null,
      } as any);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const firstXlsxPath = writeTempXlsx([
      { Name: "No HubSpot Project", Status: "Contract", "Project #": "TP-NOHUB", "Total Sales": 75000, "Customer Name": "Omega Inc" },
    ]);
    const secondXlsxPath = writeTempXlsx([
      { Name: "No HubSpot Project Updated", Status: "Contract", "Project #": "TP-NOHUB", "Total Sales": 75000, "Customer Name": "Omega Inc Updated" },
    ]);

    await diffBidBoardStages(firstXlsxPath);

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-NOHUB", currentStage: "Estimate Sent to Client", projectName: "No HubSpot Project Updated", metadata: {} } as any,
    ]);

    await diffBidBoardStages(secondXlsxPath);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.getManualReviewQueueEntry)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectNumber: "TP-NOHUB",
        projectName: "No HubSpot Project Updated",
        customer: "Omega Inc Updated",
        currentStage: "Contract",
        previousStage: "Estimate Sent to Client",
        cycleId: "cycle-dedupe",
      })
    );

    fs.unlinkSync(firstXlsxPath);
    fs.unlinkSync(secondXlsxPath);
  });

  it("skips re-queueing an already resolved manual review entry in the same cycle", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-NOHUB", currentStage: "Estimate in Progress", projectName: "No HubSpot Project", metadata: {} } as any,
    ]);
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "bidboard_stage_sync",
      value: { cycleId: "cycle-resolved" },
    } as any);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue({
      id: 1,
      projectNumber: "TP-NOHUB",
      cycleId: "cycle-resolved",
      currentStage: "Contract",
      previousStage: "Estimate in Progress",
      createdAt: new Date("2026-05-01T10:00:00Z"),
      resolvedAt: new Date("2026-05-01T10:30:00Z"),
      resolvedBy: "ops@example.com",
      resolutionNotes: "Handled manually",
    } as any);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const xlsxPath = writeTempXlsx([
      { Name: "No HubSpot Project", Status: "Contract", "Project #": "TP-NOHUB", "Total Sales": 75000, "Customer Name": "Omega Inc" },
    ]);

    await diffBidBoardStages(xlsxPath);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createManualReviewQueueEntry)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-NOHUB",
        projectName: "No HubSpot Project",
        action: "bidboard_stage_sync:manual_review_already_resolved_skip",
        status: "skipped",
        details: expect.objectContaining({
          projectNumber: "TP-NOHUB",
          currentStage: "Contract",
          previousStage: "Estimate in Progress",
          cycleId: "cycle-resolved",
          reason: "unmapped_contract_no_hubspot_deal",
          resolvedAt: expect.any(Date),
          resolvedBy: "ops@example.com",
        }),
      })
    );

    fs.unlinkSync(xlsxPath);
  });

  it("in migration mode still queues manual review for unmapped Portfolio trigger rows", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressPortfolioTriggers: true,
            logSuppressedActions: true,
            cycleId: "cycle-nohub-migration",
          },
        } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TP-NOHUB", currentStage: "Estimate in Progress", projectName: "No HubSpot Project", metadata: {} } as any,
    ]);
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "No HubSpot Project", Status: "Contract", "Project #": "TP-NOHUB", "Total Sales": 75000, "Customer Name": "Omega Inc" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(0);
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-NOHUB", currentStage: "Contract" })
    );
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectNumber: "TP-NOHUB",
        projectName: "No HubSpot Project",
        customer: "Omega Inc",
        currentStage: "Contract",
        previousStage: "Estimate in Progress",
        cycleId: "cycle-nohub-migration",
        reason: "unmapped_contract_no_hubspot_deal",
      })
    );
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-NOHUB",
        projectName: "No HubSpot Project",
        action: "bidboard_stage_sync:manual_review_queued",
        status: "queued",
        details: expect.objectContaining({
          cycleId: "cycle-nohub-migration",
          previousStage: "Estimate in Progress",
          currentStage: "Contract",
          reason: "unmapped_contract_no_hubspot_deal",
          mappingSource: "stage_mappings",
          mode: "migration",
        }),
      })
    );

    fs.unlinkSync(xlsxPath);
  });

  it("does NOT trigger portfolio automation when no HubSpot deal and stage is not a production stage", async () => {
    const { storage } = await import("../server/storage.ts");
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]);
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "Estimating Only", Status: "Estimate in Progress", "Project #": "TP-EST", "Total Sales": 0, "Customer Name": "Rho LLC" },
    ]);

    await diffBidBoardStages(xlsxPath);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();

    fs.unlinkSync(xlsxPath);
  });
});

describe("DB-driven BidBoard stage mapping", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("resolves a HubSpot stage label from stage_mappings before using hardcoded fallback", async () => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Estimate Under Review",
        hubspotStageLabel: "Internal Review From DB",
        direction: "bidirectional",
        isActive: true,
      } as any,
    ]);

    const result = await resolveBidBoardHubSpotStage("Estimate Under Review", {
      projectName: "Test Project",
      projectNumber: "TP-001",
      previousStage: "Estimate in Progress",
      cycleId: "cycle-map",
    });

    expect(result).toEqual({
      stageLabel: "Internal Review From DB",
      mappingSource: "stage_mappings",
      normalizedStage: "Estimate Under Review",
      triggerPortfolio: false,
    });
    expect(vi.mocked(storage.createBidboardAutomationLog)).not.toHaveBeenCalled();
  });

  it("prefers service HubSpot stage mapping for service project numbers", async () => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Closed Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: true,
      } as any,
      {
        procoreStageLabel: "Contract",
        hubspotStageLabel: "Service \u2013 Won",
        direction: "bidirectional",
        isActive: true,
        triggerPortfolio: true,
      } as any,
    ]);

    const result = await resolveBidBoardHubSpotStage("Contract", {
      projectName: "Service Project",
      projectNumber: "DFW-4-12326-aa",
      previousStage: "Service Estimating",
      cycleId: "cycle-map",
    });

    expect(result?.stageLabel).toBe("Service \u2013 Won");
    expect(result?.triggerPortfolio).toBe(true);
  });

  it.each([
    "Service Estimating",
    "Service - Estimating",
    "Service \u2013 Estimating",
    "Service   Estimating",
    "service estimating",
  ])('resolves service estimating alias "%s" to the same DB mapping row', async (stageLabel) => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Service - Estimating",
        hubspotStageLabel: "Service \u2013 Estimating",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: false,
      } as any,
    ]);

    const result = await resolveBidBoardHubSpotStage(stageLabel, {
      projectName: "Service Alias Project",
      projectNumber: "DFW-4-12326-aa",
      previousStage: "Estimate in Progress",
      cycleId: "cycle-alias",
    });

    expect(result).toEqual({
      stageLabel: "Service \u2013 Estimating",
      mappingSource: "stage_mappings",
      normalizedStage: "Service - Estimating",
      triggerPortfolio: false,
    });
  });

  it("uses hardcoded fallback when enabled and logs fallback usage with mapping source", async () => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "bidboard_stage_mapping",
      value: { allowHardcodedFallback: true },
    } as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const result = await resolveBidBoardHubSpotStage("Estimate Under Review", {
      projectName: "Fallback Project",
      projectNumber: "TP-FB",
      previousStage: "Estimate in Progress",
      cycleId: "cycle-map",
      canaryRunId: "canary-map",
    });

    expect(result?.stageLabel).toBe("Internal Review");
    expect(result?.mappingSource).toBe("hardcoded_fallback");
    expect(result?.triggerPortfolio).toBe(false);
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-FB",
        projectName: "Fallback Project",
        action: "bidboard_stage_sync:mapping_fallback_used",
        status: "warning",
        details: expect.objectContaining({
          cycleId: "cycle-map",
          canaryRunId: "canary-map",
          oldLabel: "Estimate Under Review",
          resolvedLabel: "Internal Review",
          mappingSource: "hardcoded_fallback",
        }),
      })
    );
  });

  it("does not use hardcoded fallback when fallback is disabled", async () => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([]);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      key: "bidboard_stage_mapping",
      value: { allowHardcodedFallback: false },
    } as any);

    const result = await resolveBidBoardHubSpotStage("Estimate Under Review", {
      projectName: "No Fallback Project",
      projectNumber: "TP-NOFB",
      previousStage: "Estimate in Progress",
      cycleId: "cycle-map",
    });

    expect(result).toBeNull();
    expect(vi.mocked(storage.createBidboardAutomationLog)).not.toHaveBeenCalled();
  });

  // Regression insurance (post-HubSpot): the live Bid Board label is "Won". Even when the
  // DB stage_mappings row for "Won" carries triggerPortfolio=false, the hardcoded fallback
  // must still treat it as a portfolio trigger so a future re-seed can't silently disable it.
  it('treats "Won" as a portfolio trigger via hardcoded fallback even when the DB row has triggerPortfolio false', async () => {
    const { storage } = await import("../server/storage.ts");
    const { resolveBidBoardHubSpotStage } = await import("../server/sync/stage-mapping.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([
      {
        procoreStageLabel: "Won",
        hubspotStageLabel: "Closed Won",
        direction: "bidboard_to_hubspot",
        isActive: true,
        triggerPortfolio: false,
      } as any,
    ]);

    const result = await resolveBidBoardHubSpotStage("Won", {
      projectName: "Won Fallback Project",
      projectNumber: "TRK-WON-FB",
      previousStage: "Estimate Sent to Client",
      cycleId: "cycle-won-fallback",
    });

    expect(result?.stageLabel).toBe("Closed Won");
    expect(result?.mappingSource).toBe("stage_mappings");
    expect(result?.triggerPortfolio).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Post-HubSpot: portfolio trigger decoupled from hubspotDealId
// ───────────────────────────────────────────────────────────────────────────
// HubSpot was operationally decommissioned. New Bid Board deals are source_system
// 'trock_crm' with hubspot_deal_id = NULL but a bidboard_project_id. The portfolio
// trigger must fire off Bid Board identity, NOT a HubSpot deal. manual_review_queue
// is reserved for deals with NO resolvable Procore/Bid Board identity at all.
// ═══════════════════════════════════════════════════════════════════════════
describe("Portfolio trigger decoupled from HubSpot (post-HubSpot)", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: true, allowlist: [] } } as any;
      }
      return undefined;
    });
  });

  const WON_TRIGGER_MAPPING = {
    procoreStageLabel: "Won",
    hubspotStageLabel: "Closed Won",
    direction: "bidboard_to_hubspot",
    isActive: true,
    triggerPortfolio: true,
  };

  it("diffBidBoardStages emits a change (not manual review) for a null-HubSpot trock_crm deal at Won when the mapping has a bidboard_project_id", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TRK-WON-1", currentStage: "Estimate Sent to Client", projectName: "CRM Won Project", metadata: {} } as any,
    ]);
    // trock_crm mapping: no HubSpot deal, but a Bid Board project id is present
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue({
      id: 900,
      sourceSystem: "trock_crm",
      sourceDealId: "crm-1",
      hubspotDealId: null,
      bidboardProjectId: "bb-900",
      procoreProjectNumber: "TRK-WON-1",
    } as any);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "CRM Won Project", Status: "Won", "Project #": "TRK-WON-1", "Total Sales": 12345, "Customer Name": "CRM Customer" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(1);
    expect(changes[0].newStage).toBe("Won");
    expect(changes[0].bidboardProjectId).toBe("bb-900");
    expect(changes[0].hubspotDealId).toBeFalsy();
    expect(vi.mocked(storage.createManualReviewQueueEntry)).not.toHaveBeenCalled();

    fs.unlinkSync(xlsxPath);
  });

  it("diffBidBoardStages still queues manual review for a Won deal with NO resolvable identity (no HubSpot deal AND no bidboard_project_id)", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "TRK-NOID", currentStage: "Estimate Sent to Client", projectName: "No Identity Project", metadata: {} } as any,
    ]);
    // A mapping exists but has neither a HubSpot deal nor a Bid Board project id → unusable
    vi.mocked(storage.getSyncMappingByProcoreProjectNumber).mockResolvedValue({
      id: 901,
      sourceSystem: "trock_crm",
      sourceDealId: "crm-2",
      hubspotDealId: null,
      bidboardProjectId: null,
      procoreProjectNumber: "TRK-NOID",
    } as any);
    vi.mocked(storage.getHubspotDealByProjectNumber).mockResolvedValue(undefined);
    vi.mocked(storage.getSyncMappings).mockResolvedValue([]);
    vi.mocked(storage.getHubspotDeals).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const xlsxPath = writeTempXlsx([
      { Name: "No Identity Project", Status: "Won", "Project #": "TRK-NOID", "Total Sales": 9999, "Customer Name": "Nobody" },
    ]);

    const changes = await diffBidBoardStages(xlsxPath);

    expect(changes).toHaveLength(0);
    expect(vi.mocked(storage.createManualReviewQueueEntry)).toHaveBeenCalledWith(
      expect.objectContaining({ projectNumber: "TRK-NOID", currentStage: "Won" })
    );

    fs.unlinkSync(xlsxPath);
  });

  it("syncStagesToHubSpot fires the portfolio trigger for a no-HubSpot Won change and skips ALL HubSpot writes/guards", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    // Even if these were callable, the no-HubSpot path must not touch them.
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const change = {
      projectName: "CRM Won Project",
      projectNumber: "TRK-WON-1",
      customerName: "CRM Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      bidboardProjectId: "bb-900",
      totalSales: 12345,
      synchubRecordId: "900",
    };

    const result = await syncStagesToHubSpot([change as any]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(getTerminalStageGuard)).not.toHaveBeenCalled();
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
    // sync state still advances so we don't reprocess every cycle
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TRK-WON-1", currentStage: "Won" })
    );
  });

  it("HubSpot kill-switch: with suppressHubSpotWrites in LIVE mode, skips HubSpot writes/guard but still fires the portfolio trigger for a Won change WITH a hubspotDealId", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage, updateHubSpotDeal } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "live",
            suppressHubSpotWrites: true,
            suppressPortfolioTriggers: false,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-killswitch",
          },
        } as any;
      }
      if (key === "bidboard_portfolio_trigger") {
        return { key, value: { enabled: true, allowlist: [] } } as any;
      }
      if (key === "bidboard_stage_mapping") {
        return { key, value: { allowHardcodedFallback: true } } as any;
      }
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const change = {
      projectName: "Legacy Won Project",
      projectNumber: "TP-LEGACY",
      customerName: "Legacy Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      hubspotDealId: "hs-legacy-1",
      bidboardProjectId: "bb-legacy",
      totalSales: 50000,
      synchubRecordId: "legacy",
    };

    const result = await syncStagesToHubSpot([change as any]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDeal)).not.toHaveBeenCalled();
    expect(vi.mocked(getTerminalStageGuard)).not.toHaveBeenCalled();
    expect(result.success).toBe(1);
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "bidboard_stage_sync:suppressed_hubspot_write" })
    );
  });

  it("no-HubSpot change at a NON-trigger stage advances state without firing the portfolio trigger", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    // "Estimate Under Review" is not a portfolio trigger stage.
    vi.mocked(storage.getStageMappings).mockResolvedValue([
      { procoreStageLabel: "Estimate Under Review", hubspotStageLabel: "Internal Review", direction: "bidboard_to_hubspot", isActive: true, triggerPortfolio: false } as any,
    ]);
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const change = {
      projectName: "CRM Estimating Project",
      projectNumber: "TRK-EST-1",
      customerName: "CRM Customer",
      previousStage: "Estimate in Progress",
      newStage: "Estimate Under Review",
      bidboardProjectId: "bb-est",
      totalSales: 1000,
      synchubRecordId: "est",
    };

    const result = await syncStagesToHubSpot([change as any]);

    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(result.success).toBe(1);
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TRK-EST-1", currentStage: "Estimate Under Review" })
    );
    expect(vi.mocked(storage.createBidboardAutomationLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TRK-EST-1",
        action: "bidboard_stage_sync",
        status: "success",
        details: expect.objectContaining({ portfolioTriggered: false, source: "bidboard_no_hubspot" }),
      })
    );
  });

  it("no-HubSpot change in dry-run mode counts a success but writes nothing and fires nothing", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);

    const change = {
      projectName: "CRM Won Project",
      projectNumber: "TRK-WON-1",
      customerName: "CRM Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      bidboardProjectId: "bb-900",
      totalSales: 1,
      synchubRecordId: "900",
    };

    const result = await syncStagesToHubSpot([change as any], { dryRun: true });

    expect(result.success).toBe(1);
    expect(vi.mocked(triggerPortfolioAutomationFromStageChange)).not.toHaveBeenCalled();
    expect(vi.mocked(storage.upsertBidboardSyncState)).not.toHaveBeenCalled();
  });

  it("no-HubSpot Won change whose portfolio trigger throws keeps the previous stage for cross-cycle retry", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]); // no prior attempts
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockRejectedValue(new Error("playwright boom"));

    const change = {
      projectName: "CRM Won Project",
      projectNumber: "TRK-WON-1",
      customerName: "CRM Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      bidboardProjectId: "bb-900",
      totalSales: 1,
      synchubRecordId: "900",
    };

    await syncStagesToHubSpot([change as any]);

    // Keep the previous stage so the next cycle re-detects the change and re-fires; track attempts.
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TRK-WON-1",
        currentStage: "Estimate Sent to Client",
        metadata: expect.objectContaining({ portfolioTriggerAttempts: 1 }),
      })
    );
  });

  it("kill-switch: a terminal-stage deal under suppressHubSpotWrites skips the terminal guard and advances without a regression error", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "live",
            suppressHubSpotWrites: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-killswitch-terminal",
          },
        } as any;
      }
      if (key === "bidboard_portfolio_trigger") return { key, value: { enabled: true, allowlist: [] } } as any;
      if (key === "bidboard_stage_mapping") return { key, value: { allowHardcodedFallback: true } } as any;
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    // The deal LOOKS terminal, but the guard must be SKIPPED (and never called) under the kill-switch.
    vi.mocked(getTerminalStageGuard).mockResolvedValue("Closed Won");
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "ok" });
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockResolvedValue(undefined as any);

    const change = {
      projectName: "Legacy Terminal Project",
      projectNumber: "TP-TERM",
      customerName: "Legacy Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      hubspotDealId: "hs-term-1",
      bidboardProjectId: "bb-term",
      totalSales: 5000,
      synchubRecordId: "term",
    };

    const result = await syncStagesToHubSpot([change as any]);

    expect(vi.mocked(getTerminalStageGuard)).not.toHaveBeenCalled();
    expect(result.errors.join(" ")).not.toMatch(/refusing stage regression/);
    expect(result.success).toBe(1);
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-TERM", currentStage: "Won" })
    );
  });

  // Codex P2: under the kill-switch, a legacy-HubSpot trigger-stage change whose Playwright
  // trigger THROWS must keep its previous stage so the edge-triggered diff re-fires it next
  // cycle — same cross-cycle retry the no-HubSpot and normal-write paths already do.
  it("kill-switch: a legacy-HubSpot Won change whose trigger throws keeps the previous stage for retry (does not advance under suppression)", async () => {
    const { triggerPortfolioAutomationFromStageChange } = await import("../server/playwright/portfolio-automation.ts");
    const { resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");
    const { storage } = await import("../server/storage.ts");
    const { syncStagesToHubSpot } = await import("../server/sync/bidboard-stage-sync.ts");

    vi.mocked(storage.getAutomationConfig).mockImplementation(async (key: string) => {
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "live",
            suppressHubSpotWrites: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-ks-retry",
          },
        } as any;
      }
      if (key === "bidboard_portfolio_trigger") return { key, value: { enabled: true, allowlist: [] } } as any;
      if (key === "bidboard_stage_mapping") return { key, value: { allowHardcodedFallback: true } } as any;
      return undefined;
    });
    vi.mocked(storage.getStageMappings).mockResolvedValue([WON_TRIGGER_MAPPING as any]);
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([]); // no prior attempts
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-cw", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
    vi.mocked(storage.upsertBidboardSyncState).mockResolvedValue({} as any);
    vi.mocked(storage.createBidboardAutomationLog).mockResolvedValue({} as any);
    vi.mocked(triggerPortfolioAutomationFromStageChange).mockRejectedValue(new Error("playwright boom"));

    const change = {
      projectName: "Legacy Won Project",
      projectNumber: "TP-KS-RETRY",
      customerName: "Legacy Customer",
      previousStage: "Estimate Sent to Client",
      newStage: "Won",
      hubspotDealId: "hs-ks-1",
      bidboardProjectId: "bb-ks",
      totalSales: 50000,
      synchubRecordId: "ks",
    };

    await syncStagesToHubSpot([change as any]);

    // Keep previous stage + track the attempt so the next cycle re-detects and re-fires.
    expect(vi.mocked(storage.upsertBidboardSyncState)).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "TP-KS-RETRY",
        currentStage: "Estimate Sent to Client",
        metadata: expect.objectContaining({ portfolioTriggerAttempts: 1 }),
      })
    );
    // Must NOT advance to "Won" — that would lose the retry under the edge-triggered diff.
    expect(vi.mocked(storage.upsertBidboardSyncState)).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TP-KS-RETRY", currentStage: "Won" })
    );
  });
});
