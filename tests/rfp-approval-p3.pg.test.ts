import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";

// CONTRACT v2.2 §10, S0b-2a, END TO END through processRfpApproval (path P3) on REAL postgres with the REAL storage SQL:
//   - the email path flips pending → approving under the per-deal lock in one short transaction right before Playwright, and
//     the lock is never held across the HubSpot calls (d9 Q2 condition);
//   - Playwright gets a beforeCreate hook that commits rfp_approval_approving.submit_at before the create starts (runbook r5);
//   - a Core footprint ⇒ no Playwright, held_cross_destination, F1, alert; a double click creates once; an errored preflight
//     fails closed; 0027 absent ⇒ today's path (d9 green test);
//   - a decline that read `pending` just before the flip loses with 409 instead of overwriting `approving` (d9 5b).
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

describe.skipIf(!BASE_URL)("processRfpApproval email path (V3) on real PG", () => {
  it("when the Playwright create starts, the row is already approving and rfp_approval_approving.started_at is set", async () => {
    const { id, token } = await insertRequest("pending");
    let seen: unknown = null;
    createMock.mockImplementationOnce(async () => {
      seen = { status: await requestStatus(id), side: await approvingRow(id) };
      return { success: true, projectId: "900111" };
    });
    await processRfpApproval(token, {}, APPROVER);
    expect(seen).toEqual({ status: "approving", side: { started: true, submitted: false } });
  });
  it("Playwright gets a beforeCreate hook; once it returns, another session reads submit_at set (committed before the create)", async () => {
    const { id, token } = await insertRequest("pending");
    let hookType = "missing";
    let submittedAfterHook: unknown = null;
    createMock.mockImplementationOnce(async (args: any) => {
      const hook = args?.options?.beforeCreate;
      hookType = typeof hook;
      if (typeof hook === "function") {
        await hook();
        submittedAfterHook = (await approvingRow(id))?.submitted ?? null;
      }
      return { success: true, projectId: "900111" };
    });
    const result = await processRfpApproval(token, {}, APPROVER);
    expect(hookType).toBe("function");
    expect(submittedAfterHook).toBe(true);
    expect(result).toMatchObject({ success: true, bidboardProjectId: "900111" });
    expect(await requestStatus(id)).toBe("approved");
  });
  for (const [when, hookFirst, submitted] of [["before", false, false], ["after", true, true]] as const) {
    it(`a create that never returns ${when} the hook (a crash) leaves the row approving with submit_at ${submitted ? "set" : "NULL"}`, async () => {
      const { id, token } = await insertRequest("pending");
      let entered = false;
      let release: ((v: unknown) => void) | undefined;
      createMock.mockImplementationOnce(async (args: any) => {
        const hook = args?.options?.beforeCreate;
        if (hookFirst && typeof hook === "function") await hook();
        entered = true;
        return new Promise((r) => { release = r; });
      });
      const run = processRfpApproval(token, {}, APPROVER);
      let state: unknown = null;
      try {
        await until(() => entered);
        state = { status: await requestStatus(id), submitted: (await approvingRow(id))?.submitted ?? null };
      } finally {
        release?.({ success: false, error: "synthetic crash" });
        await run;
      }
      expect(state).toEqual({ status: "approving", submitted });
    });
  }
  it("a Core footprint for the deal ⇒ no Playwright; the request is held_cross_destination with an F1 and the alert", async () => {
    await insertCore("core-key-1", "pending", false);
    const { id, token } = await insertRequest("pending");
    const result = await processRfpApproval(token, {}, APPROVER);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cross_destination_hold/);
    expect(await requestStatus(id)).toBe("held_cross_destination");
    expect(await holdCallbacks(id)).toEqual(["cross_destination_hold"]);
    expect(alertCodes()).toContain("cross_destination_hold");
  });
  it("a double click (two approvals of one token at once) ⇒ exactly one Playwright create; the other reads 'Request already approving'", async () => {
    const { token } = await insertRequest("pending");
    const results = await Promise.all([processRfpApproval(token, {}, APPROVER), processRfpApproval(token, {}, APPROVER)]);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({ success: false, error: "Request already approving" });
  });
  it("the deal lock is free while the HubSpot update runs (nothing held across the network call; d9 Q2 guard)", async () => {
    const { token } = await insertRequest("pending", { system: "hubspot" });
    let releaseHubspot: ((v: unknown) => void) | undefined;
    let hubspotEntered = false;
    hubspotUpdateMock.mockImplementationOnce(() => {
      hubspotEntered = true;
      return new Promise((r) => { releaseHubspot = r; });
    });
    const run = processRfpApproval(token, { dealname: "Synthetic Deal (edited)" }, APPROVER);
    let freeDuringHubspot: boolean | null = null;
    try {
      await until(() => hubspotEntered);
      freeDuringHubspot = await lockIsFree(HS_DEAL);
    } finally {
      releaseHubspot?.({ success: true });
      await run;
    }
    expect(hubspotEntered).toBe(true);
    expect(freeDuringHubspot).toBe(true);
    expect(hubspotUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(createMock.mock.invocationCallOrder[0]);
  });
  it("a preflight that ERRORS ⇒ no Playwright; the request stays pending; the alert names the error (core_preflight_error), never core_tables_missing", async () => {
    const { id, token } = await insertRequest("pending");
    dbHolder.db = new Proxy(mainDb, {
      get(target, prop) {
        if (prop === "execute") {
          return async (q: any) => {
            if (/to_regclass/.test(new PgDialect().sqlToQuery(q).sql)) throw new Error("synthetic preflight failure");
            return target.execute(q);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await processRfpApproval(token, {}, APPROVER);
    expect(createMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(await requestStatus(id)).toBe("pending");
    expect(alertCodes()).toContain("core_preflight_error");
    expect(alertCodes()).not.toContain("core_tables_missing");
    expect(JSON.stringify(alertMock.mock.calls)).toMatch(/synthetic preflight failure/);
  });
  it("0027 absent ⇒ today's path: one Playwright create, the request approved, no error (d9 green test; guard)", async () => {
    const { id, token } = await insertRequest("pending", { p: pool27less });
    dbHolder.pool = pool27less;
    dbHolder.db = db27less;
    const result = await processRfpApproval(token, {}, APPROVER);
    expect(result).toMatchObject({ success: true, bidboardProjectId: "900111" });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(await requestStatus(id, pool27less)).toBe("approved");
  });
});

describe.skipIf(!BASE_URL)("processRfpApproval override path (force) on real PG", () => {
  it("a Core footprint ⇒ no Playwright; the override is held_cross_destination with an F1 and the alert", async () => {
    await insertCore("core-key-1", "sent", true);
    const { id, token } = await insertRequest("override_approving");
    const result = await processRfpApproval(token, {}, APPROVER, { force: true });
    expect(createMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(await requestStatus(id)).toBe("held_cross_destination");
    expect(await holdCallbacks(id)).toEqual(["cross_destination_hold"]);
    expect(alertCodes()).toContain("cross_destination_hold");
  });
});

describe.skipIf(!BASE_URL)("processRfpDecline vs the flip (d9 5b)", () => {
  it("a decline that read pending just before the flip loses: 409 'Request already approving', the row stays approving", async () => {
    const { id, token } = await insertRequest("pending");
    const stale = await storage.getRfpApprovalRequestByToken(token);
    await sql(`UPDATE rfp_approval_requests SET status = 'approving' WHERE id = $1`, [id]);
    vi.spyOn(storage, "getRfpApprovalRequestByToken").mockResolvedValueOnce(stale as any);
    const result = await processRfpDecline(token, APPROVER);
    expect(await requestStatus(id)).toBe("approving");
    expect(result).toMatchObject({ success: false, error: "Request already approving", statusCode: 409 });
  });
});
