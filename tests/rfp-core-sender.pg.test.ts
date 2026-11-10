import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// S1a (CONTRACT v2.4 §10) on REAL postgres, where separate sessions make the races real: the E2 claim (two drains on one
// due row ⇒ one E2), the sender's footprint re-check WAITING on the per-deal lock `rfp_create:<deal>` held by another
// create path (that path's footprint ⇒ held, nothing sent), and a CRM re-post arriving while the E2 is in flight (S0
// leaves the `sending` row alone; the send's own result lands; one row, one E2). The runner's throwaway postgres
// (DATABASE_URL), one fresh database per run; LIVE=1 without DATABASE_URL FAILS, it never skips. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S1a sender race tests");
// The environment points at an unroutable sentinel, so any un-mocked db use fails loudly; the test's own clients use BASE_URL.
const SENTINEL_DATABASE_URL = "postgres://s1a-real-db-must-not-be-used.invalid:5432/sentinel";
process.env.DATABASE_URL = SENTINEL_DATABASE_URL;

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  buildSourceDealUrl: vi.fn(() => null),
  normalizedDealData: vi.fn(() => ({})),
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { enqueueBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
const { drainRfpCoreCreateOutbox, resetRfpCoreSenderStateForTests } = await import("../server/sync/rfp-core-sender.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

const CORE_BASE = "https://core.example.test";
const E2_URL = `${CORE_BASE}/webhooks/crm/dallas/rfp-bid-create/v1`;
const DEAL = "00000000-0000-4000-8000-0000000000e1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-3";
const ENV_KEYS = ["RFP_NONSERVICE_DESTINATION", "RFP_BID_CREATE_INGRESS_SECRET_CURRENT", "CORE_INGRESS_BASE_URL", "TROCK_CRM_BASE_URL", "RFP_REQUEST_SYNC_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

let admin: pg.Client;
let pool: pg.Pool;
const DB_NAME = `s1a_sender_${process.pid}_${Date.now()}`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

async function waitNoSessions(name: string) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0].n);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  if (!BASE_URL) return;
  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  const url = new URL(BASE_URL);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  pool.on("error", () => {});
  await sql(`
    CREATE TABLE bidboard_callback_outbox (
      id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
      rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE sync_mappings (
      id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, bidboard_project_id text
    );
    CREATE TABLE rfp_approval_requests (
      id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL,
      status text NOT NULL DEFAULT 'pending', project_number text
    );
  `);
  await sql(DDL_0023);
  await sql(DDL_0027);
  dbHolder.pool = pool;
  dbHolder.db = drizzle(pool);
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (!BASE_URL) return;
  await pool?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end();
});
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_core_followup_outbox, rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox,
                      sync_mappings, rfp_approval_requests RESTART IDENTITY CASCADE`);
  alertMock.mockReset();
  process.env.RFP_NONSERVICE_DESTINATION = "core";
  process.env.RFP_BID_CREATE_INGRESS_SECRET_CURRENT = "synthetic-rfp-bid-create-secret-0123456789";
  process.env.CORE_INGRESS_BASE_URL = CORE_BASE;
  process.env.TROCK_CRM_BASE_URL = "https://crm.example.test";
  process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-crm-internal-secret";
  resetRfpCoreSenderStateForTests();
});

function e1(): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved", approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-3", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Deal", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Co", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
  };
}
const receipt = (result: string) => ({
  version: "trock.crm.rfp-bid-create.v1", result, coreBidId: BID, boardStage: { code: "in-progress", status: "invited" },
  createdAt: "2026-11-10T12:00:01.000Z", warnings: [],
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const coreRows = async () => (await sql(`SELECT * FROM rfp_core_create_outbox ORDER BY id`)).rows;
const followupCount = async () => Number((await sql(`SELECT count(*)::int AS n FROM rfp_core_followup_outbox`)).rows[0].n);
async function until(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!BASE_URL)("the E2 claim and the per-deal lock (real PG, separate sessions)", () => {
  it("two drains racing on one due row (two instances) ⇒ exactly one claims it: ONE E2, ONE follow-up", async () => {
    await enqueueBidboardCreateCommand(e1());
    const fetchImpl = vi.fn(async (_url: string, _init: any) => {
      await new Promise((r) => setTimeout(r, 100));
      return json(201, receipt("created"));
    });
    const results = await Promise.all([drainRfpCoreCreateOutbox({ fetchImpl }), drainRfpCoreCreateOutbox({ fetchImpl })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.sent).sort()).toEqual([0, 1]);
    expect((await coreRows())[0]).toMatchObject({ status: "sent", attempt_count: 1, core_bid_id: BID });
    expect(await followupCount()).toBe(1);
  });
  it("the footprint re-check WAITS on rfp_create:<deal>: a Procore footprint committed by the lock holder ⇒ held, nothing sent", async () => {
    await enqueueBidboardCreateCommand(e1());
    const holder = await pool.connect();
    let waited = false;
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, receipt("created")));
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rfp_create:${DEAL}`]);
      await holder.query(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900020')`, [DEAL]);
      const drain = drainRfpCoreCreateOutbox({ fetchImpl });
      waited = await until(async () =>
        Number((await sql(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
                            WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`)).rows[0].n) > 0);
      await holder.query("COMMIT");
      await drain;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
    expect(waited).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await coreRows())[0]).toMatchObject({ status: "held_cross_destination", e2_ever_sent: false });
    expect(alertMock.mock.calls.map((c) => c[0])).toContain("cross_destination_hold");
  });
  it("a CRM re-post arriving while the E2 is in flight leaves the 'sending' row alone; the send's result lands: one row, one E2", async () => {
    await enqueueBidboardCreateCommand(e1());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async (_url: string, _init: any) => {
      await gate;
      return json(201, receipt("created"));
    });
    const drain = drainRfpCoreCreateOutbox({ fetchImpl });
    const inFlight = await until(async () => fetchImpl.mock.calls.length === 1);
    let duringSend: any[] = [];
    if (inFlight) {
      await enqueueBidboardCreateCommand(e1());
      duringSend = await coreRows();
    }
    release();
    await drain;
    expect(inFlight).toBe(true);
    expect(duringSend.map((r) => [r.status, r.attempt_count])).toEqual([["sending", 1]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await coreRows()).map((r) => r.status)).toEqual(["sent"]);
    expect(await followupCount()).toBe(1);
  });
});
