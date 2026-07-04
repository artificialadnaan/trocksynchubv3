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
const getMappingByBidIdMock = vi.hoisted(() => vi.fn(async (_id: string) => undefined as any));
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
    getSyncMappingByBidboardProjectId: getMappingByBidIdMock,
    createSyncMapping: createSyncMappingMock,
    enqueueBidboardCallback: enqueueBidboardCallbackMock,
  },
}));

const { performCreateFromRfpVote, enqueueBidboardCreateCommand, claimNextBidboardCreateCommand, processBidboardCreateOutbox, CreatedMappingMissingError, UnconfirmedCreateError } =
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
    createBidBoardMock.mockImplementation(async (args: any) => {
      // A successful create PERSISTS the mapping for the CREATED project id, owned by THIS deal — the post-create
      // check now verifies by project id + owner (not by source deal), so set getSyncMappingByBidboardProjectId too.
      const mapping = { bidboardProjectId: "999", procoreProjectNumber: "TR-1001", sourceSystem: args?.sourceSystem ?? "trock_crm", sourceDealId: args?.sourceDealId ?? "crm-deal-1" };
      getDealMappingMock.mockResolvedValue(mapping as any);
      getMappingByBidIdMock.mockResolvedValue(mapping as any);
      return { success: true, projectId: "999" } as any;
    });
    enqueueBidboardCallbackMock.mockReset(); enqueueBidboardCallbackMock.mockResolvedValue({ id: 1 } as any);
    checkEligibilityMock.mockReset(); checkEligibilityMock.mockResolvedValue({ eligible: true } as any);
    getRfpByNumMock.mockReset(); getRfpByNumMock.mockResolvedValue(undefined);
    getRfpBySourceMock.mockReset(); getRfpBySourceMock.mockResolvedValue(undefined);
    getMappingMock.mockReset(); getMappingMock.mockResolvedValue(undefined);
    getDealMappingMock.mockReset(); getDealMappingMock.mockResolvedValue(undefined);
    getMappingByBidIdMock.mockReset(); getMappingByBidIdMock.mockResolvedValue(undefined);
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
    expect(lastCallback()).toBeUndefined(); // perform itself sends no callback on a genuine failure; the drain does
  });

  it("[F14] an UNCONFIRMED create ('Could not confirm project creation') throws UnconfirmedCreateError, not a generic failure", async () => {
    // The UI click may have created a project but confirmation failed -> indeterminate, NOT a genuine no-project
    // failure. perform must throw the recoverable sentinel (the drain then parks it 'needs_manual' + sends NO
    // 'failed' callback) instead of a generic Error that would route to the terminal failed-callback path.
    createBidBoardMock.mockReset();
    createBidBoardMock.mockResolvedValue({ success: false, error: "Could not confirm project creation" } as any);
    await expect(performCreateFromRfpVote(input())).rejects.toBeInstanceOf(UnconfirmedCreateError);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // no callback for an indeterminate outcome
  });

  it("[I4] the post-create check verifies by the CREATED project id + owner, not any source-deal mapping row", async () => {
    createBidBoardMock.mockReset();
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "999" } as any); // create OK
    getDealMappingMock.mockResolvedValue(undefined); // no mapping-first adopt
    // (a) project 999's mapping was NOT persisted -> must stay recoverable, NOT falsely report created
    getMappingByBidIdMock.mockResolvedValue(undefined);
    await expect(performCreateFromRfpVote(input())).rejects.toBeInstanceOf(CreatedMappingMissingError);
    // (b) project 999 got mapped to ANOTHER deal -> also not accepted as ours (routes to owner-mismatch recovery)
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "999" } as any);
    getMappingByBidIdMock.mockResolvedValue({ bidboardProjectId: "999", sourceSystem: "trock_crm", sourceDealId: "someone-else" } as any);
    await expect(performCreateFromRfpVote(input())).rejects.toBeInstanceOf(CreatedMappingMissingError);
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // never a 'created' for an unverified/other-owned project
  });

  it("[P2-A/P2-C] REFUSES to create when a SIBLING outbox row for the same deal is in recovery (blocks a duplicate)", async () => {
    // A prior round for this deal created a project we can't yet see (its sibling row is 'reclaiming'/'needs_manual').
    // Creating now would DUPLICATE it, so the sibling-recovery guard refuses BEFORE createBidBoardProjectFromDeal —
    // independent of drain order / attempt_count.
    dbHolder.db = { execute: vi.fn(async (q: any) => {
      if (/status IN \('reclaiming', 'needs_manual'\)/.test(JSON.stringify(q))) return { rows: [{ status: "reclaiming", recovered_project_id: "999" }] };
      return { rows: [] };
    }) } as any;
    const outcome = await performCreateFromRfpVote(input());
    expect(outcome).toBe("failed");
    expect(createBidBoardMock).not.toHaveBeenCalled(); // never reached the create — no duplicate
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("unresolved prior create round");
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
    await performCreateFromRfpVote(input()); // projectType '9', number TR-1001 (no DFW type digit)
    expect(createBidBoardMock).toHaveBeenCalled();
    expect(lastCallback().status).toBe("created");
  });

  it("[F10] REFUSES a service RFP identified by the project NUMBER digit even when projectType is stale/non-4", async () => {
    // The project number's type digit is canonical: DFW-4-… is service even though project_types says '9'.
    await performCreateFromRfpVote(input({ deal: { name: "d", projectNumber: "DFW-4-25001-aa", projectType: "9", amount: 1, workflowRoute: "normal" } }));
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("service RFP");
  });

  it("[F10] a NON-service project NUMBER digit (DFW-9-…) proceeds to create", async () => {
    await performCreateFromRfpVote(input({ deal: { name: "d", projectNumber: "DFW-9-25001-aa", projectType: "9", amount: 1, workflowRoute: "normal" } }));
    expect(createBidBoardMock).toHaveBeenCalled();
    expect(lastCallback().status).toBe("created");
  });

  it("[G4] forwards the CANONICAL project type (from the number digit) to the create, not the stale projectType", async () => {
    await performCreateFromRfpVote(input({ deal: { name: "d", projectNumber: "DFW-2-25001-aa", projectType: "9", amount: 1, workflowRoute: "normal" } }));
    expect(createBidBoardMock).toHaveBeenCalled();
    const arg = (createBidBoardMock.mock.calls.at(-1) as any)[0];
    expect(arg.normalizedDealData.project_types).toBe("2"); // canonical digit from DFW-2-…, NOT the stale "9"
  });

  it("[H1] recognizes a NON-DFW (ATL-4-…) service number and refuses it, even with a stale projectType", async () => {
    await performCreateFromRfpVote(input({ deal: { name: "d", projectNumber: "ATL-4-25001-aa", projectType: "9", amount: 1, workflowRoute: "normal" } }));
    expect(createBidBoardMock).not.toHaveBeenCalled(); // ATL-4 parsed as service -> refused (was mis-routed when DFW-only)
    expect(lastCallback().status).toBe("failed");
    expect(lastCallback().error).toContain("service RFP");
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
    getMappingByBidIdMock.mockReset(); getMappingByBidIdMock.mockResolvedValue(undefined);
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
    await pg.query(`UPDATE bidboard_create_outbox SET created_at = NOW() - interval '1 hour' WHERE source_event_id='e-super-1'`); // an earlier round
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-super-2", sourceDealId: "d-super", deal: { name: "d", projectNumber: "TR-2002", projectType: "9", workflowRoute: "normal" } }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-super-1").status).toBe("superseded"); // earlier round retired
    expect(rows.find((r) => r.source_event_id === "e-super-2").status).toBe("pending"); // only the latest remains
    // and a superseded row is NOT claimed by the drain — only the latest round runs.
    const perform = vi.fn(async () => {});
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("[F9] a LATE duplicate of an OLDER event does NOT supersede the newer pending round", async () => {
    // Round 1 pending, then round 2 arrives (supersedes round 1). A late duplicate delivery of round 1 then lands:
    // its ON CONFLICT is a no-op (row already 'superseded'), so it must NOT retire round 2 (the latest approved
    // vote) — else the deal strands with no pending command to create its project.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-r1", sourceDealId: "d-late", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    await pg.query(`UPDATE bidboard_create_outbox SET created_at = NOW() - interval '1 hour' WHERE source_event_id='e-r1'`);
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-r2", sourceDealId: "d-late", deal: { name: "d", projectNumber: "TR-2002", projectType: "9", workflowRoute: "normal" } }));
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox WHERE source_event_id='e-r1'`)).rows[0]).toMatchObject({ status: "superseded" });
    // The late duplicate of round 1 (already 'superseded') re-arrives:
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-r1", sourceDealId: "d-late", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-r1").status).toBe("superseded"); // stays retired (no-op re-queue)
    expect(rows.find((r) => r.source_event_id === "e-r2").status).toBe("pending"); // the newer round SURVIVES
  });

  it("[F9/H2] re-queuing a FAILED older round is BLOCKED while a newer same-deal round is pending", async () => {
    // The subtle case: round 1 was 'processing' (so round 2's enqueue could not supersede it), then FAILED, while
    // round 2 stayed pending. A rep re-post of the OLDER round 1 must NOT flip it back to pending (it would drain
    // first by id order and create round 1's obsolete number, then round 2 gets Y2-refused). The enqueue's ON
    // CONFLICT skips the re-queue because a newer (higher-id) active same-deal round exists — round 1 stays 'failed'
    // and round 2 remains the one that drains.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-fq1", sourceDealId: "d-fq", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing' WHERE source_event_id='e-fq1'`); // claimed before round 2
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-fq2", sourceDealId: "d-fq", deal: { name: "d", projectNumber: "TR-2002", projectType: "9", workflowRoute: "normal" } }));
    await pg.query(`UPDATE bidboard_create_outbox SET status='failed' WHERE source_event_id='e-fq1'`); // round 1's create fails
    // Rep re-posts round 1 (older sourceEventId):
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-fq1", sourceDealId: "d-fq", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-fq1").status).toBe("failed"); // re-queue BLOCKED — stays failed
    expect(rows.find((r) => r.source_event_id === "e-fq2").status).toBe("pending"); // the newer round remains the one that drains
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

  it("[F1/F5/F15] a created-but-UNMAPPED result that STAYS unmapped STOPS the drain + parks 'reclaiming' (blocks later, keeps project id)", async () => {
    // The first (lower-id) command's project 999 is created but its mapping write keeps failing. A later command
    // must NOT drain while 999 is unmapped — it could adopt the unlinked project for the wrong deal (F1). Reconcile
    // is DIRECT (no perform re-run); on exhaustion the row is RECOVERABLE — never a 'failed' callback (the project
    // exists, F5) — and is parked at status 'reclaiming' (NOT 'pending', so a newer same-deal round can't supersede
    // it), carrying the created project id in its payload so the next tick reconciles by id (F15).
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-unmapped", sourceDealId: "d-unmapped" }));
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-after", sourceDealId: "d-after" }));
    createSyncMappingMock.mockRejectedValue(new Error("mapping write blip")); // the direct reconcile can't land
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-unmapped", bidboardProjectId: "999" } as any);
    const perform = vi.fn(async () => { throw err; });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    const rows = (await pg.query(`SELECT source_event_id, status, payload FROM bidboard_create_outbox`)).rows as any[];
    const unmapped = rows.find((r) => r.source_event_id === "e-unmapped");
    const after = rows.find((r) => r.source_event_id === "e-after");
    expect(unmapped.status).toBe("reclaiming"); // distinct, non-supersedable, id-ordered-blocking status
    expect(unmapped.payload.__recoveredProjectId).toBe("999"); // project id persisted so it reconciles across ticks
    expect(after.status).toBe("pending"); // F1: drain STOPPED — the later command was NOT run while unmapped
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // no 'failed' callback for a project that exists (F5)
    expect(perform).toHaveBeenCalledTimes(1); // only the first row ran; reconcile is DIRECT, not a perform re-run
    expect(createSyncMappingMock).toHaveBeenCalled(); // proves the direct mapping reconcile was attempted
  });

  it("[P2-A] a newer same-deal round does NOT supersede a 'reclaiming' recovery row (no orphan/duplicate)", async () => {
    // Round 1 created project 999 but can't map it -> parked 'reclaiming'. The rep re-reviews the SAME deal and
    // approves round 2 (revised number). The supersede must NOT retire the reclaiming row (that would orphan 999 and
    // let round 2 create a duplicate); it stays 'reclaiming' and round 2 queues behind it.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-r1", sourceDealId: "d-sup", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    createSyncMappingMock.mockRejectedValue(new Error("mapping write blip"));
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-sup", bidboardProjectId: "999" } as any);
    await processBidboardCreateOutbox({ performImpl: (vi.fn(async () => { throw err; })) as any });
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox WHERE source_event_id='e-r1'`)).rows[0].status).toBe("reclaiming");
    // Now round 2 for the SAME deal arrives (revised number):
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-r2", sourceDealId: "d-sup", deal: { name: "d", projectNumber: "TR-2002", projectType: "9", workflowRoute: "normal" } }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-r1").status).toBe("reclaiming"); // NOT superseded — project 999 preserved
    expect(rows.find((r) => r.source_event_id === "e-r2").status).toBe("pending"); // round 2 queues behind it
  });

  it("[F15] a 'reclaiming' row is re-claimed and RECONCILED by its persisted project id on the next tick (no re-perform)", async () => {
    // Simulate a row parked 'reclaiming' from a prior tick (project 999 created, mapping missing). The next drain
    // must reconcile by the persisted id WITHOUT calling perform (which could double-create), then mark it done.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-reclaim", sourceDealId: "d-reclaim" }));
    await pg.query(`UPDATE bidboard_create_outbox SET status='reclaiming', payload = jsonb_set(payload, '{__recoveredProjectId}', to_jsonb('999'::text)) WHERE source_event_id='e-reclaim'`);
    getMappingByBidIdMock.mockResolvedValue(undefined); // 999 still unmapped
    createSyncMappingMock.mockResolvedValue({ id: 5 } as any); // this tick the write lands
    const perform = vi.fn(async () => { throw new Error("perform must NOT be called for a reclaiming row"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).not.toHaveBeenCalled(); // reconciled by stored id, never re-performed
    expect(getMappingByBidIdMock).toHaveBeenCalledWith("999");
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows[0].status).toBe("done");
    expect(lastCallback().bidboardProjectId).toBe("999");
  });

  it("[fix-a] a 'reclaiming' row whose reconcile keeps failing ESCALATES to 'needs_manual' on its last attempt (surfaced)", async () => {
    // A reclaiming row one claim short of max_attempts: this claim reconciles-fails, and because it can no longer be
    // re-claimed (attempt_count would hit max), it escalates to 'needs_manual' instead of sitting 'reclaiming'
    // silently. (The sibling-recovery guard keeps blocking a fresh same-deal create either way.)
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-exh", sourceDealId: "d-exh" }));
    await pg.query(`UPDATE bidboard_create_outbox SET status='reclaiming', attempt_count=4, max_attempts=5, payload = jsonb_set(payload, '{__recoveredProjectId}', to_jsonb('999'::text)) WHERE source_event_id='e-exh'`);
    getMappingByBidIdMock.mockResolvedValue(undefined);
    createSyncMappingMock.mockRejectedValue(new Error("mapping write still failing"));
    await processBidboardCreateOutbox({ performImpl: (vi.fn(async () => { throw new Error("perform must not run"); })) as any });
    const row = (await pg.query(`SELECT status, payload FROM bidboard_create_outbox`)).rows[0] as any;
    expect(row.status).toBe("needs_manual"); // escalated (was 'reclaiming', attempts exhausted)
    expect(row.payload.__recoveredProjectId).toBe("999"); // project id preserved for the operator
  });

  it("[G2] mapping persisted but the 'created' callback can't enqueue -> UNCAPPED 'processing' reclaim, NOT capped needs_manual", async () => {
    // The mapping write SUCCEEDS (project is now guarded), but enqueueCreatedCallback throws (no procore company id).
    // That must NOT be treated as a mapping-reconcile failure that caps at max_attempts -> needs_manual; route it to
    // the uncapped post-create callback-delivery reclaim ('processing', attempt_count reset) so a config fix later
    // still delivers the 'created' callback.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-cbp", sourceDealId: "d-cbp" }));
    getMappingByBidIdMock.mockResolvedValue(undefined); // mapping not yet present -> reconcile writes it
    createSyncMappingMock.mockResolvedValue({ id: 3 } as any); // mapping write SUCCEEDS
    getAutomationConfigMock.mockResolvedValue({ value: {} } as any); // no companyId -> enqueueCreatedCallback throws
    delete process.env.PROCORE_COMPANY_ID;
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-cbp", bidboardProjectId: "999" } as any);
    await processBidboardCreateOutbox({ performImpl: (vi.fn(async () => { throw err; })) as any });
    const row = (await pg.query(`SELECT status, attempt_count FROM bidboard_create_outbox`)).rows[0] as any;
    expect(row.status).toBe("processing"); // uncapped callback-delivery reclaim, NOT 'reclaiming'/'needs_manual'
    expect(Number(row.attempt_count)).toBe(0); // reset so callback delivery isn't capped by max_attempts
    expect(createSyncMappingMock).toHaveBeenCalled(); // the mapping WAS persisted (project guarded)
  });

  it("[G3] the sibling-recovery guard also matches a DIFFERENT deal with the SAME project number (defense-in-depth)", async () => {
    // A prior round for deal A is 'needs_manual' with project_number TR-1001. A fresh create for deal B reusing
    // TR-1001 must be refused (the unmapped project is invisible to the mapping ownership guard).
    await pg.query(`INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status) VALUES ('trock_crm','deal-A','e-A','TR-1001','{}'::jsonb,'needs_manual')`);
    dbHolder.db = drizzle(pg as any) as any; // real db so findSiblingRecoveryRow queries the outbox
    createBidBoardMock.mockReset(); // isolate: only assert THIS test's create calls (lifecycle beforeEach doesn't reset it)
    getDealMappingMock.mockResolvedValue(undefined);
    getMappingMock.mockResolvedValue(undefined);
    getRfpByNumMock.mockResolvedValue(undefined); getRfpBySourceMock.mockResolvedValue(undefined);
    checkEligibilityMock.mockResolvedValue({ eligible: true } as any);
    getAutomationConfigMock.mockResolvedValue({ value: { companyId: "42" } } as any);
    urlHolder.url = "https://crm.example.com/api/internal/bid-board-created";
    const outcome = await performCreateFromRfpVote(input({ sourceDealId: "deal-B", sourceEventId: "e-B", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    expect(outcome).toBe("failed"); // refused: a sibling recovery row owns TR-1001
    expect(createBidBoardMock).not.toHaveBeenCalled();
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

  it("[F11] recovery keys on the created project id, not sourceDealId (survives a legacy duplicate mapping row)", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-dup", sourceDealId: "d-dup" }));
    // Legacy duplicate: a by-sourceDealId read returns a DIFFERENT row that LACKS the created project's id. Keying
    // recovery on that would either strand the drain or callback the wrong project. The by-bidboardProjectId read is
    // authoritative: here project 999's mapping does NOT yet exist, so recovery writes it and reports 999.
    getDealMappingMock.mockResolvedValue({ bidboardProjectId: "555", procoreProjectNumber: "OTHER" } as any); // wrong dup
    getMappingByBidIdMock.mockResolvedValue(undefined); // project 999 not yet mapped
    createSyncMappingMock.mockResolvedValue({ id: 9 } as any);
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-dup", bidboardProjectId: "999", procoreProjectNumber: "TR-1001" } as any);
    const perform = vi.fn(async () => { throw err; });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(getMappingByBidIdMock).toHaveBeenCalledWith("999"); // looked up by the CREATED project id
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows[0].status).toBe("done");
    expect(lastCallback().bidboardProjectId).toBe("999"); // callback reports the project WE created, not the dup 555
  });

  it("[H4] recovery where the created project is now mapped to ANOTHER deal -> 'needs_manual', no wrong 'created' callback", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-taken", sourceDealId: "d-mine" }));
    // The project 999 was manually re-linked / adopted by a DIFFERENT deal while this row was in recovery.
    getMappingByBidIdMock.mockResolvedValue({ bidboardProjectId: "999", sourceSystem: "trock_crm", sourceDealId: "d-other" } as any);
    const err = new CreatedMappingMissingError("mapping not persisted", "999", { sourceSystem: "trock_crm", sourceDealId: "d-mine", bidboardProjectId: "999" } as any);
    await processBidboardCreateOutbox({ performImpl: (vi.fn(async () => { throw err; })) as any });
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox`)).rows[0].status).toBe("needs_manual");
    expect(createSyncMappingMock).not.toHaveBeenCalled(); // did NOT overwrite the other deal's mapping
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // NO 'created' callback misattributing another deal's project
  });

  it("[H3/I1] claimNext does NOT jump past a FRESH lower-id 'processing' row for the same deal OR project number (a truly-unrelated deal is free)", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-p1", sourceDealId: "d-block", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-p2", sourceDealId: "d-block", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    // A different deal that SHARES the in-flight project number must ALSO be blocked (I1: same-number defense).
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-samenum", sourceDealId: "d-samenum", deal: { name: "d", projectNumber: "TR-1001", projectType: "9", workflowRoute: "normal" } }));
    // A truly-unrelated deal (different deal AND different number) is free to drain.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-other", sourceDealId: "d-free", deal: { name: "d", projectNumber: "TR-9999", projectType: "9", workflowRoute: "normal" } }));
    // round 1 (lowest id) is mid-create (fresh processing); its maybe-created project is invisible to the guards.
    await pg.query(`UPDATE bidboard_create_outbox SET status='processing', last_attempt_at=NOW() WHERE source_event_id='e-p1'`);
    // claimNext skips round 2 (same deal) AND e-samenum (same number), taking only the unrelated deal/number.
    expect((await claimNextBidboardCreateCommand())?.source_event_id).toBe("e-other");
    // once round 1 goes stale (crashed), it (the lower id) is reclaimed first — NOT round 2.
    await pg.query(`UPDATE bidboard_create_outbox SET last_attempt_at=NOW() - interval '11 minutes' WHERE source_event_id='e-p1'`);
    expect((await claimNextBidboardCreateCommand())?.source_event_id).toBe("e-p1");
  });

  it("[F14/P2-C] an UNCONFIRMED create is parked 'needs_manual' (NO auto re-drain -> no duplicate), NO 'failed' callback", async () => {
    // A project MAY exist but its id is unknown. Auto re-draining would call createBidBoardProjectFromDeal again,
    // which CREATES on an inconclusive number lookup -> DUPLICATE. So park it 'needs_manual' (not auto-claimed, not
    // supersedable, no callback) for human resolution — do NOT leave it auto-re-drainable 'pending'.
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-unc1", sourceDealId: "d-unc" }));
    const perform = vi.fn(async () => { throw new UnconfirmedCreateError("Could not confirm project creation"); });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect((await pg.query(`SELECT status FROM bidboard_create_outbox WHERE source_event_id='e-unc1'`)).rows[0].status).toBe("needs_manual");
    expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled(); // NO 'failed' callback — a project may exist
    // A newer same-deal round must NOT supersede the needs_manual row (it isn't 'pending'):
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-unc2", sourceDealId: "d-unc" }));
    const rows = (await pg.query(`SELECT source_event_id, status FROM bidboard_create_outbox`)).rows as any[];
    expect(rows.find((r) => r.source_event_id === "e-unc1").status).toBe("needs_manual"); // untouched by supersede
    expect(rows.find((r) => r.source_event_id === "e-unc2").status).toBe("pending");
    // And claimNext never auto-claims a needs_manual row (so perform is never re-run for it):
    expect(await claimNextBidboardCreateCommand()).toMatchObject({ source_event_id: "e-unc2" });
  });

  it("[F12] claimNext drains by immutable id, not refreshed created_at (preserves arrival order)", async () => {
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-ord1", sourceDealId: "d-ord1" }));
    await enqueueBidboardCreateCommand(input({ sourceEventId: "e-ord2", sourceDealId: "d-ord2" }));
    // Row 1 (lower id) gets a re-queue that bumps its created_at AHEAD of row 2. Draining by created_at would claim
    // row 2 first; draining by id must still claim row 1 first (its arrival order is immutable).
    await pg.query(`UPDATE bidboard_create_outbox SET created_at = NOW() + interval '1 hour' WHERE source_event_id='e-ord1'`);
    const first = await claimNextBidboardCreateCommand();
    expect(first.source_event_id).toBe("e-ord1"); // claimed first by id despite its newer created_at
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
