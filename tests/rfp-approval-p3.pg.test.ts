import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

// processRfpApproval END TO END on REAL postgres with the REAL storage SQL, now that PROCORE PROJECT CREATION IS RETIRED (owner
// 2026-11-13, b0cb0c4f). The S0b-2a claim that guarded the Procore create (pending → approving, the beforeCreate submit record,
// the Core-footprint hold) is gone with the create: an approval goes pending → approved in ONE conditional write, so
//   - it never passes through 'approving', writes no rfp_approval_approving row and calls no Procore create;
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
                      sync_mappings, rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
  await pool27less.query(`TRUNCATE bidboard_callback_outbox, rfp_approval_requests RESTART IDENTITY CASCADE`);
  dbHolder.pool = pool;
  dbHolder.db = mainDb;
  alertMock.mockReset();
  createMock.mockReset();
  createMock.mockResolvedValue({ success: true, projectId: "900111" });
  hubspotUpdateMock.mockReset();
  hubspotUpdateMock.mockResolvedValue({ success: true });
  vi.spyOn(storage, "createAuditLog").mockResolvedValue({} as any);
  vi.spyOn(storage, "getAutomationConfig").mockResolvedValue({ value: { companyId: "42" } } as any);
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
  process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-secret";
});

const DEAL = "00000000-0000-4000-8000-0000000000f3";
const HS_DEAL = "910000003";
const APPROVER = "approver@example.test";
let tokenSeq = 0;
async function insertRequest(status: string, o: { system?: "trock_crm" | "hubspot"; p?: pg.Pool } = {}) {
  const system = o.system ?? "trock_crm";
  const deal = system === "hubspot" ? HS_DEAL : DEAL;
  const token = `synthetic-token-${++tokenSeq}`;
  const r = await (o.p ?? pool).query(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, hubspot_deal_id, token, token_expires_at, status, deal_data)
     VALUES ($1, $2, 'DFW-2-54321-cd', $3, $4, now() + interval '7 days', $5, $6::jsonb) RETURNING id`,
    [system, deal, system === "hubspot" ? deal : null, token, status,
      JSON.stringify({ dealname: "Synthetic Deal", project_number: "DFW-2-54321-cd", project_types: "2" })],
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
  it("an approval goes pending → approved directly: no 'approving', no claim row, no Procore create; a non-service CRM request gets ONE 'failed' (no Core route)", async () => {
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
