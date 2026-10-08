/**
 * A Project # shared by two Bid Board rows (the 2026-10-08 LYV Austin DFW-1-25726-al loop): the sync state is keyed by
 * Project #, so the rows overwrote each other every cycle (Won <-> Estimate in Progress) and each flip back to Won
 * re-fired the portfolio automation. diffBidBoardStages must skip BOTH rows (no change, no state write) and flag the
 * number to manual review + one alert, deduped across cycles; other rows are unaffected.
 *
 * @module tests/bidboard-duplicate-project-number
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as XLSX from "xlsx";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getBidboardSyncStates: vi.fn(),
    upsertBidboardSyncState: vi.fn(),
    createBidboardAutomationLog: vi.fn(),
    getManualReviewQueueEntry: vi.fn(),
    getUnresolvedManualReviewQueueEntry: vi.fn(),
    createManualReviewQueueEntry: vi.fn(),
    getAutomationConfig: vi.fn(),
    createAuditLog: vi.fn(),
    getSyncMappings: vi.fn(),
    getSyncMappingByProcoreProjectNumber: vi.fn(),
    getSyncMappingByHubspotDealId: vi.fn(),
  },
}));
vi.mock("../server/playwright/portfolio-automation.ts", () => ({ triggerPortfolioAutomationFromStageChange: vi.fn() }));

function writeTempXlsx(rows: Record<string, unknown>[]): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Active Projects");
  const tmp = `/tmp/bidboard-dup-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`;
  fs.writeFileSync(tmp, Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })));
  return tmp;
}

const ROWS = [
  { Name: "LYV Austin Building 15 Plumbing repairs", Status: "Won", "Customer Name": "Tides Equities", "Project #": "DFW-1-25726-al", "Total Sales": 198071.43 },
  { Name: "LYV Austin", Status: "Estimate in Progress", "Customer Name": "Tides Equities", "Project #": "DFW-1-25726-al", "Total Sales": 0 },
  { Name: "Quiet Job", Status: "Won", "Customer Name": "Someone", "Project #": "DFW-1-00001-aa", "Total Sales": 10 },
];

describe("diffBidBoardStages with a duplicated Project #", () => {
  beforeEach(() => vi.resetAllMocks());

  it("skips both rows (no change, no state write) and flags the number once, deduped across cycles", async () => {
    const { storage } = await import("../server/storage.ts");
    const { diffBidBoardStages } = await import("../server/sync/bidboard-stage-sync.ts");
    // The stored state is whatever the last flip wrote; the quiet job is unchanged.
    vi.mocked(storage.getBidboardSyncStates).mockResolvedValue([
      { projectId: "DFW-1-25726-al", currentStage: "Won" },
      { projectId: "DFW-1-00001-aa", currentStage: "Won" },
    ] as any);
    vi.mocked(storage.getAutomationConfig).mockResolvedValue(undefined as any);
    vi.mocked(storage.getUnresolvedManualReviewQueueEntry).mockResolvedValue(undefined as any);
    vi.mocked(storage.getManualReviewQueueEntry).mockResolvedValue(undefined as any);
    vi.mocked(storage.createManualReviewQueueEntry).mockResolvedValue({} as any);
    const file = writeTempXlsx(ROWS);

    const changes = await diffBidBoardStages(file);
    expect(changes).toEqual([]);
    expect(storage.upsertBidboardSyncState).not.toHaveBeenCalled();
    expect(storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.createAuditLog).mock.calls[0]![0]).toMatchObject({
      action: "bidboard_stage_sync_duplicate_project_number",
      entityId: "DFW-1-25726-al",
      status: "error",
    });
    expect(storage.createManualReviewQueueEntry).toHaveBeenCalledTimes(1);

    // The next cycle: the review row is still unresolved, so no second alert or queue row.
    vi.mocked(storage.getUnresolvedManualReviewQueueEntry).mockResolvedValue({ id: 1 } as any);
    expect(await diffBidBoardStages(file)).toEqual([]);
    expect(storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(storage.createManualReviewQueueEntry).toHaveBeenCalledTimes(1);
    fs.unlinkSync(file);
  });
});
