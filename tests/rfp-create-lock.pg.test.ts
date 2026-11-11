import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// CONTRACT v2.2 §10 (S0b-1): ONE per-deal advisory lock `rfp_create:<sourceDealId>` around the DECISION + CLAIM on every create
// path, and the FOOTPRINT each path checks under it (another destination's footprint ⇒ held_cross_destination + alert + F1).
// d9 rulings: (iii) a Bid Board mapping counts; (iv) a Procore command counts when processing | reclaiming | needs_manual | done
// or carrying __recoveredProjectId (a PENDING one does not: P2 re-checks at claim); the Core footprint is every Core row except
// refused, and except a held_cross_destination row that never sent an E2 (e2_ever_sent).
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run. LIVE=1 without DATABASE_URL
// FAILS here; it never skips. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S0b lock / footprint tests");
// r3 HARNESS (a4): r2 showed a same-tick dynamic import reaching the REAL server/db.ts, whose pool then read the runner's BASE
// database. From here on the environment points at an unroutable sentinel, so any un-mocked db use FAILS LOUDLY (a connection
// error, so the preflight reads "inconclusive") and can never quietly read another database. The test's own clients use BASE_URL.
const SENTINEL_DATABASE_URL = "postgres://s0b-real-db-must-not-be-used.invalid:5432/sentinel";
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
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
}));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) } }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const { enqueueBidboardCreateCommand, processBidboardCreateOutbox } = await import("../server/sync/bidboard-create-worker.ts");
const { lockRfpCreateDeal, readProcoreFootprint, readCoreFootprint } = await import("../server/sync/rfp-create-lock.ts");
const { preflightRfpCoreTables } = await import("../server/sync/rfp-core-preflight.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

let admin: pg.Client;
let pool: pg.Pool;
let ddlCommittedAt = "";
const DB_NAME = `s0b_lock_${process.pid}_${Date.now()}`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

/** Teardown: pool.end() can resolve before the server has closed its sessions; DROP … WITH (FORCE) would then kill them and the
 *  late 57P01 surfaces as an unhandled error (S0b-1 GREEN1; a4 ruling (a)). Wait (bounded) until the database has no sessions first. */
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
  await sql(DDL_0023); // also drops NOT NULL on bidboard_callback_outbox.rfp_approval_request_id
  await sql(DDL_0027);
  ddlCommittedAt = (await sql(`SELECT clock_timestamp()::text AS t`)).rows[0].t;
  dbHolder.pool = pool;
  dbHolder.db = drizzle(pool);
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
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
  delete process.env.RFP_NONSERVICE_DESTINATION;
  process.env.RFP_CORE_OFFICES = "dallas"; // c6 rule (f): the E1 office (dallas) is listed
});

const DEAL = "00000000-0000-4000-8000-0000000000e1";
const OTHER_DEAL = "00000000-0000-4000-8000-0000000000e2";
const VOTE_KEY = "crm:rfp-vote:approved:round-2";
const OLD_KEY = "crm:rfp-vote:approved:round-1";
function e1(o: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: VOTE_KEY, decision: "approved",
    approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-2", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    deal: {
      name: "Synthetic Deal", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 1000, estimator: "Pat Example",
      companyId: "00000000-0000-4000-8000-0000000000c1", companyName: "Synthetic Co", contactName: "Sam Synthetic",
      clientEmail: "sam@example.test", clientPhone: null, propertyId: null,
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
    },
    attachments: [],
    ...o,
  } as any;
}
const override = (o: Record<string, any> = {}) => e1({ approvalKind: "override", approval: undefined, sourceEventId: "crm:rfp-override:approved:1", ...o });

async function insertCommand(key: string, status: string, o: { deal?: string; destination?: string; payload?: Record<string, any> } = {}) {
  const deal = o.deal ?? DEAL;
  const payload = o.payload ?? e1({ sourceEventId: key, sourceDealId: deal });
  const r = await sql(
    `INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, project_number, payload, status, destination)
     VALUES ('trock_crm', $1, $2, 'DFW-2-12345-ab', $3::jsonb, $4, $5) RETURNING id`,
    [deal, key, JSON.stringify(payload), status, o.destination ?? "procore"],
  );
  return r.rows[0].id as number;
}
async function insertCore(key: string, status: string, o: { deal?: string; e2EverSent?: boolean } = {}) {
  const deal = o.deal ?? DEAL;
  const commandId = await insertCommand(key, "routed_core", { deal, destination: "core" });
  const r = await sql(
    `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status, e2_ever_sent)
     VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-12345-ab', $4, $5) RETURNING id`,
    [commandId, deal, key, status, o.e2EverSent ?? false],
  );
  return r.rows[0].id as number;
}
const cmdStatus = async (key: string) => (await sql(`SELECT status FROM bidboard_create_outbox WHERE source_event_id = $1`, [key])).rows[0]?.status;
const coreStatus = async (key: string) => (await sql(`SELECT status FROM rfp_core_create_outbox WHERE source_event_id = $1`, [key])).rows[0]?.status;
const f1Errors = async () =>
  (await sql(`SELECT payload FROM bidboard_callback_outbox WHERE payload->>'status' = 'failed' ORDER BY id`)).rows.map((r) => r.payload.error);
const alertCodes = () => alertMock.mock.calls.map((c) => c[0]);
// r2 DIAGNOSTICS (a4): the r1 run saw S0a's preflight read "missing" (to_regclass NULL) on one of 2 concurrent enqueues. For
// every preflight these guards record, on the SAME pooled session that ran it: the database, backend pid, search_path, both
// to_regclass results, the same check by an MVCC pg_class / pg_namespace query, and the session's start vs the DDL commit.
const PREFLIGHT_RE = /to_regclass\('public\.rfp_core_create_outbox'\)/;
const DIAG_SQL = `
  SELECT current_database() AS db, pg_backend_pid() AS pid, current_user AS usr, current_setting('search_path') AS search_path,
         current_setting('application_name') AS application_name,
         to_regclass('public.rfp_core_create_outbox')::text AS regclass_create,
         to_regclass('public.rfp_core_followup_outbox')::text AS regclass_followup,
         (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname IN ('rfp_core_create_outbox', 'rfp_core_followup_outbox')) AS mvcc_tables,
         (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start`;
type PreflightCall = Record<string, unknown>;
/** The test db, except that each preflight query runs on an explicitly checked-out pooled session (what pool.query does
 *  internally) and that session's diagnostics are recorded right after it, before release. Everything else is untouched. */
function diagnosingDb(calls: PreflightCall[]) {
  const real = dbHolder.db;
  return {
    transaction: (fn: any, config?: any) => real.transaction(fn, config),
    execute: async (q: any) => {
      if (!PREFLIGHT_RE.test(JSON.stringify(q))) return real.execute(q);
      const client = await pool.connect();
      try {
        const res: any = await drizzle(client).execute(q);
        const diag = (await client.query(DIAG_SQL)).rows[0];
        calls.push({ preflight: res.rows?.[0] ?? null, ...diag });
        return res;
      } finally {
        client.release();
      }
    },
  };
}
async function sessionsSnapshot() {
  const r = await admin.query(
    `SELECT pid, datname, usename, application_name, backend_type, state, backend_start::text, xact_start::text,
            left(query, 400) AS query FROM pg_stat_activity
      WHERE backend_type IN ('client backend', 'autovacuum worker') ORDER BY pid`,
  );
  return r.rows;
}
const diagnosis = async (calls: PreflightCall[]) => {
  const text = JSON.stringify({
    ddlCommittedAt, envDatabaseUrlIsSentinel: process.env.DATABASE_URL === SENTINEL_DATABASE_URL, calls, sessions: await sessionsSnapshot(),
  });
  console.log(`[s0b1-r2 preflight diagnosis] ${text}`); // printed pass or fail, so either outcome carries the data
  return text;
};

async function until(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!BASE_URL)("lockRfpCreateDeal (real PG)", () => {
  it("holds rfp_create:<deal> for the transaction: another session cannot take that key, another deal's key stays free", async () => {
    await dbHolder.db.transaction(async (tx: any) => {
      await lockRfpCreateDeal(tx, DEAL);
      const same = (await sql(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`rfp_create:${DEAL}`])).rows[0].ok;
      expect(same).toBe(false);
      const other = (await sql(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`rfp_create:${OTHER_DEAL}`])).rows[0].ok;
      expect(other).toBe(true);
    });
  });
});

describe.skipIf(!BASE_URL)("readProcoreFootprint (real PG; d9 iii / iv)", () => {
  it("reports each Procore footprint kind for the deal", async () => {
    const kinds: Array<[string, () => Promise<unknown>]> = [
      ["command:processing", () => insertCommand("k-1", "processing")],
      ["command:reclaiming", () => insertCommand("k-1", "reclaiming")],
      ["command:needs_manual", () => insertCommand("k-1", "needs_manual")],
      ["command:done", () => insertCommand("k-1", "done")],
      ["command:recovered_project", () => insertCommand("k-1", "failed", { payload: { ...e1(), __recoveredProjectId: "900001" } })],
      ["request:approved", () => sql(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'approved')`, [DEAL])],
      ["request:override_approving", () => sql(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'override_approving')`, [DEAL])],
      ["sync_mapping", () => sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900002')`, [DEAL])],
    ];
    for (const [reason, seed] of kinds) {
      await sql(`TRUNCATE rfp_core_create_outbox, bidboard_create_outbox, sync_mappings, rfp_approval_requests RESTART IDENTITY CASCADE`);
      await seed();
      expect(await readProcoreFootprint(dbHolder.db, "trock_crm", DEAL), reason).toEqual([reason]);
    }
  });
  it("a pending or held Procore command, a pending request, an unmapped mapping row, a core-stamped row and another deal's rows are not footprints", async () => {
    await insertCommand("k-pending", "pending");
    await insertCommand("k-held", "held_cross_destination");
    await insertCore("k-core", "sent", { e2EverSent: true });
    await sql(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'pending')`, [DEAL]);
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, NULL)`, [DEAL]);
    await insertCommand("k-other", "done", { deal: OTHER_DEAL });
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('hubspot', $1, '900003')`, [DEAL]);
    expect(await readProcoreFootprint(dbHolder.db, "trock_crm", DEAL)).toEqual([]);
  });
});

describe.skipIf(!BASE_URL)("readCoreFootprint (real PG; §10, d9 qualifier)", () => {
  it("every Core row except refused counts, dead included: pending, sending, sent, failed, dead", async () => {
    for (const status of ["pending", "sending", "sent", "failed", "dead"]) {
      await sql(`TRUNCATE rfp_core_create_outbox, bidboard_create_outbox RESTART IDENTITY CASCADE`);
      await insertCore("k-core", status, { e2EverSent: status !== "pending" });
      expect(await readCoreFootprint(dbHolder.db, "trock_crm", DEAL), status).toEqual([`core:${status}`]);
    }
  });
  it("a held_cross_destination row counts once an E2 was ever sent (it may have created a bid), never before (d9 b / c)", async () => {
    await insertCore("k-sent-then-held", "held_cross_destination", { e2EverSent: true });
    expect(await readCoreFootprint(dbHolder.db, "trock_crm", DEAL)).toEqual(["core:held_cross_destination"]);
    await sql(`TRUNCATE rfp_core_create_outbox, bidboard_create_outbox RESTART IDENTITY CASCADE`);
    await insertCore("k-never-sent-held", "held_cross_destination", { e2EverSent: false });
    expect(await readCoreFootprint(dbHolder.db, "trock_crm", DEAL)).toEqual([]);
  });
  it("refused, a never-sent held row and another deal's rows are not footprints", async () => {
    await insertCore("k-refused", "refused", { e2EverSent: true });
    await insertCore("k-held", "held_cross_destination", { e2EverSent: false });
    await insertCore("k-other", "sent", { deal: OTHER_DEAL, e2EverSent: true });
    expect(await readCoreFootprint(dbHolder.db, "trock_crm", DEAL)).toEqual([]);
  });
});

describe.skipIf(!BASE_URL)("P1 the create-from-rfp enqueue holds on the other destination's footprint", () => {
  it("core first arrival with a Procore footprint (a done round) ⇒ the Core row is held_cross_destination, the command stays routed_core, alert + F1", async () => {
    await insertCommand(OLD_KEY, "done");
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await cmdStatus(VOTE_KEY)).toBe("routed_core");
    expect(alertCodes()).toContain("cross_destination_hold");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("core first arrival with an approved request or a Bid Board mapping for the deal ⇒ held the same way", async () => {
    const seeds: Array<[string, () => Promise<unknown>]> = [
      ["request approved", () => sql(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'approved')`, [DEAL])],
      ["sync mapping", () => sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900004')`, [DEAL])],
    ];
    for (const [label, seed] of seeds) {
      await sql(`TRUNCATE rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox, sync_mappings, rfp_approval_requests RESTART IDENTITY CASCADE`);
      await seed();
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      await enqueueBidboardCreateCommand(e1());
      expect(await coreStatus(VOTE_KEY), label).toBe("held_cross_destination");
      expect(await f1Errors(), label).toEqual(["cross_destination_hold"]);
    }
  });
  it("procore first arrival (an override) with a Core footprint ⇒ the command is held_cross_destination + alert + F1; a refused Core row is no footprint", async () => {
    for (const [coreRow, expected] of [["sent", "held_cross_destination"], ["dead", "held_cross_destination"], ["refused", "pending"]] as const) {
      await sql(`TRUNCATE rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox RESTART IDENTITY CASCADE`);
      alertMock.mockReset();
      await insertCore(OLD_KEY, coreRow, { e2EverSent: true });
      process.env.RFP_NONSERVICE_DESTINATION = "core";
      await enqueueBidboardCreateCommand(override());
      expect(await cmdStatus("crm:rfp-override:approved:1"), coreRow).toBe(expected);
      if (expected === "held_cross_destination") {
        expect(alertCodes(), coreRow).toContain("cross_destination_hold");
        expect(await f1Errors(), coreRow).toEqual(["cross_destination_hold"]);
      }
    }
  });
  it("a procore re-queue (failed, re-posted) with a Core footprint ⇒ held, not re-queued", async () => {
    await enqueueBidboardCreateCommand(e1({ sourceEventId: OLD_KEY }));
    await sql(`UPDATE bidboard_create_outbox SET status = 'failed' WHERE source_event_id = $1`, [OLD_KEY]);
    await insertCore(VOTE_KEY, "sent", { e2EverSent: true });
    await enqueueBidboardCreateCommand(e1({ sourceEventId: OLD_KEY }));
    expect(await cmdStatus(OLD_KEY)).toBe("held_cross_destination");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("a core RE-ARM (failed) with a Procore footprint ⇒ the Core row is held_cross_destination, not pending", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    await sql(`UPDATE rfp_core_create_outbox SET status = 'failed', attempt_count = 6, e2_ever_sent = true`);
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900005')`, [DEAL]);
    await enqueueBidboardCreateCommand(e1());
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("(d9 a) a vote held behind an override's override_approving leaves no Core footprint, so the override is not held in turn", async () => {
    await sql(`INSERT INTO rfp_approval_requests (source_system, source_deal_id, status) VALUES ('trock_crm', $1, 'override_approving')`, [DEAL]);
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await readCoreFootprint(dbHolder.db, "trock_crm", DEAL)).toEqual([]);
  });
  it("(d9 b) a Core row that died after an E2, re-armed and then held, is still a footprint: a later Procore create for the deal holds", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    await enqueueBidboardCreateCommand(e1());
    await sql(`UPDATE rfp_core_create_outbox SET status = 'dead', attempt_count = 6, e2_ever_sent = true`);
    await sql(`INSERT INTO sync_mappings (source_system, source_deal_id, bidboard_project_id) VALUES ('trock_crm', $1, '900006')`, [DEAL]);
    await enqueueBidboardCreateCommand(e1());
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    await sql(`DELETE FROM sync_mappings`);
    await enqueueBidboardCreateCommand(override());
    expect(await cmdStatus("crm:rfp-override:approved:1")).toBe("held_cross_destination");
  });
});

describe.skipIf(!BASE_URL)("P2 the Procore worker re-checks the Core footprint at claim, before Playwright (d9 iv)", () => {
  it("a pending procore row + a Core create for the deal ⇒ held at claim: no Playwright, held_cross_destination, alert + F1", async () => {
    await insertCommand(OLD_KEY, "pending");
    await insertCore(VOTE_KEY, "pending");
    const perform = vi.fn(async () => "created" as const);
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).not.toHaveBeenCalled();
    expect(await cmdStatus(OLD_KEY)).toBe("held_cross_destination");
    expect(alertCodes()).toContain("cross_destination_hold");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("no Core footprint ⇒ today's create runs once and the row is done", async () => {
    await insertCommand(OLD_KEY, "pending");
    const perform = vi.fn(async () => "created" as const);
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await cmdStatus(OLD_KEY)).toBe("done");
  });
});

describe.skipIf(!BASE_URL)("races on one deal (real PG, separate sessions)", () => {
  it("two concurrent posts of the same vote under core ⇒ one command row and one Core row, both calls resolve", async () => {
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const calls: PreflightCall[] = [];
    const real = dbHolder.db;
    dbHolder.db = diagnosingDb(calls);
    let settled: PromiseSettledResult<void>[];
    try {
      settled = await Promise.allSettled([enqueueBidboardCreateCommand(e1()), enqueueBidboardCreateCommand(e1())]);
    } finally {
      dbHolder.db = real;
    }
    const rejected = settled.flatMap((r) => (r.status === "rejected" ? [String((r.reason as any)?.message ?? r.reason)] : []));
    expect(rejected, await diagnosis(calls)).toEqual([]);
    expect((await sql(`SELECT count(*)::int AS n FROM bidboard_create_outbox`)).rows[0].n).toBe(1);
    expect((await sql(`SELECT count(*)::int AS n FROM rfp_core_create_outbox`)).rows[0].n).toBe(1);
  });
  it("the 0027 preflight reads present on every pooled session, 20 at once (r2 diagnostic)", async () => {
    const calls: PreflightCall[] = [];
    const db = diagnosingDb(calls);
    const results = await Promise.all(Array.from({ length: 20 }, () => preflightRfpCoreTables(db as any)));
    expect(results.filter((r) => r !== "present"), await diagnosis(calls)).toEqual([]);
  });
  it("a core vote arriving while the Procore create runs ⇒ the Procore create proceeds, the Core row is held + F1 (one destination)", async () => {
    await insertCommand(OLD_KEY, "pending", { payload: override({ sourceEventId: OLD_KEY }) });
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const perform = vi.fn(async () => {
      await enqueueBidboardCreateCommand(e1());
      return "created" as const;
    });
    await processBidboardCreateOutbox({ performImpl: perform as any });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(await coreStatus(VOTE_KEY)).toBe("held_cross_destination");
    expect(await cmdStatus(OLD_KEY)).toBe("done");
    expect(await f1Errors()).toEqual(["cross_destination_hold"]);
  });
  it("the worker's claim and a core vote released together from a held deal lock ⇒ exactly one destination survives, the other is held + F1", async () => {
    await insertCommand(OLD_KEY, "pending", { payload: override({ sourceEventId: OLD_KEY }) });
    process.env.RFP_NONSERVICE_DESTINATION = "core";
    const holder = await pool.connect();
    let drain: Promise<unknown> = Promise.resolve();
    let vote: Promise<unknown> = Promise.resolve();
    const perform = vi.fn(async () => "created" as const);
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rfp_create:${DEAL}`]);
      drain = processBidboardCreateOutbox({ performImpl: perform as any });
      await until(async () => (await cmdStatus(OLD_KEY)) !== "pending");
      vote = enqueueBidboardCreateCommand(e1());
      await new Promise((r) => setTimeout(r, 300));
      await holder.query("COMMIT");
      await Promise.all([drain, vote]);
    } finally {
      holder.release();
    }
    const outcome = {
      performCalls: perform.mock.calls.length,
      procore: await cmdStatus(OLD_KEY),
      core: await coreStatus(VOTE_KEY),
      f1: await f1Errors(),
    };
    expect([
      { performCalls: 1, procore: "done", core: "held_cross_destination", f1: ["cross_destination_hold"] },
      { performCalls: 0, procore: "held_cross_destination", core: "pending", f1: ["cross_destination_hold"] },
    ]).toContainEqual(outcome);
  });
});
