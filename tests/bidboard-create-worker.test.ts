import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// ---- shared mocks for the create logic (performCreateFromRfpVote) ----
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "999" })));
const enqueueBidboardCallbackMock = vi.hoisted(() => vi.fn(async () => ({ id: 1 })));
const checkEligibilityMock = vi.hoisted(() => vi.fn(async () => ({ eligible: true }) as any));
const getRfpByNumMock = vi.hoisted(() => vi.fn(async (_p: string, _s: string) => undefined as any));
const getRfpBySourceMock = vi.hoisted(() => vi.fn(async (_ss: string, _sd: string, _s: string) => undefined as any));
const getMappingMock = vi.hoisted(() => vi.fn(async (_p: string) => undefined as any));
const getDealMappingMock = vi.hoisted(() => vi.fn(async (_ss: string, _sd: string) => undefined as any));
// A PGlite-backed db for the outbox lifecycle (enqueue/claim/mark). Set in beforeAll.
const dbHolder = vi.hoisted(() => ({ db: null as any }));
// Configurable callback target URL (X5 tests set it null).
const urlHolder = vi.hoisted(() => ({ url: "https://crm.example.com/api/internal/bid-board-created" as string | null }));

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
// pool is undefined here so processBidboardCreateOutbox skips the cross-instance advisory lock (X2) and drains
// directly — the lock path needs a real pg Pool, which PGlite isn't. The serial-drain behaviour is still tested.
vi.mock("../server/db.ts", () => ({ pool: undefined, get db() { return dbHolder.db; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createBidBoardMock }));
vi.mock("../server/rfp-approval.ts", () => ({ checkRfpApprovalSourceEligibility: checkEligibilityMock }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => urlHolder.url,
}));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })),
    getRfpApprovalRequestByProjectNumberAndStatus: getRfpByNumMock,
    getRfpApprovalRequestBySourceDealAndStatus: getRfpBySourceMock,
    getBidboardMappingByProcoreProjectNumber: getMappingMock,
    getSyncMappingBySourceDealId: getDealMappingMock,
    enqueueBidboardCallback: enqueueBidboardCallbackMock,
  },
}));

const { performCreateFromRfpVote, enqueueBidboardCreateCommand, claimNextBidboardCreateCommand, processBidboardCreateOutbox } =
  await import("../server/sync/bidboard-create-worker.ts");

function input(overrides: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: "crm-deal-1", sourceEventId: "crm:rfp-vote:approved:round-1", decision: "approved",
    deal: { name: "d", projectNumber: "TR-1001", projectType: "9", amount: 1, estimator: null, companyName: null, contactName: null, clientEmail: null, clientPhone: null, address: null, description: null, dueDate: null, workflowRoute: "normal" },
    attachments: [],
    ...overrides,
  } as any;
}
const lastCallback = () => (enqueueBidboardCallbackMock.mock.calls.at(-1)?.[0] as any)?.payload;

describe("performCreateFromRfpVote (create logic)", () => {
  beforeEach(() => {
    // enqueueCreateFromRfpCallback now DELETEs stale pending callbacks via getDb() (finding X4); stub it.
    dbHolder.db = { execute: vi.fn(async () => ({ rows: [] })) } as any;
    urlHolder.url = "https://crm.example.com/api/internal/bid-board-created";
    createBidBoardMock.mockReset(); createBidBoardMock.mockResolvedValue({ success: true, projectId: "999" } as any);
    enqueueBidboardCallbackMock.mockReset(); enqueueBidboardCallbackMock.mockResolvedValue({ id: 1 } as any);
    checkEligibilityMock.mockReset(); checkEligibilityMock.mockResolvedValue({ eligible: true } as any);
    getRfpByNumMock.mockReset(); getRfpByNumMock.mockResolvedValue(undefined);
    getRfpBySourceMock.mockReset(); getRfpBySourceMock.mockResolvedValue(undefined);
    getMappingMock.mockReset(); getMappingMock.mockResolvedValue(undefined);
    getDealMappingMock.mockReset(); getDealMappingMock.mockResolvedValue(undefined);
  });

  it("happy: creates + enqueues a durable 'created' callback (NULL rfpApprovalRequestId, keyed by sourceDealId)", async () => {
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    const enq = enqueueBidboardCallbackMock.mock.calls[0][0] as any;
    expect(enq.rfpApprovalRequestId).toBeNull();
    expect(enq.sourceDealId).toBe("crm-deal-1");
    expect(enq.payload.status).toBe("created");
    expect(enq.payload.bidboardProjectId).toBe("999");
  });

  it("[AA3] stamps the callback createdAt with the command receipt time, not now", async () => {
    const commandAt = "2026-07-03T14:00:00.000Z";
    await performCreateFromRfpVote(input(), commandAt);
    expect(enqueueBidboardCallbackMock.mock.calls[0][0].payload.createdAt).toBe(commandAt);
  });

  it("[T3/V4] rechecks eligibility immediately before the create: ineligible -> failed callback, no create", async () => {
    checkEligibilityMock.mockResolvedValueOnce({ eligible: false, reason: "no longer in Opportunity" } as any);
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("no longer in Opportunity");
  });

  it("[S3/S4] a conflicting approval (approved by number / pending by source deal) -> failed callback, no create", async () => {
    getRfpByNumMock.mockImplementation(async (_p: string, s: string) => (s === "approved" ? { id: 7, status: "approved" } : undefined));
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("conflicting RFP approval");
  });

  it("[V1] refuses when the project number is owned by another deal -> failed callback, no create", async () => {
    getMappingMock.mockResolvedValue({ sourceSystem: "trock_crm", sourceDealId: "other-deal", bidboardProjectId: "777" });
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("other-deal");
  });

  it("[X6] refuses when the SAME source deal already has an APPROVED RFP (revised project number) -> failed, no create", async () => {
    getRfpBySourceMock.mockImplementation(async (_ss: string, _sd: string, s: string) => (s === "approved" ? { id: 9, status: "approved" } : undefined));
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(getRfpBySourceMock).toHaveBeenCalledWith("trock_crm", "crm-deal-1", "approved");
  });

  it("[Y1] THROWS when createBidBoardProjectFromDeal returns success:false (so the command stays retryable, not done)", async () => {
    createBidBoardMock.mockResolvedValueOnce({ success: false, error: "playwright UI failure" } as any);
    await expect(performCreateFromRfpVote(input())).rejects.toThrow(/playwright UI failure/);
  });

  it("[Y2] refuses when this deal already has a BidBoard project under a DIFFERENT number -> failed callback, no create", async () => {
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "555", procoreProjectNumber: "TR-9999" });
    await performCreateFromRfpVote(input()); // input's number is TR-1001, mapping's is TR-9999
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("revised number");
  });

  it("[Y2] allows the idempotent same-number retry (mapping number == requested number)", async () => {
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" });
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).toHaveBeenCalledTimes(1); // same number -> falls through to the adopt-guard
  });

  it("[X4] supersedes prior PENDING voting callbacks (DELETE) before enqueuing a new one", async () => {
    await performCreateFromRfpVote(input());
    const executed = (dbHolder.db.execute as any).mock.calls.map((c: any[]) => JSON.stringify(c[0])).join(" ");
    expect(executed).toMatch(/DELETE FROM bidboard_callback_outbox/i);
    expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1);
  });

  it("[X5] THROWS (so the command stays retryable, not 'done') when the callback URL is missing", async () => {
    urlHolder.url = null;
    await expect(performCreateFromRfpVote(input())).rejects.toThrow(/TROCK_CRM_BASE_URL/);
    // the project was created but the callback couldn't be enqueued -> throw -> command marked failed upstream
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled();
  });
});

// ---- outbox lifecycle (V3 durability + idempotency) on PGlite ----
describe("bidboard_create_outbox lifecycle (real SQL)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE bidboard_create_outbox (
        id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
        source_event_id text NOT NULL UNIQUE, project_number text, payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempt_count int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
        last_error text, last_attempt_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
      );
      -- enqueueCreateFromRfpCallback DELETEs stale pending rows here (X4) before enqueuing.
      CREATE TABLE bidboard_callback_outbox (
        id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
        rfp_approval_request_id integer, payload jsonb NOT NULL, target_url text NOT NULL,
        status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    dbHolder.db = drizzle(pg);
  });
  afterAll(async () => { await pg?.close?.(); });
  beforeEach(async () => {
    await pg.exec(`DELETE FROM bidboard_create_outbox; DELETE FROM bidboard_callback_outbox;`);
    enqueueBidboardCallbackMock.mockReset();
    urlHolder.url = "https://crm.example.com/api/internal/bid-board-created";
  });

  it("[V3] enqueue persists a pending command; a duplicate sourceEventId is idempotent (no second row)", async () => {
    await enqueueBidboardCreateCommand(input());
    await enqueueBidboardCreateCommand(input()); // same sourceEventId
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("re-queues a FAILED command on a re-delivery (the CRM's rep-retry re-POSTs the same sourceEventId)", async () => {
    await enqueueBidboardCreateCommand(input());
    await pg.query(`UPDATE bidboard_create_outbox SET status='failed', last_error='boom'`);
    await enqueueBidboardCreateCommand(input()); // re-delivery of the same event
    const rows = (await pg.query(`SELECT status, last_error, attempt_count FROM bidboard_create_outbox`)).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending"); // re-queued
    expect(rows[0].last_error).toBeNull();
  });

  it("does NOT disturb a DONE command on a re-delivery (idempotent, no re-create)", async () => {
    await enqueueBidboardCreateCommand(input());
    await pg.query(`UPDATE bidboard_create_outbox SET status='done'`);
    await enqueueBidboardCreateCommand(input());
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("done");
  });

  it("processBidboardCreateOutbox claims + drains pending commands serially and marks them done", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e1", sourceDealId: "d1" }));
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e2", sourceDealId: "d2" }));
    const perform = vi.fn(async () => {});
    const { processed } = await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(processed).toBe(2);
    expect(perform).toHaveBeenCalledTimes(2);
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox ORDER BY id`)).rows as any[];
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("marks a command FAILED (and enqueues a failed callback) when perform throws", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e9", sourceDealId: "d9" }));
    const perform = vi.fn(async () => { throw new Error("playwright boom"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status, last_error FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toContain("playwright boom");
    // best-effort failed callback so the CRM isn't left waiting
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("playwright boom");
  });

  it("claimNextBidboardCreateCommand returns null when nothing is pending", async () => {
    expect(await claimNextBidboardCreateCommand()).toBeNull();
  });

  it("[X3] re-claims a STALE 'processing' row (worker crashed after claim) but not a fresh one", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-stale", sourceDealId: "d-stale" }));
    // Fresh processing (just claimed) — must NOT be re-claimed.
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing', last_attempt_at=NOW()`);
    expect(await claimNextBidboardCreateCommand()).toBeNull();
    // Stale processing (claimed >10m ago, crashed before done/failed) — re-claimed.
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing', last_attempt_at=NOW() - interval '20 minutes'`);
    const reclaimed = await claimNextBidboardCreateCommand();
    expect(reclaimed?.source_event_id).toBe("e-stale");
  });
});
