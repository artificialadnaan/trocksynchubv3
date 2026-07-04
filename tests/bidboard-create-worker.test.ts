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
const createSyncMappingMock = vi.hoisted(() => vi.fn(async (_m: any) => ({ id: 1 }) as any));
const getAutomationConfigMock = vi.hoisted(() => vi.fn(async (_k: string) => ({ value: { companyId: "42" } }) as any));
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
    getAutomationConfig: getAutomationConfigMock,
    getRfpApprovalRequestByProjectNumberAndStatus: getRfpByNumMock,
    getRfpApprovalRequestBySourceDealAndStatus: getRfpBySourceMock,
    getBidboardMappingByProcoreProjectNumber: getMappingMock,
    getSyncMappingBySourceDealId: getDealMappingMock,
    createSyncMapping: createSyncMappingMock,
    enqueueBidboardCallback: enqueueBidboardCallbackMock,
  },
}));

const { performCreateFromRfpVote, enqueueBidboardCreateCommand, claimNextBidboardCreateCommand, processBidboardCreateOutbox, CreatedMappingMissingError } =
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
    // A successful create PERSISTS the source-deal mapping (as the real createBidBoardProjectFromDeal does via
    // storage.createSyncMapping) — simulate that so perform's post-create mapping check (finding) passes.
    createBidBoardMock.mockReset();
    createBidBoardMock.mockImplementation(async () => {
      getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" } as any);
      return { success: true, projectId: "999" } as any;
    });
    enqueueBidboardCallbackMock.mockReset(); enqueueBidboardCallbackMock.mockResolvedValue({ id: 1 } as any);
    checkEligibilityMock.mockReset(); checkEligibilityMock.mockResolvedValue({ eligible: true } as any);
    getRfpByNumMock.mockReset(); getRfpByNumMock.mockResolvedValue(undefined);
    getRfpBySourceMock.mockReset(); getRfpBySourceMock.mockResolvedValue(undefined);
    getMappingMock.mockReset(); getMappingMock.mockResolvedValue(undefined);
    getDealMappingMock.mockReset(); getDealMappingMock.mockResolvedValue(undefined);
    createSyncMappingMock.mockReset(); createSyncMappingMock.mockResolvedValue({ id: 1 } as any);
    getAutomationConfigMock.mockReset(); getAutomationConfigMock.mockResolvedValue({ value: { companyId: "42" } } as any);
    delete process.env.PROCORE_COMPANY_ID;
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

  it("[S3] a conflicting APPROVED approval by project NUMBER -> failed callback, no create", async () => {
    getRfpByNumMock.mockImplementation(async (_p: string, s: string) => (s === "approved" ? { id: 7, status: "approved" } : undefined));
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("conflicting RFP approval");
  });

  it("[S4] a conflicting PENDING approval by SOURCE DEAL (not by number) -> failed callback, no create", async () => {
    // Exercise the getRfpBySourceMock arm of the guard's ?? chain, distinct from the by-number (S3) arm above.
    getRfpBySourceMock.mockImplementation(async (_ss: string, _sd: string, s: string) => (s === "pending" ? { id: 11, status: "pending" } : undefined));
    await performCreateFromRfpVote(input());
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("conflicting RFP approval");
    expect(getRfpBySourceMock).toHaveBeenCalledWith("trock_crm", "crm-deal-1", "pending");
  });

  it("[finding K] a create with NO Procore company id THROWS before enqueuing an unusable 'created' callback", async () => {
    getAutomationConfigMock.mockResolvedValue({ value: {} } as any); // no companyId
    delete process.env.PROCORE_COMPANY_ID; // and none from env
    // createBidBoardMock returns success (default) -> the project is created, but the 'created' callback enqueue
    // must throw (the CRM 422s a created with no procore_company_id). The throw keeps the command retryable.
    await expect(performCreateFromRfpVote(input())).rejects.toThrow(/company id/i);
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled();
  });

  it("[finding] a create whose sync mapping was NOT persisted THROWS (recoverable), sends no unguarded 'created'", async () => {
    // Simulate createBidBoardProjectFromDeal returning success while storage.createSyncMapping failed silently:
    // the project exists but no source-deal mapping was written.
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "999" } as any); // does NOT persist the mapping
    getDealMappingMock.mockResolvedValue(undefined); // mapping-first sees none AND the post-create verify sees none
    await expect(performCreateFromRfpVote(input())).rejects.toThrow(/mapping was not persisted/i);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // the guards can't protect an unmapped project
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
    expect(lastCallback().error).toContain("without a verified match");
  });

  it("[Y2] idempotent same-number retry ADOPTS the existing project (re-sends 'created', no Playwright re-run)", async () => {
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" });
    await performCreateFromRfpVote(input()); // input number TR-1001 == mapping number -> adopt
    expect(createBidBoardMock).not.toHaveBeenCalled(); // mapping-first short-circuits; no re-create
    expect(lastCallback().status).toBe("created");
    expect(lastCallback().bidboardProjectId).toBe("999"); // adopts the EXISTING project id
  });

  it("[F2] refuses to adopt when the existing mapping has NO recorded number but a number is requested (ambiguous)", async () => {
    // A legacy/partial or cross-path mapping with a null procoreProjectNumber: we can't confirm the existing project
    // is the one the CRM asked to create, so we must NOT silently adopt it under the requested number.
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "555", procoreProjectNumber: null });
    await performCreateFromRfpVote(input()); // input requests number TR-1001; stored number is null -> ambiguous
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("without a verified match");
  });

  it("[F3] REFUSES a service RFP (projectType '4') -> failed callback, no create in the non-service stage", async () => {
    await performCreateFromRfpVote(input({ deal: { name: "d", projectNumber: "TR-1001", projectType: "4", amount: 1, workflowRoute: "service" } }));
    expect(createBidBoardMock).not.toHaveBeenCalled(); // never reaches the hard-coded "Estimate in Progress" create
    expect(getDealMappingMock).not.toHaveBeenCalled(); // rejected BEFORE the mapping-first adopt
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("service RFP");
  });

  it("[F3] a NON-service RFP (projectType '9') is NOT rejected by the service guard (proceeds to create)", async () => {
    await performCreateFromRfpVote(input()); // projectType '9'
    expect(createBidBoardMock).toHaveBeenCalled();
    expect(lastCallback().status).toBe("created");
  });

  it("[finding] mapping-first adopt beats an ineligible recheck: a reclaim-after-create never reports a false failure", async () => {
    // A prior attempt created the project (mapping exists); markCreateCommandDone then failed and the command was
    // reclaimed. On the re-run the deal has since left Opportunity (ineligible) — but because the project already
    // exists, we must ADOPT (re-send 'created'), NOT emit a 'failed' callback.
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" });
    checkEligibilityMock.mockResolvedValue({ eligible: false, reason: "Deal left Opportunity" } as any);
    await performCreateFromRfpVote(input());
    expect(checkEligibilityMock).not.toHaveBeenCalled(); // mapping-first returns before the eligibility recheck
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("created");
    expect(lastCallback().bidboardProjectId).toBe("999");
  });

  it("[X4] supersedes prior PENDING voting callbacks with a SCOPED DELETE before enqueuing a new one", async () => {
    await performCreateFromRfpVote(input());
    const deleteSql = (dbHolder.db.execute as any).mock.calls
      .map((c: any[]) => JSON.stringify(c[0]))
      .find((s: string) => /DELETE FROM bidboard_callback_outbox/i.test(s));
    expect(deleteSql).toBeTruthy();
    // finding: the DELETE must be SCOPED — not an unscoped table wipe. Assert the row-selection criteria are present
    // (source_deal_id filter, NULL request id for voting rows, and status='pending'), not just the table name.
    expect(deleteSql).toMatch(/source_deal_id/i);
    expect(deleteSql).toMatch(/rfp_approval_request_id IS NULL/i);
    expect(deleteSql).toMatch(/status = 'pending'/i);
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
    // The drain catch now probes getSyncMappingBySourceDealId (a post-create failure must not emit a 'failed'
    // callback) — reset it to "no mapping" so the create-logic tests' mapping value can't leak in here.
    getDealMappingMock.mockReset(); getDealMappingMock.mockResolvedValue(undefined);
    createSyncMappingMock.mockReset(); createSyncMappingMock.mockResolvedValue({ id: 1 } as any);
    getAutomationConfigMock.mockReset(); getAutomationConfigMock.mockResolvedValue({ value: { companyId: "42" } } as any);
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

  it("does NOT disturb a DONE command on a re-delivery when its callback was DELIVERED (idempotent, no re-create)", async () => {
    await enqueueBidboardCreateCommand(input());
    await pg.query(`UPDATE bidboard_create_outbox SET status='done'`);
    // The created callback was delivered ('sent') — a duplicate delivery must stay a no-op.
    await pg.query(
      `INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
       VALUES ('trock_crm', 'crm-deal-1', NULL, '{"status":"created"}'::jsonb, 'http://crm/cb', 'sent')`
    );
    await enqueueBidboardCreateCommand(input());
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("done");
  });

  it("[finding] re-queues a DONE command whose created callback went DEAD/lost so the retry re-adopts + re-sends", async () => {
    await enqueueBidboardCreateCommand(input());
    await pg.query(`UPDATE bidboard_create_outbox SET status='done'`);
    // The created callback exhausted its retries -> 'dead' (no live pending/sent callback for the deal). A
    // same-sourceEventId retry must re-queue so the worker re-runs mapping-first adopt + enqueues a fresh callback.
    await pg.query(
      `INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
       VALUES ('trock_crm', 'crm-deal-1', NULL, '{"status":"created"}'::jsonb, 'http://crm/cb', 'dead')`
    );
    await enqueueBidboardCreateCommand(input());
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("pending"); // re-queued for callback recovery
  });

  it("[finding] a 'sent' FAILED callback does NOT block re-queue of a DONE command whose CREATED callback was lost", async () => {
    await enqueueBidboardCreateCommand(input());
    await pg.query(`UPDATE bidboard_create_outbox SET status='done'`);
    // An earlier attempt's 'failed' callback was delivered ('sent'); the later successful create's 'created'
    // callback was then lost. The live-callback check must look for CREATED callbacks only, so this sent FAILED
    // one must NOT block recovery — the retry re-queues to re-adopt + re-send the 'created' callback.
    await pg.query(
      `INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status)
       VALUES ('trock_crm', 'crm-deal-1', NULL, '{"status":"failed"}'::jsonb, 'http://crm/cb', 'sent')`
    );
    await enqueueBidboardCreateCommand(input());
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("pending"); // re-queued despite the sent FAILED callback
  });

  it("refreshes a still-PENDING command on a corrected re-delivery (payload + project_number + created_at receipt)", async () => {
    const mkDeal = (n: string) => ({ name: "d", projectNumber: n, projectType: "9", amount: 1, workflowRoute: "normal" });
    await enqueueBidboardCreateCommand(input({ deal: mkDeal("TR-1001") }));
    // Age the receipt so a refresh is observable, then a corrected re-post (same sourceEventId, revised number)
    // arrives BEFORE the worker claimed the pending row.
    await pg.query(`UPDATE bidboard_create_outbox SET created_at = NOW() - interval '1 hour'`);
    const before = (await pg.query(`SELECT created_at FROM bidboard_create_outbox`)).rows[0] as any;
    await enqueueBidboardCreateCommand(input({ deal: mkDeal("TR-2002") }));
    const rows = (await pg.query(`SELECT status, project_number, created_at, payload FROM bidboard_create_outbox`)).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].project_number).toBe("TR-2002"); // refreshed, not the stale first payload
    expect(rows[0].payload.deal.projectNumber).toBe("TR-2002");
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(new Date(before.created_at).getTime()); // receipt refreshed
  });

  it("[F4] supersedes an OLDER pending command for the SAME deal when a newer round is enqueued", async () => {
    // Round 1 for this deal is still pending (the worker hasn't claimed it). Round 2 (a new sourceEventId, revised
    // number) arrives -> the earlier pending command must be 'superseded' so the FIFO drain doesn't create round
    // 1's obsolete project first and then refuse round 2 on the same-deal revised-number guard.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-super-1", sourceDealId: "d-super", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-super-2", sourceDealId: "d-super", deal: { name: "d", projectNumber: "TR-2002", projectType: "9", workflowRoute: "normal" } }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-super-1").status).toBe("superseded"); // earlier round retired
    expect(rows.find((r) => r.source_event_id === "e-super-2").status).toBe("pending"); // only the latest remains
    // and a superseded row is NOT claimed by the drain — only the latest round runs.
    const perform = vi.fn(async () => {});
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("[F4] leaves an in-flight 'processing' same-deal command alone (can't cancel a live create)", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-live-1", sourceDealId: "d-live" }));
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing' WHERE source_event_id='e-live-1'`);
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-live-2", sourceDealId: "d-live" }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-live-1").status).toBe("processing"); // NOT superseded — owns it
    expect(rows.find((r) => r.source_event_id === "e-live-2").status).toBe("pending");
  });

  it("[finding] does NOT refresh a 'processing' row on a re-delivery (a live create owns it — never rewrite it)", async () => {
    const mkDeal = (n: string) => ({ name: "d", projectNumber: n, projectType: "9", amount: 1, workflowRoute: "normal" });
    await enqueueBidboardCreateCommand(input({ deal: mkDeal("TR-1001") }));
    // The worker claimed it (processing) and is mid-create — even a recent last_attempt_at is left alone now.
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing', last_attempt_at=NOW(), created_at=NOW() - interval '1 hour'`);
    const before = (await pg.query(`SELECT created_at FROM bidboard_create_outbox`)).rows[0] as any;
    await enqueueBidboardCreateCommand(input({ deal: mkDeal("TR-2002") })); // a corrected re-post arrives
    const rows = (await pg.query(`SELECT status, project_number, created_at, payload FROM bidboard_create_outbox`)).rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("processing"); // unchanged — the in-flight attempt owns it
    expect(rows[0].project_number).toBe("TR-1001"); // NOT refreshed to the corrected payload
    expect(rows[0].payload.deal.projectNumber).toBe("TR-1001");
    expect(new Date(rows[0].created_at).getTime()).toBe(new Date(before.created_at).getTime()); // receipt NOT bumped
  });

  it("[finding] the supersede DELETE spares a NEWER round's pending callback, removing only OLDER ones", async () => {
    // A NEWER round's still-pending callback (createdAt AFTER the one we're about to enqueue) — must survive.
    await pg.query(`INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status) VALUES ('trock_crm', 'crm-deal-1', NULL, '{"createdAt":"2026-07-03T15:00:00.000Z"}'::jsonb, 'http://crm/cb', 'pending')`);
    // An OLDER stale pending callback that SHOULD be superseded.
    await pg.query(`INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status) VALUES ('trock_crm', 'crm-deal-1', NULL, '{"createdAt":"2026-07-03T08:00:00.000Z"}'::jsonb, 'http://crm/cb', 'pending')`);
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" }); // adopt path
    // Enqueue a 'created' callback stamped 10:00 -> supersede only rows strictly OLDER than 10:00.
    await performCreateFromRfpVote(input(), "2026-07-03T10:00:00.000Z");
    const times = ((await pg.query(`SELECT payload->>'createdAt' AS c FROM bidboard_callback_outbox`)).rows as any[]).map((r) => r.c);
    expect(times).toContain("2026-07-03T15:00:00.000Z"); // newer round's callback NOT deleted
    expect(times).not.toContain("2026-07-03T08:00:00.000Z"); // older stale one superseded
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

  it("[finding J] a perform() that RETURNS 'failed' (pre-create refusal) marks the command 'failed', not 'done'", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-refuse", sourceDealId: "d-refuse" }));
    // perform took a pre-create terminal branch (ineligible / conflict / ownership) — it already sent a 'failed'
    // callback and created NO project, so the command must be marked terminal 'failed', never 'done'.
    const perform = vi.fn(async () => "failed" as const);
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("failed");
  });

  it("[finding] the terminal 'failed' bookkeeping RETRIES a transient error so a refused command lands 'failed' (never left create-capable)", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-retry", sourceDealId: "d-retry" }));
    // Make the FIRST status='failed' UPDATE throw (transient DB blip), then delegate to the real PGlite db.
    const realDb = dbHolder.db;
    let failMarkThrows = 0;
    dbHolder.db = {
      execute: async (q: any) => {
        if (/status = 'failed'/.test(JSON.stringify(q)) && failMarkThrows++ === 0) throw new Error("transient bookkeeping blip");
        return realDb.execute(q);
      },
    } as any;
    try {
      const perform = vi.fn(async () => "failed" as const);
      await processBidboardCreateOutbox({ performImpl: perform as any });
      const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
      expect(rows[0].status).toBe("failed"); // retried past the blip -> terminal, not left 'processing'
      expect(failMarkThrows).toBeGreaterThan(1); // proves the mark was retried
    } finally {
      dbHolder.db = realDb;
    }
  });

  it("a POST-create failure (mapping exists) is NOT marked failed and emits NO failed callback — left for reclaim", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-pc", sourceDealId: "d-pc" }));
    // The project was already created (a mapping exists), but perform then threw (e.g. the 'created' callback
    // persist failed). This must NOT flip the command to a false 'failed' result.
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "999", procoreProjectNumber: "TR-1001" });
    const perform = vi.fn(async () => { throw new Error("created-callback persist failed"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status, attempt_count FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("processing"); // left for the stale-reclaim, not 'failed'
    expect(rows[0].attempt_count).toBe(0); // finding: reset so callback-delivery recovery isn't capped by max_attempts
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // no false 'failed' callback
  });

  it("[finding] a mapping-LOOKUP error (indeterminate) is recoverable, not a false create failure", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-lookup", sourceDealId: "d-lookup" }));
    // perform threw, and the post-create mapping lookup ALSO errors -> we can't prove no project exists.
    getDealMappingMock.mockRejectedValue(new Error("mapping lookup db blip"));
    const perform = vi.fn(async () => { throw new Error("perform blew up"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status, attempt_count FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("processing"); // recoverable, not 'failed'
    expect(rows[0].attempt_count).toBe(0);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // no false 'failed' callback while indeterminate
  });

  it("[F1/F5] a created-but-UNMAPPED result that STAYS unmapped STOPS the drain (no later command runs) + leaves 'processing'", async () => {
    // The first (older) command's project is created but its mapping write keeps failing. A SECOND, newer command
    // for a DIFFERENT deal must NOT be drained while the first's project is unmapped — a later same-project command
    // could otherwise adopt the unlinked project for the wrong deal (F1). Reconcile is DIRECT (no perform re-run),
    // and on exhaustion the row is a RECOVERABLE 'processing' (never a 'failed' callback — the project exists, F5).
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-unmapped", sourceDealId: "d-unmapped" }));
    await pg.query(`UPDATE bidboard_create_outbox SET created_at = NOW() - interval '1 minute'`); // claimed first
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-after", sourceDealId: "d-after" }));
    createSyncMappingMock.mockRejectedValue(new Error("mapping write blip")); // the direct reconcile can't land
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-unmapped", bidboardProjectId: "999" } as any);
    const perform = vi.fn(async () => { throw err; });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT source_event_id, status, attempt_count FROM bidboard_create_outbox`)).rows as any[];
    const unmapped = rows.find((r) => r.source_event_id === "e-unmapped");
    const after = rows.find((r) => r.source_event_id === "e-after");
    expect(unmapped.status).toBe("processing"); // left for the stale-reclaim, not 'failed'
    expect(unmapped.attempt_count).toBe(0); // reset so it isn't capped by max_attempts
    expect(after.status).toBe("pending"); // F1: drain STOPPED — the later command was NOT run while unmapped
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // no 'failed' callback for a project that exists (F5)
    expect(perform).toHaveBeenCalledTimes(1); // only the first row ran; reconcile is DIRECT, not a perform re-run
    expect(createSyncMappingMock).toHaveBeenCalled(); // proves the direct mapping reconcile was attempted
  });

  it("[F6] a created-but-UNMAPPED result RECONCILES the mapping DIRECTLY (no perform re-run) -> 'done' + 'created' callback", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-recover", sourceDealId: "d-recover" }));
    // The project exists (id 999) but its mapping wasn't persisted. Recovery writes the mapping DIRECTLY from the
    // payload carried on the error — it must NOT re-run perform (which could create a SECOND project if the
    // exact-number lookup transiently errored). Then it sends the 'created' callback and marks the command 'done'.
    createSyncMappingMock.mockResolvedValue({ id: 7 } as any);
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-recover", bidboardProjectId: "999", procoreProjectNumber: "TR-1001" } as any);
    const perform = vi.fn(async () => { throw err; });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("done");
    expect(perform).toHaveBeenCalledTimes(1); // reconciled directly, NOT via a second perform (no double-create)
    expect(createSyncMappingMock).toHaveBeenCalledTimes(1); // the mapping was persisted directly
    expect(lastCallback().status).toBe("created"); // the 'created' callback was enqueued from recovery
  });

  it("a create failure whose FAILURE callback can't be enqueued stays retryable (processing), not terminal 'failed'", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-cbfail", sourceDealId: "d-cbfail" }));
    getDealMappingMock.mockResolvedValue(undefined); // genuine create failure — no project created
    urlHolder.url = null; // TROCK_CRM_BASE_URL unset -> enqueueFailedCallback throws (buildBidBoardCreatedCallbackTargetUrl null)
    const perform = vi.fn(async () => { throw new Error("playwright create failed"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT status, attempt_count FROM bidboard_create_outbox`)).rows as any[];
    expect(rows[0].status).toBe("processing"); // NOT 'failed' — claimNext would never re-pick a 'failed' row
    expect(rows[0].attempt_count).toBe(0); // reset so reclaim keeps re-attempting until the callback can be delivered
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
