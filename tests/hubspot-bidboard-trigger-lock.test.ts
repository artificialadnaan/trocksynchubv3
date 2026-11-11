import { beforeEach, describe, expect, it, vi } from "vitest";

// CONTRACT v2.2 §10 (S0b-1, path P4): the HubSpot trigger takes the per-deal lock and reads the Core footprint BEFORE its
// Playwright create, like every other create path. Core rows exist only for trock_crm deals, so for HubSpot this never
// fires in practice; the check is uniform anyway, and a Core footprint holds the create (no Playwright) with an alert.
// Synthetic data only (I7).
const lockMock = vi.hoisted(() => vi.fn(async (_tx: unknown, _dealId: string) => {}));
const coreFootprintMock = vi.hoisted(() => vi.fn(async (_tx: unknown, _sys: string, _dealId: string) => [] as string[]));
const createMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true, projectId: "900010", documentsUploaded: 0 })));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/sync/rfp-create-lock.ts", () => ({
  RFP_CREATE_LOCK_PREFIX: "rfp_create:",
  lockRfpCreateDeal: lockMock,
  readCoreFootprint: coreFootprintMock,
  readProcoreFootprint: vi.fn(async () => []),
}));
vi.mock("../server/db.ts", () => {
  const tx = { execute: vi.fn(async () => ({ rows: [] })) };
  return { db: { transaction: async (fn: (t: unknown) => unknown) => fn(tx), execute: tx.execute }, pool: undefined };
});
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createMock }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => (key === "hubspot_bidboard_auto_create" ? { value: { enabled: true } } : null)),
    getBidboardMappingBySourceDealId: vi.fn(async () => undefined),
    getSyncMappingByHubspotDealId: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async () => ({})),
  },
}));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { processDealStageChange, triggerBidBoardCreationForDeal } = await import("../server/hubspot-bidboard-trigger.ts");

const DEAL = "910000001";
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  lockMock.mockClear();
  coreFootprintMock.mockReset();
  coreFootprintMock.mockResolvedValue([]);
  createMock.mockClear();
  alertMock.mockClear();
});

describe("processDealStageChange (HubSpot stage trigger)", () => {
  it("takes the per-deal lock and reads the Core footprint BEFORE the Playwright create", async () => {
    await processDealStageChange(DEAL, "rfp");
    expect(lockMock).toHaveBeenCalledWith(expect.anything(), DEAL);
    expect(coreFootprintMock).toHaveBeenCalledWith(expect.anything(), "hubspot", DEAL);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]);
  });
  it("a Core-footprint check that ERRORS ⇒ no Playwright create, not triggered (core_footprint_check_failed), a visible core_preflight_error alert naming the deal and stage; never a silent rejection (CodeRabbit 4534112615)", async () => {
    coreFootprintMock.mockRejectedValue(new Error("synthetic footprint DB failure"));
    const res = await processDealStageChange(DEAL, "rfp").catch((e: any) => ({ threw: String(e?.message ?? e) }));
    expect(res).toEqual({ triggered: false, reason: "core_footprint_check_failed" });
    expect(createMock).not.toHaveBeenCalled();
    const call = alertMock.mock.calls.find((c) => c[0] === "core_preflight_error");
    expect(call?.[1]).toMatchObject({ sourceSystem: "hubspot", sourceDealId: DEAL, stage: "rfp", error: expect.stringContaining("synthetic footprint DB failure") });
  });
  it("a Core footprint for the deal ⇒ no Playwright create, not triggered (cross_destination_hold), alert", async () => {
    coreFootprintMock.mockResolvedValue(["core:sent"]);
    const out = await processDealStageChange(DEAL, "rfp");
    expect(createMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ triggered: false, reason: "cross_destination_hold" });
    expect(alertCodes()).toContain("cross_destination_hold");
  });
  it("no Core footprint ⇒ today's create, unchanged", async () => {
    const out = await processDealStageChange(DEAL, "rfp");
    expect(createMock).toHaveBeenCalledWith(DEAL, "Estimate in Progress", { syncDocuments: true });
    expect(out).toMatchObject({ triggered: true });
  });
});

describe("triggerBidBoardCreationForDeal (manual trigger)", () => {
  it("takes the per-deal lock and reads the Core footprint BEFORE the Playwright create", async () => {
    await triggerBidBoardCreationForDeal(DEAL);
    expect(lockMock).toHaveBeenCalledWith(expect.anything(), DEAL);
    expect(coreFootprintMock).toHaveBeenCalledWith(expect.anything(), "hubspot", DEAL);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]);
  });
  it("a Core footprint for the deal ⇒ no Playwright create, an error naming cross_destination_hold, alert", async () => {
    coreFootprintMock.mockResolvedValue(["core:sent"]);
    const out = await triggerBidBoardCreationForDeal(DEAL);
    expect(createMock).not.toHaveBeenCalled();
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/cross_destination_hold/);
    expect(alertCodes()).toContain("cross_destination_hold");
  });
  it("no Core footprint ⇒ today's create, unchanged", async () => {
    const out = await triggerBidBoardCreationForDeal(DEAL);
    expect(createMock).toHaveBeenCalledWith(DEAL, "Estimate in Progress", { syncDocuments: true });
    expect(out).toMatchObject({ success: true, projectId: "900010" });
  });
});
