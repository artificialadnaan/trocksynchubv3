import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

// processRfpApproval END TO END on REAL postgres with the REAL storage SQL, now that PROCORE PROJECT CREATION IS RETIRED (owner
// 2026-11-13, b0cb0c4f). The S0b-2a claim that guarded the Procore create (pending → approving, the beforeCreate submit record,
// the Core-footprint hold) is gone with the create: an approval goes pending → approved in ONE conditional write, so
//   - it passes through 'approving' only as its own claim (N6, below), clears that claim's row, and calls no Procore create;
//   - a double click approves once (the second write matches nothing: 409);
//   - a decline that lands first wins (the approval's write matches nothing: 409, the CRM is not told);
//   - a Core footprint no longer holds it (there is no second destination to protect); 0027 absent changes nothing.
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run plus one WITHOUT 0027. LIVE=1
// without DATABASE_URL FAILS here; it never skips. The environment's DATABASE_URL points at an unroutable sentinel, so an
// un-mocked db import fails loudly. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S0b-2a P3 tests");
const SENTINEL_DATABASE_URL = "postgres://s0b2-real-db-must-not-be-used.invalid:5432/sentinel";
process.env.DATABASE_URL = SENTINEL_DATABASE_URL;

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
const createMock = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ success: true, projectId: "900111" })));
const hubspotUpdateMock = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<any> => ({ success: true })));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: createMock }));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "synthetic-token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: hubspotUpdateMock,
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn(async () => ({ stageId: "s-1", stageName: "Estimating" })) }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn(async () => new Response("", { status: 200 })) }));
vi.mock("../server/rfp-source-eligibility.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  checkCrmDealEligibility: vi.fn(async () => ({ eligible: true })),
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
  buildRfpDeclinedCallbackTargetUrl: () => "https://crm.example.test/api/internal/rfp-declined",
}));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({ handOffServiceRfpApprovalToCore: vi.fn(async () => undefined) }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { storage } = await import("../server/storage.ts");
const { processRfpApproval, processRfpDecline } = await import("../server/rfp-approval.ts");
const stageMock = vi.mocked((await import("../server/hubspot.ts")).updateHubSpotDealStage);
const hubspotClientMock = vi.mocked((await import("../server/hubspot.ts")).getHubSpotClient);
const sendEmailMock = vi.mocked((await import("../server/email-service.ts")).sendEmail);
const handoffMock = vi.mocked((await import("../server/sync/service-rfp-core-outbox.ts")).handOffServiceRfpApprovalToCore);
const { runRfpApprovingStuckSweep } = await import("../server/sync/rfp-approving-stuck.ts");

const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
const BASE_DDL = `
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, source_event_id text,
    project_number text, hubspot_deal_id text, token text NOT NULL, token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending', deal_data jsonb NOT NULL, edited_fields jsonb, approved_attachments jsonb,
    approved_by text, approved_at timestamp, declined_by text, declined_at timestamp, bidboard_project_id text,
    created_at timestamp DEFAULT now(),
    CONSTRAINT rfp_approval_requests_token_unique UNIQUE (token)
  );
  CREATE TABLE sync_mappings (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE UNIQUE INDEX idx_bidboard_callback_outbox_rfp_request ON bidboard_callback_outbox(rfp_approval_request_id);
  CREATE TABLE audit_logs (
    id serial PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text, source text NOT NULL, destination text,
    status text NOT NULL, details jsonb, error_message text, duration_ms integer, user_id varchar, idempotency_key text,
    category text NOT NULL DEFAULT 'system', created_at timestamp DEFAULT now()
  );
`;

let admin: pg.Client;
let pool: pg.Pool;
let pool27less: pg.Pool;
let db27less: any;
let mainDb: any;
const DB_NAME = `s0b2_p3_${process.pid}_${Date.now()}`;
const DB_NAME_27LESS = `${DB_NAME}_no27`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);
const dbUrl = (name: string) => {
  const url = new URL(BASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
};

/** Teardown: pool.end() can resolve before the server has closed its sessions; DROP … WITH (FORCE) would then kill them and the
 *  late 57P01 surfaces as an unhandled error. Wait (bounded) until the database has no sessions first. */
async function waitNoSessions(name: string) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0].n);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
beforeAll(async () => {
  if (!BASE_URL) return;
  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME_27LESS}`);
  pool = new pg.Pool({ connectionString: dbUrl(DB_NAME), max: 8 });
  pool.on("error", () => {});
  pool27less = new pg.Pool({ connectionString: dbUrl(DB_NAME_27LESS), max: 4 });
  pool27less.on("error", () => {});
  for (const p of [pool, pool27less]) {
    await p.query(BASE_DDL);
    await p.query(migration("0021_extend_pending_unique_indexes_to_override_approving.sql"));
    await p.query(migration("0023_create_bidboard_create_outbox.sql"));
  }
  await sql(migration("0027_rfp_core_routing.sql"));
  mainDb = drizzle(pool);
  db27less = drizzle(pool27less);
  dbHolder.pool = pool;
  dbHolder.db = mainDb;
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  if (!BASE_URL) return;
  await pool?.end();
  await pool27less?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  if (admin) await waitNoSessions(DB_NAME_27LESS);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME_27LESS} WITH (FORCE)`);
  await admin?.end();
});
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_core_followup_outbox, rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox,
                      sync_mappings, rfp_approval_approving, rfp_approval_requests, audit_logs RESTART IDENTITY CASCADE`);
  await pool27less.query(`TRUNCATE bidboard_callback_outbox, rfp_approval_requests RESTART IDENTITY CASCADE`);
  dbHolder.pool = pool;
  dbHolder.db = mainDb;
  alertMock.mockReset();
  createMock.mockReset();
  createMock.mockResolvedValue({ success: true, projectId: "900111" });
  hubspotUpdateMock.mockReset();
  hubspotUpdateMock.mockResolvedValue({ success: true });
  // Every HubSpot approval's first attempt reads the deal's stage (N6, Greptile P1 4650989301): a readable HubSpot by default.
  hubspotClientMock.mockResolvedValue({ crm: { deals: { basicApi: { getById: vi.fn(async (_id: string, props: string[]) =>
    ({ properties: Object.fromEntries(props.map((k) => [k, k === "dealstage" ? "rfp-stage" : ""])) })) } } } } as any);
  vi.spyOn(storage, "createAuditLog").mockResolvedValue({} as any);
  vi.spyOn(storage, "getAutomationConfig").mockResolvedValue({ value: { companyId: "42" } } as any);
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
  process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-secret";
});

const DEAL = "00000000-0000-4000-8000-0000000000f3";
const HS_DEAL = "910000003";
const APPROVER = "approver@example.test";
let tokenSeq = 0;
async function insertRequest(status: string, o: { system?: "trock_crm" | "hubspot"; p?: pg.Pool; service?: boolean; deal?: Record<string, string> } = {}) {
  const system = o.system ?? "trock_crm";
  const deal = system === "hubspot" ? HS_DEAL : DEAL;
  const token = `synthetic-token-${++tokenSeq}`;
  const type = o.service ? "4" : "2";
  const number = `DFW-${type}-54321-cd`;
  const r = await (o.p ?? pool).query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, hubspot_deal_id, token, token_expires_at, status, deal_data)
     VALUES ($1, $2, $7, $3, $4, now() + interval '7 days', $5, $6::jsonb) RETURNING id`,
    [system, deal, system === "hubspot" ? deal : null, token, status,
      JSON.stringify({ dealname: "Synthetic Deal", project_number: number, project_types: type, ...(o.deal ?? {}) }), number],
  );
  return { id: r.rows[0].id as number, token };
}
async function insertCore(key: string, status: string, e2EverSent: boolean) {
  const cmd = await sql(
    `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
     VALUES ('trock_crm', $1, $2, 'DFW-2-54321-cd', '{}'::jsonb, 'routed_core', 'core') RETURNING id`,
    [DEAL, key],
  );
  await sql(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, e2_ever_sent)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-54321-cd', $4, $5)`,
    [cmd.rows[0].id, DEAL, key, status, e2EverSent],
  );
}
const requestStatus = async (id: number, p: pg.Pool = pool) =>
  (await p.query(`SELECT status FROM rfp_approval_requests WHERE id = $1`, [id])).rows[0]?.status;
const approvingRow = async (id: number) =>
  (await sql(`SELECT started_at IS NOT NULL AS started, submit_at IS NOT NULL AS submitted FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0];
const holdCallbacks = async (id: number) =>
  (await sql(`SELECT payload->>'error' AS error FROM bidboard_callback_outbox WHERE rfp_approval_request_id = $1`, [id])).rows.map((r) => r.error);
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
async function until(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
async function lockIsFree(dealId: string): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ok = (await c.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`rfp_create:${dealId}`])).rows[0].ok;
    await c.query("ROLLBACK");
    return ok;
  } finally {
    c.release();
  }
}

describe.skipIf(!BASE_URL)("processRfpApproval on real PG with Procore project creation retired", () => {
  it("an approval goes pending → approved: no claim row left, no Procore create; a non-service CRM request gets ONE 'failed' (no Core route)", async () => {
    const { id, token } = await insertRequest("pending");

    const result = await processRfpApproval(token, {}, APPROVER);

    expect(result).toEqual({ success: true });
    expect(await requestStatus(id)).toBe("approved");
    expect(await approvingRow(id)).toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
    const callbacks = await holdCallbacks(id);
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]).toMatch(/no T-Rock Core route/);
  });

  it("a double click (two approvals of one token at once) approves ONCE: the other is refused, one CRM callback, no Procore create", async () => {
    const { id, token } = await insertRequest("pending");

    const results = await Promise.all([processRfpApproval(token, {}, APPROVER), processRfpApproval(token, {}, APPROVER)]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success)).toHaveLength(1);
    expect(await requestStatus(id)).toBe("approved");
    expect(await holdCallbacks(id)).toHaveLength(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("a decline that lands before the approval's write wins: 409, the row stays declined, the CRM is not told", async () => {
    const { id, token } = await insertRequest("pending");
    const pendingRead = await storage.getRfpApprovalRequestByToken(token);
    await sql(`UPDATE rfp_approval_requests SET status = 'declined', declined_by = 'other@example.test', declined_at = now() WHERE id = $1`, [id]);
    // The approval read the row while it was still pending (the race), then a decline committed.
    vi.spyOn(storage, "getRfpApprovalRequestByToken").mockResolvedValueOnce(pendingRead as any);

    const result = await processRfpApproval(token, {}, APPROVER);

    expect(result).toMatchObject({ success: false, statusCode: 409 });
    expect(await requestStatus(id)).toBe("declined");
    expect(await holdCallbacks(id)).toHaveLength(0);
  });

  it("a Core footprint for the deal no longer holds an approval: approved, no hold, no cross-destination alert, no Procore create", async () => {
    await insertCore("crm:rfp-vote:approved:synthetic-round-1", "sent", true);
    const { id, token } = await insertRequest("pending");

    const result = await processRfpApproval(token, {}, APPROVER);

    expect(result).toEqual({ success: true });
    expect(await requestStatus(id)).toBe("approved");
    expect(alertCodes()).not.toContain("cross_destination_hold");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("0027 absent ⇒ the same path: approved, no error (the claim tables are never read)", async () => {
    dbHolder.pool = pool27less;
    dbHolder.db = db27less;
    const { id, token } = await insertRequest("pending", { p: pool27less });

    const result = await processRfpApproval(token, {}, APPROVER);

    expect(result).toEqual({ success: true });
    expect(await requestStatus(id, pool27less)).toBe("approved");
    expect(createMock).not.toHaveBeenCalled();
  });
});

// N6 (a4 078c37ce, the residual): the pending check above is a plain read, and a HubSpot RFP's deal is written (its stage,
// number, edited fields) BEFORE the one conditional write. The route's in-flight set lives in one process only. So a second
// approval, or a decline, that reads the row while the first approval is still writing HubSpot gets through: HubSpot is
// written twice, or the row ends declined for a deal HubSpot was already moved for. The approval must claim its row
// (pending → claimed, conditional) before its first HubSpot write, and anyone refused meanwhile reads one plain line (a4
// 8ea49d91 (3)). A claim a crash leaves behind is released by the stuck sweep; re-approving is safe because every HubSpot write
// sets an absolute value and the Core hand-off only follows the final write (a4 8ea49d91 (2)).
const BEING_APPROVED = "This is being approved right now. Try again in a minute.";
/** Holds the FIRST HubSpot stage write until `release()`; any later one passes straight through. */
function holdFirstStageWrite() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  stageMock.mockReset();
  stageMock.mockResolvedValue({ success: true } as any);
  stageMock.mockImplementationOnce(async () => { await gate; return { success: true } as any; });
  return release;
}

describe.skipIf(!BASE_URL)("an approval claims its row before it writes HubSpot (N6)", () => {
  it("a double click on a HubSpot RFP writes HubSpot ONCE: the second approval is refused before it touches the deal", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot" });
    const release = holdFirstStageWrite();

    const first = processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    const second = await processRfpApproval(token, {}, APPROVER);
    release();

    expect(await first).toEqual({ success: true });
    expect(second).toMatchObject({ success: false, statusCode: 409, message: BEING_APPROVED });
    expect(stageMock).toHaveBeenCalledTimes(1);
    expect(await requestStatus(id)).toBe("approved");
  });

  it("a decline while an approval is writing HubSpot is refused: the row ends approved, as the deal HubSpot moved", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot" });
    const release = holdFirstStageWrite();

    const approval = processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    const decline = await processRfpDecline(token, "other@example.test");
    release();

    expect(decline).toMatchObject({ success: false, statusCode: 409, message: BEING_APPROVED });
    expect(await approval).toEqual({ success: true });
    expect(stageMock).toHaveBeenCalledTimes(1);
    expect(await requestStatus(id)).toBe("approved");
  });

  it("a crash after the HubSpot write leaves a claim the stuck sweep releases; re-approving sets the SAME stage and hands Core ONE job", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", service: true });
    holdFirstStageWrite(); // never released: this approval's process dies inside its HubSpot write
    handoffMock.mockClear();

    void processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    expect(await requestStatus(id)).toBe("approving");
    await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);
    const swept = await runRfpApprovingStuckSweep({ db: pool, recipient: "" });
    expect(swept.released).toEqual([id]);
    expect(await requestStatus(id)).toBe("pending");

    expect(await processRfpApproval(token, {}, APPROVER)).toEqual({ success: true });

    expect(await requestStatus(id)).toBe("approved");
    expect(stageMock).toHaveBeenCalledTimes(2);
    expect(new Set(stageMock.mock.calls.map((c) => c[1]))).toEqual(new Set(["s-1"]));
    expect(handoffMock).toHaveBeenCalledTimes(1);
  });
});

// a4 ADD-1 ba1d1a25 (Greptile P1 4650915940): an attempt that wrote HubSpot and then failed is released; the NEXT decision must leave
// HubSpot equal to ITSELF, whatever the attempt wrote. A fake HubSpot deal: writes land in `hs`, reads answer from it.
const ORIGINAL = { amount: "100", dealstage: "rfp-stage", project_number: "DFW-2-54321-cd", project_types: "2" };
let hs: Record<string, string> = {};
function fakeHubSpot(o: { unreadable?: boolean } = {}) {
  hs = { ...ORIGINAL };
  hubspotUpdateMock.mockImplementation(async (_id: string, props: Record<string, string>) => { Object.assign(hs, props); return { success: true }; });
  stageMock.mockReset();
  stageMock.mockImplementation(async (_id: string, stage: string) => { hs.dealstage = stage; return { success: true } as any; });
  hubspotClientMock.mockResolvedValue({ crm: { deals: { basicApi: { getById: vi.fn(async (_id: string, props: string[]) => {
    if (o.unreadable) throw new Error("synthetic HubSpot outage");
    return { properties: Object.fromEntries(props.map((k) => [k, hs[k] ?? ""])) };
  }) } } } } as any);
}
/** The first approval writes its fields and its stage, then dies: a handled failure, so its claim is released (the row stays pending). */
function dieAfterTheFirstStageWrite() {
  stageMock.mockImplementationOnce(async (_id: string, stage: string) => { hs.dealstage = stage; throw new Error("synthetic crash after the stage write"); });
}
const HUBSPOT_UNREACHABLE = "HubSpot can't be reached to check this request. Try again in a minute.";

describe.skipIf(!BASE_URL)("a4 ADD-1: after a released attempt, the next decision leaves HubSpot equal to itself", () => {
  it("amount: the attempt wrote 200 and died; re-approving the original 100 writes 100 back", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();

    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    expect(hs.amount).toBe("200");
    expect(await requestStatus(id)).toBe("pending");

    expect(await processRfpApproval(token, { amount: "100" }, APPROVER)).toEqual({ success: true });
    expect(hs.amount).toBe("100");
    expect(await requestStatus(id)).toBe("approved");
  });

  it("type / number: the attempt renumbered it to type 4 and died; re-approving unchanged puts the type-2 number back", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();

    expect((await processRfpApproval(token, { project_types: "4" }, APPROVER)).success).toBe(false);
    expect(hs).toMatchObject({ project_number: "DFW-4-54321-cd", project_types: "4" });

    expect(await processRfpApproval(token, {}, APPROVER)).toEqual({ success: true });
    expect(hs).toMatchObject({ project_number: "DFW-2-54321-cd", project_types: "2" });
    expect(await requestStatus(id)).toBe("approved");
  });

  it("a decline after the released attempt puts HubSpot back: the original amount and the original stage", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();

    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    expect(hs).toMatchObject({ amount: "200", dealstage: "s-1" });

    expect((await processRfpDecline(token, "other@example.test")).success).toBe(true);
    expect(hs).toMatchObject({ amount: "100", dealstage: "rfp-stage" });
    expect(await requestStatus(id)).toBe("declined");
  });

  it("HubSpot unreadable after a released attempt: the decline and the approval each refuse with the plain line and write nothing", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();
    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    fakeHubSpot({ unreadable: true });
    hs = { ...ORIGINAL, amount: "200", dealstage: "s-1" };
    const writesBefore = hubspotUpdateMock.mock.calls.length + stageMock.mock.calls.length;

    expect(await processRfpDecline(token, "other@example.test")).toMatchObject({ success: false, statusCode: 503, message: HUBSPOT_UNREACHABLE });
    expect(await processRfpApproval(token, {}, APPROVER)).toMatchObject({ success: false, statusCode: 503, message: HUBSPOT_UNREACHABLE });

    expect(hubspotUpdateMock.mock.calls.length + stageMock.mock.calls.length).toBe(writesBefore);
    expect(await requestStatus(id)).toBe("pending");
  });

  it("the claim stamp: an approval whose claim was released and TAKEN AGAIN cannot finish on the new claim (one Core job)", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", service: true });
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const gateB = new Promise<void>((r) => { releaseB = r; });
    stageMock.mockReset();
    stageMock.mockResolvedValue({ success: true } as any);
    stageMock.mockImplementationOnce(async () => { await gateA; return { success: true } as any; });
    stageMock.mockImplementationOnce(async () => { await gateB; return { success: true } as any; });
    handoffMock.mockClear();

    const a = processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);
    expect((await runRfpApprovingStuckSweep({ db: pool, recipient: "" })).released).toEqual([id]);
    const b = processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 2)).toBe(true);
    releaseA();

    expect(await a).toMatchObject({ success: false, statusCode: 409 });
    releaseB();
    expect(await b).toEqual({ success: true });
    expect(await requestStatus(id)).toBe("approved");
    expect(handoffMock).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!BASE_URL)("N6 round 2 (Greptile P1 4650989301, CodeRabbit on #143)", () => {
  it("a decline after a released attempt restores the stage the deal had BEFORE the first write, though deal_data keeps no stage", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: { amount: "100" } });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();

    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    expect(hs).toMatchObject({ amount: "200", dealstage: "s-1" });

    expect((await processRfpDecline(token, "other@example.test")).success).toBe(true);
    expect(hs).toMatchObject({ amount: "100", dealstage: "rfp-stage" });
    expect(await requestStatus(id)).toBe("declined");
  });

  it("a holder that stalls past the sweep, whose claim is released and taken again, writes NOTHING to HubSpot after it resumes", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    let resume!: () => void;
    const stall = new Promise<void>((r) => { resume = r; });
    const realClient = await hubspotClientMock();
    let first = true;
    hubspotClientMock.mockResolvedValue({ crm: { deals: { basicApi: { getById: vi.fn(async (dealId: string, props: string[]) => {
      if (first) { first = false; await stall; }
      return (realClient as any).crm.deals.basicApi.getById(dealId, props);
    }) } } } } as any);

    const a = processRfpApproval(token, { project_types: "4", amount: "999" }, APPROVER);
    expect(await until(async () => Boolean((await sql(`SELECT 1 FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0]))).toBe(true);
    await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);
    expect((await runRfpApprovingStuckSweep({ db: pool, recipient: "" })).released).toEqual([id]);
    expect(await processRfpApproval(token, {}, APPROVER)).toEqual({ success: true });
    const after = { ...hs };
    const writes = hubspotUpdateMock.mock.calls.length + stageMock.mock.calls.length;
    resume();

    expect(await a).toMatchObject({ success: false, statusCode: 409 });
    expect(hubspotUpdateMock.mock.calls.length + stageMock.mock.calls.length).toBe(writes);
    expect(hs).toEqual(after);
    expect(await requestStatus(id)).toBe("approved");
  });

  it("an email claim on a row a reset override left (approved_by recorded) takes it over: approved_by cleared, so the sweep can release it", async () => {
    const { id, token } = await insertRequest("pending");
    await sql(`INSERT INTO rfp_approval_approving (request_id, started_at, submit_at, approved_by) VALUES ($1, now() - interval '2 hours', NULL, 'override@example.test')`, [id]);
    vi.spyOn(storage, "updateRfpApprovalRequest").mockRejectedValueOnce(new Error("synthetic failure before the final write"));

    expect((await processRfpApproval(token, {}, APPROVER)).success).toBe(false);

    expect(await requestStatus(id)).toBe("pending");
    expect((await sql(`SELECT approved_by FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0]).toEqual({ approved_by: null });
  });

  it("the sweep writes its rfp_approval_claim_released audit line in the same statement as the release (one line per release)", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", service: true });
    holdFirstStageWrite();
    void processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);

    expect((await runRfpApprovingStuckSweep({ db: pool, recipient: "" })).released).toEqual([id]);
    expect((await runRfpApprovingStuckSweep({ db: pool, recipient: "" })).released).toEqual([]);

    const lines = (await sql(`SELECT details ->> 'rfpApprovalRequestId' AS rid FROM audit_logs WHERE action = 'rfp_approval_claim_released'`)).rows;
    expect(lines).toEqual([{ rid: String(id) }]);
  });
});

// a4 ADD-2 6025b95c (d6 F-143-1 / F-143-2 on 0c3eb130).
const STOPPED = "This approval took too long and was stopped before it finished. Open the request and approve it again.";
const STAGE_UNKNOWN = "HubSpot's stage for this deal from before the approval isn't known, so it can't be put back. Move the deal to its earlier stage in HubSpot, then decline again.";
const emailedLines = () => sendEmailMock.mock.calls.map((c) => String((c[0] as any)?.htmlBody ?? ""));
const notice = async (id: number) => (await sql(`SELECT deal_data ->> 'approval_notice' AS n FROM rfp_approval_requests WHERE id = $1`, [id])).rows[0]?.n ?? null;
/** The review form posts EVERY named field; most equal the stored deal. */
const wholeForm = (over: Record<string, string>) => ({ dealname: "Synthetic Deal", city: "Intake City", amount: "100", ...over });

describe.skipIf(!BASE_URL)("a4 ADD-2: the footprint is what the approval changed; a background refusal is never silent; an unknown stage", () => {
  it("F-143-1: a field no attempt changed, edited in HubSpot by a person, keeps the person's value after a re-approve", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: { ...ORIGINAL, city: "Intake City" } });
    fakeHubSpot();
    hs.city = "Intake City";
    dieAfterTheFirstStageWrite();
    expect((await processRfpApproval(token, wholeForm({ amount: "200" }), APPROVER)).success).toBe(false);
    hs.city = "Person City";

    expect(await processRfpApproval(token, wholeForm({}), APPROVER)).toEqual({ success: true });

    expect(hs).toMatchObject({ amount: "100", city: "Person City" });
    expect(await requestStatus(id)).toBe("approved");
  });

  it("F-143-1: the same after a decline: the person's HubSpot edit stands, the attempt's own field is put back", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: { ...ORIGINAL, city: "Intake City" } });
    fakeHubSpot();
    hs.city = "Intake City";
    dieAfterTheFirstStageWrite();
    expect((await processRfpApproval(token, wholeForm({ amount: "200" }), APPROVER)).success).toBe(false);
    hs.city = "Person City";

    expect((await processRfpDecline(token, "other@example.test")).success).toBe(true);

    expect(hs).toMatchObject({ amount: "100", city: "Person City", dealstage: "rfp-stage" });
    expect(await requestStatus(id)).toBe("declined");
  });

  it("F-143-2: HubSpot unreadable after a released attempt: the approver gets the line by email, and the pending request keeps it", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    dieAfterTheFirstStageWrite();
    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    fakeHubSpot({ unreadable: true });
    sendEmailMock.mockClear();

    expect(await processRfpApproval(token, {}, APPROVER)).toMatchObject({ statusCode: 503 });

    expect(emailedLines().some((h) => h.includes(HUBSPOT_UNREACHABLE))).toBe(true);
    expect(await notice(id)).toBe(HUBSPOT_UNREACHABLE);
  });

  it("F-143-2: a second approval refused while the first holds the row gets the being-approved line by email", async () => {
    const { token } = await insertRequest("pending", { system: "hubspot" });
    const release = holdFirstStageWrite();
    const first = processRfpApproval(token, {}, APPROVER);
    expect(await until(() => stageMock.mock.calls.length === 1)).toBe(true);
    sendEmailMock.mockClear();

    expect((await processRfpApproval(token, {}, APPROVER)).success).toBe(false);
    expect(emailedLines().some((h) => h.includes(BEING_APPROVED))).toBe(true);
    release();
    expect(await first).toEqual({ success: true });
  });

  it("F-143-2: a holder that lost its claim tells the approver it was stopped", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot();
    let resume!: () => void;
    const stall = new Promise<void>((r) => { resume = r; });
    const realClient = await hubspotClientMock();
    let first = true;
    hubspotClientMock.mockResolvedValue({ crm: { deals: { basicApi: { getById: vi.fn(async (dealId: string, props: string[]) => {
      if (first) { first = false; await stall; }
      return (realClient as any).crm.deals.basicApi.getById(dealId, props);
    }) } } } } as any);
    const a = processRfpApproval(token, { amount: "999" }, APPROVER);
    expect(await until(async () => Boolean((await sql(`SELECT 1 FROM rfp_approval_approving WHERE request_id = $1`, [id])).rows[0]))).toBe(true);
    await sql(`UPDATE rfp_approval_approving SET started_at = started_at - interval '31 minutes' WHERE request_id = $1`, [id]);
    expect((await runRfpApprovingStuckSweep({ db: pool, recipient: "" })).released).toEqual([id]);
    sendEmailMock.mockClear();
    resume();

    expect(await a).toMatchObject({ success: false, statusCode: 409, message: STOPPED });
    expect(emailedLines().some((h) => h.includes(STOPPED))).toBe(true);
    expect(await notice(id)).toBe(STOPPED);
  });

  it("a stage that can't be read does NOT refuse a fresh approval: it goes on as main did", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: ORIGINAL });
    fakeHubSpot({ unreadable: true });

    expect(await processRfpApproval(token, {}, APPROVER)).toEqual({ success: true });
    expect(await requestStatus(id)).toBe("approved");
  });

  it("a decline after a released attempt whose pre-write stage is unknown: refused while HubSpot shows the approved stage, then fine once a person moves it back", async () => {
    const { id, token } = await insertRequest("pending", { system: "hubspot", deal: { amount: "100" } });
    fakeHubSpot();
    const realClient = await hubspotClientMock();
    let firstRead = true;
    hubspotClientMock.mockResolvedValue({ crm: { deals: { basicApi: { getById: vi.fn(async (dealId: string, props: string[]) => {
      if (firstRead) { firstRead = false; throw new Error("synthetic outage on the first stage read"); }
      return (realClient as any).crm.deals.basicApi.getById(dealId, props);
    }) } } } } as any);
    dieAfterTheFirstStageWrite();
    expect((await processRfpApproval(token, { amount: "200" }, APPROVER)).success).toBe(false);
    expect(hs.dealstage).toBe("s-1");

    expect(await processRfpDecline(token, "other@example.test")).toMatchObject({ success: false, statusCode: 409, message: STAGE_UNKNOWN });
    expect(await requestStatus(id)).toBe("pending");
    expect(hs.amount).toBe("200"); // refused BEFORE writing anything

    hs.dealstage = "rfp-stage-set-by-a-person";
    expect((await processRfpDecline(token, "other@example.test")).success).toBe(true);
    expect(hs).toMatchObject({ amount: "100", dealstage: "rfp-stage-set-by-a-person" });
    expect(await requestStatus(id)).toBe("declined");
  });
});
