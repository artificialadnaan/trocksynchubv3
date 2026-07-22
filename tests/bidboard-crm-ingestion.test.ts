import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => vi.fn());

vi.mock("../server/index.ts", () => ({
  log: logMock,
}));

const {
  buildBidBoardCrmPayload,
  signBidBoardCrmPayload,
  computeBidBoardIdempotencyKey,
  deriveBidBoardStatusUrl,
  pushBidBoardRowsToCrm,
} = await import("../server/sync/bidboard-crm-ingestion.ts");

const INGEST_URL = "https://crm.example.com/api/bid-board-sync/ingest";
const STATUS_URL = "https://crm.example.com/api/bid-board-sync/ingest/status";

type FetchResult = { ok: boolean; status: number; text?: () => Promise<string>; json?: () => Promise<any> };
function res(status: number, json?: any): FetchResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (json ? JSON.stringify(json) : ""),
    json: async () => json,
  };
}

const baseInput = {
  rows: [{ Name: "Palm Villas", Status: "Estimate in Progress" }] as any,
  sourceFilename: "/tmp/ProjectList.xlsx",
  extractedAt: "2026-04-28T15:00:00.000Z",
  officeSlug: "dallas",
  statusPollDelaysMs: [1, 1, 1],
};

describe("Bid Board CRM ingestion push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRM_BID_BOARD_SYNC_URL = INGEST_URL;
    process.env.BID_BOARD_SYNC_SECRET = "shared-secret";
  });

  it("builds the CRM payload with rows and provenance metadata", () => {
    const payload = buildBidBoardCrmPayload({
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }] as any,
      sourceFilename: "/tmp/ProjectList.xlsx",
      extractedAt: "2026-04-28T15:00:00.000Z",
      officeSlug: "dallas",
    });
    expect(payload).toEqual({
      office_slug: "dallas",
      provenance: { sourceFilename: "ProjectList.xlsx", extractedAt: "2026-04-28T15:00:00.000Z", rowCount: 1 },
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab" }],
    });
  });

  it("signs payloads with sha256 HMAC compatible with CRM verification", () => {
    const body = JSON.stringify({ rows: [] });
    const signature = signBidBoardCrmPayload(body, "shared-secret");
    expect(signature).toBe(`sha256=${crypto.createHmac("sha256", "shared-secret").update(body).digest("hex")}`);
  });

  it("computes the same idempotency key the CRM derives from the raw body", () => {
    const body = JSON.stringify({ office_slug: "dallas", rows: [1] });
    expect(computeBidBoardIdempotencyKey(body)).toBe(crypto.createHash("sha256").update(body).digest("hex"));
  });

  it("derives the status endpoint next to /ingest", () => {
    expect(deriveBidBoardStatusUrl(INGEST_URL)).toBe(STATUS_URL);
    expect(deriveBidBoardStatusUrl(INGEST_URL + "/")).toBe(STATUS_URL);
    // A configured query string must attach to the PATH, not corrupt into ".../ingest?version=2/status".
    expect(deriveBidBoardStatusUrl(INGEST_URL + "?version=2")).toBe(STATUS_URL + "?version=2");
  });

  it("a 2xx POST is durably accepted in a single request (no polling)", async () => {
    const fetchImpl = vi.fn(async () => res(202, { accepted: true, status: "queued" })) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: true, accepted: true, attempts: 1, ingestionStatus: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no status probe needed
    expect(fetchImpl.mock.calls[0][0]).toBe(INGEST_URL);
  });

  it("a deterministic 4xx (e.g. 401 bad signature) is a REJECTION — no status probe, no re-POST", async () => {
    const fetchImpl = vi.fn(async () => res(401)) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: false, accepted: false, rejected: true });
    expect(result.terminalFailure).toBeFalsy();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // exactly one POST; no probe, no re-POST
  });

  it("a 429 (rate limit) stays AMBIGUOUS and goes through the status probe (not a rejection)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === STATUS_URL ? res(200, { status: "processing" }) : res(429)
    ) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: true, accepted: true, ingestionStatus: "processing" });
    expect(result.rejected).toBeFalsy();
  });

  it("a gateway 502 followed by status=processing is treated as ACCEPTED (no re-POST, no failure)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === STATUS_URL) return res(200, { status: "processing" });
      return res(502); // ambiguous gateway response
    }) as any;

    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: true, accepted: true, attempts: 1, ingestionStatus: "processing" });
    expect(result.terminalFailure).toBeFalsy();
    // Exactly ONE POST to /ingest — the full payload was NOT re-sent.
    const ingestCalls = fetchImpl.mock.calls.filter((c: any[]) => c[0] === INGEST_URL);
    expect(ingestCalls).toHaveLength(1);
  });

  it("bounds EVERY CRM request (POST + status probe) with an abort deadline so a hung connection can't wedge the cycle", async () => {
    // The whole flow runs inside the stage-sync cycle (bidboardStageSyncRunning stays set for its duration). A
    // request that connects but never completes its response would otherwise await forever, so every later
    // interval would skip and neither the alert nor the HubSpot sync would run. 502 -> ambiguous -> probe says
    // processing -> accepted; the assertion is that the POST AND the probe each carry an AbortController signal.
    const fetchImpl = vi.fn(async (url: string) =>
      url === STATUS_URL ? res(200, { status: "processing" }) : res(502)
    ) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result.accepted).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2); // at least the POST + one probe
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal); // pre-fix this was undefined on both paths
    }
  });

  it("keeps the deadline armed through the BODY read — a response that stalls after headers is aborted, not hung", async () => {
    vi.useFakeTimers();
    try {
      // Headers arrive immediately (fetch resolves) but the body read never settles on its own — only the
      // AbortController deadline can end it. Pre-fix the timer was cleared the instant fetch() resolved, so the
      // callers' text()/json() reads awaited forever with the stage-sync cycle wedged.
      const stallUntilAbort = (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          else signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const fetchImpl = vi.fn((url: string, options: any) =>
        Promise.resolve({
          ok: url !== INGEST_URL, // POST -> non-2xx (reads the error body); probe -> 2xx (reads the json body)
          status: url === INGEST_URL ? 502 : 200,
          text: () => stallUntilAbort(options.signal),
          json: () => stallUntilAbort(options.signal),
        })
      ) as any;

      const promise = pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
      await vi.advanceTimersByTimeAsync(120_000); // drive past the POST deadline and every probe deadline
      const result = await promise;

      // It RETURNED (did not hang); no probe body ever resolved, so acceptance stays unconfirmed.
      expect(result.ok).toBe(false);
      expect(result.accepted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 502 followed by status=succeeded is ACCEPTED", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === STATUS_URL ? res(200, { status: "succeeded" }) : res(502)
    ) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: true, accepted: true, ingestionStatus: "succeeded" });
  });

  it("a 502 followed by status=failed is a TERMINAL failure (accepted but processing failed)", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === STATUS_URL ? res(200, { status: "failed", lastError: "schema drift" }) : res(500)
    ) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: false, accepted: true, terminalFailure: true, ingestionStatus: "failed" });
    expect(result.error).toContain("schema drift");
  });

  it("status=unknown triggers ONE bounded re-POST, and success there is ACCEPTED", async () => {
    let ingestPosts = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === STATUS_URL) return res(200, { status: "unknown" });
      ingestPosts++;
      // first POST ambiguous, the bounded re-POST succeeds
      return ingestPosts === 1 ? res(502) : res(202, { accepted: true, status: "queued" });
    }) as any;

    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: true, accepted: true, ingestionStatus: "accepted" });
    expect(ingestPosts).toBe(2); // exactly one bounded re-POST, not an unbounded loop
  });

  it("an unresolved ambiguity (always unknown, re-POST fails) is UNCONFIRMED — and re-POSTs EXACTLY once", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === STATUS_URL ? res(200, { status: "unknown" }) : res(502)
    ) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: false, accepted: false, ingestionStatus: "unknown" });
    expect(result.terminalFailure).toBeFalsy();
    // The re-POST quota is exactly one: initial POST + one bounded re-POST, never an unbounded storm even
    // though all three probes report 'unknown'.
    const ingestCalls = fetchImpl.mock.calls.filter((c: any[]) => c[0] === INGEST_URL);
    expect(ingestCalls).toHaveLength(2);
  });

  it("when the status endpoint itself is unreachable (5xx), it does NOT re-POST and reports UNCONFIRMED", async () => {
    // We can never confirm 'unknown', so re-POST is never triggered — the ambiguous 502 is surfaced as
    // unconfirmed (not a rollback), exactly one POST total.
    const fetchImpl = vi.fn(async (url: string) => (url === STATUS_URL ? res(500) : res(502))) as any;
    const result = await pushBidBoardRowsToCrm({ ...baseInput, fetchImpl });
    expect(result).toMatchObject({ ok: false, accepted: false, ingestionStatus: "unknown" });
    expect(result.terminalFailure).toBeFalsy();
    const ingestCalls = fetchImpl.mock.calls.filter((c: any[]) => c[0] === INGEST_URL);
    expect(ingestCalls).toHaveLength(1);
    expect(result.error).toBeTruthy();
  });

  it("logs and skips gracefully when CRM push env vars are missing", async () => {
    delete process.env.CRM_BID_BOARD_SYNC_URL;
    delete process.env.BID_BOARD_SYNC_SECRET;
    const result = await pushBidBoardRowsToCrm({
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress" }] as any,
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
