import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => vi.fn());

vi.mock("../server/index.ts", () => ({
  log: logMock,
}));

const {
  buildBidBoardCrmPayload,
  signBidBoardCrmPayload,
  pushBidBoardRowsToCrm,
} = await import("../server/sync/bidboard-crm-ingestion.ts");

describe("Bid Board CRM ingestion push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_BID_BOARD_SYNC_URL;
    delete process.env.BID_BOARD_SYNC_SECRET;
    vi.useFakeTimers();
  });

  it("builds the CRM payload with rows and provenance metadata", () => {
    const payload = buildBidBoardCrmPayload({
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }],
      sourceFilename: "/tmp/ProjectList.xlsx",
      extractedAt: "2026-04-28T15:00:00.000Z",
      officeSlug: "dallas",
    });

    expect(payload).toEqual({
      office_slug: "dallas",
      provenance: {
        sourceFilename: "ProjectList.xlsx",
        extractedAt: "2026-04-28T15:00:00.000Z",
        rowCount: 1,
      },
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }],
    });
  });

  it("signs payloads with sha256 HMAC compatible with CRM verification", () => {
    const body = JSON.stringify({ rows: [] });
    const signature = signBidBoardCrmPayload(body, "shared-secret");
    const expected = crypto.createHmac("sha256", "shared-secret").update(body).digest("hex");

    expect(signature).toBe(`sha256=${expected}`);
  });

  it("retries once after a failed POST and then succeeds", async () => {
    process.env.CRM_BID_BOARD_SYNC_URL = "https://crm.example.com/api/bid-board-sync/ingest";
    process.env.BID_BOARD_SYNC_SECRET = "shared-secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: vi.fn().mockResolvedValue("starting") })
      .mockResolvedValueOnce({ ok: true, status: 202, text: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetchMock);

    const promise = pushBidBoardRowsToCrm({
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress" }],
      sourceFilename: "/tmp/ProjectList.xlsx",
      extractedAt: "2026-04-28T15:00:00.000Z",
      officeSlug: "dallas",
      retryDelaysMs: [1],
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers["x-bid-board-sync-signature"]).toMatch(/^sha256=/);
  });

  it("logs and skips gracefully when CRM push env vars are missing", async () => {
    const result = await pushBidBoardRowsToCrm({
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress" }],
      sourceFilename: "/tmp/ProjectList.xlsx",
      extractedAt: "2026-04-28T15:00:00.000Z",
    });

    expect(result).toEqual({ ok: false, attempts: 0, skipped: true, error: "CRM Bid Board sync is not configured" });
    expect(logMock).toHaveBeenCalledWith(
      "[BidBoardCRM] CRM_BID_BOARD_SYNC_URL or BID_BOARD_SYNC_SECRET missing; skipping CRM ingestion push",
      "sync"
    );
  });
});
