import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

// S0b-2b (runbook r5 §1; d9 Q7 + QB): alert `rfp_request_approving_stuck`. A request is stuck when it is `approving` and its
// rfp_approval_approving.started_at is more than 30 minutes old, OR it is `approving` with NO side-table row (age unknown: d9
// QB). One debounce key per request, re-alerting every 24 h; it clears ONLY when the row reaches approved / declined /
// held_cross_destination, never on an attempt. The payload is the id, source system, source deal id, project number and age:
// no names, no deal payload. The sweep runs every 10 minutes from the server's scheduler wiring.
// REAL postgres (the runner's throwaway postgres:18, DATABASE_URL), one fresh database per run. LIVE=1 without DATABASE_URL
// FAILS here; it never skips. The environment's DATABASE_URL points at an unroutable sentinel, so an un-mocked db import fails
// loudly. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S0b-2b stuck-alert tests");
const SENTINEL_DATABASE_URL = "postgres://s0b2-real-db-must-not-be-used.invalid:5432/sentinel";
process.env.DATABASE_URL = SENTINEL_DATABASE_URL;

const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
const cronSchedule = vi.hoisted(() => vi.fn((_expr: string, _fn: () => unknown, _opts?: unknown) => ({ stop: vi.fn() })));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return dbHolder.pool; } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("node-cron", () => ({ default: { schedule: cronSchedule }, schedule: cronSchedule }));

const {
  findStuckApprovingRequests,
  runRfpApprovingStuckSweep,
  RFP_APPROVING_STUCK_ALERT_CODE,
  RFP_APPROVING_STUCK_KEY_PREFIX,
} = await import("../server/sync/rfp-approving-stuck.ts");
const { startRfpApprovingStuckScheduler, stopRfpApprovingStuckScheduler, RFP_APPROVING_STUCK_SWEEP_CRON } = await import(
  "../server/cron/rfpApprovingStuckScheduler.ts"
);

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
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL,
    rfp_approval_request_id integer NOT NULL, payload jsonb NOT NULL, target_url text NOT NULL,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
  );
`;

let admin: pg.Client;
let pool: pg.Pool;
const DB_NAME = `s0b2b_stuck_${process.pid}_${Date.now()}`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

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
  const url = new URL(BASE_URL);
  url.pathname = `/${DB_NAME}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on("error", () => {});
  await sql(BASE_DDL);
  for (const file of ["0021_extend_pending_unique_indexes_to_override_approving.sql", "0023_create_bidboard_create_outbox.sql", "0027_rfp_core_routing.sql"]) {
    await sql(migration(file));
  }
  dbHolder.pool = pool;
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  if (!BASE_URL) return;
  await pool?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end();
});

const send = vi.fn(async (_m: { to: string; subject: string; htmlBody: string }) => ({ success: true }));
const RECIPIENT = "ops-alerts@example.test";
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_approval_approving, rfp_approval_requests RESTART IDENTITY CASCADE`);
  await sql(`DROP TABLE IF EXISTS bidboard_crm_push_alert_state`);
  send.mockReset();
  send.mockResolvedValue({ success: true });
});

const DEAL_NAME = "Synthetic Stuck Deal Name";
let seq = 0;
/** An `approving` request; `minutesAgo` null ⇒ no rfp_approval_approving row at all. */
async function insertApproving(minutesAgo: number | null, o: { status?: string; submitted?: boolean } = {}) {
  const n = ++seq;
  const r = await sql(
    `INSERT INTO rfp_approval_requests (source_system, source_deal_id, project_number, token, status, deal_data)
     VALUES ('trock_crm', $1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [`00000000-0000-4000-8000-0000000007${String(n).padStart(2, "0")}`, `DFW-2-7${String(n).padStart(4, "0")}-ab`, `synthetic-token-${n}`,
      o.status ?? "approving", JSON.stringify({ dealname: DEAL_NAME, approver: "someone@example.test" })],
  );
  const id = r.rows[0].id as number;
  if (minutesAgo !== null) {
    await sql(
      `INSERT INTO rfp_approval_approving (request_id, started_at, submit_at)
       VALUES ($1, now() - make_interval(mins => $2), CASE WHEN $3 THEN now() - make_interval(mins => $2) ELSE NULL END)`,
      [id, minutesAgo, o.submitted ?? false],
    );
  }
  return id;
}
const sweep = (now?: Date) => runRfpApprovingStuckSweep({ db: pool, recipient: RECIPIENT, send, now });
const sentSubjects = () => send.mock.calls.map((c) => c[0].subject);
const sentBodies = () => send.mock.calls.map((c) => c[0].htmlBody);

describe.skipIf(!BASE_URL)("rfp_request_approving_stuck: detection", () => {
  it("approving for 31 min ⇒ stuck and alerted; approving for 29 min ⇒ not stuck, no alert", async () => {
    const old = await insertApproving(31);
    const young = await insertApproving(29);
    const youngNumber = (await sql(`SELECT project_number FROM rfp_approval_requests WHERE id = $1`, [young])).rows[0].project_number;
    const res = await sweep();
    expect(res.stuck.map((s) => s.requestId)).toEqual([old]);
    expect(res.alerted).toEqual([old]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentSubjects()[0]).toContain(RFP_APPROVING_STUCK_ALERT_CODE);
    expect(sentBodies()[0]).not.toContain(youngNumber);
  });

  it("an approving request with NO rfp_approval_approving row is stuck with age null (d9 QB)", async () => {
    const id = await insertApproving(null);
    const stuck = await findStuckApprovingRequests(pool, new Date());
    expect(stuck).toEqual([expect.objectContaining({ requestId: id, ageMinutes: null })]);
    const res = await sweep();
    expect(res.alerted).toEqual([id]);
  });

  it("only `approving` rows: a 2 h old side row whose request is pending / override_approving / approved is not stuck", async () => {
    for (const status of ["pending", "override_approving", "approved"]) await insertApproving(120, { status });
    expect(await findStuckApprovingRequests(pool, new Date())).toEqual([]);
    expect((await sweep()).alerted).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("the payload is the id, source system, source deal id, project number and age: no names, no deal payload", async () => {
    const id = await insertApproving(45);
    const seeded = (await sql(`SELECT source_deal_id, project_number FROM rfp_approval_requests WHERE id = $1`, [id])).rows[0];
    const rows = await findStuckApprovingRequests(pool, new Date());
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(Object.keys(row).sort()).toEqual(["ageMinutes", "projectNumber", "requestId", "sourceDealId", "sourceSystem"]);
    expect(row).toMatchObject({ requestId: id, sourceSystem: "trock_crm", sourceDealId: seeded.source_deal_id, projectNumber: seeded.project_number });
    expect(row.ageMinutes).toBeGreaterThanOrEqual(45);
    expect(row.ageMinutes).toBeLessThan(47);
    await sweep();
    expect(send).toHaveBeenCalledTimes(1);
    const body = sentBodies()[0];
    expect(body).toContain(seeded.project_number);
    expect(body).toContain(seeded.source_deal_id);
    expect(body).not.toContain(DEAL_NAME);
    expect(body).not.toContain("someone@example.test");
  });
});

describe.skipIf(!BASE_URL)("rfp_request_approving_stuck: one debounce key per request, 24 h re-alert", () => {
  it("each stuck request is alerted under its own key", async () => {
    const a = await insertApproving(40);
    const b = await insertApproving(90);
    const res = await sweep();
    expect(res.alerted.sort()).toEqual([a, b].sort());
    expect(send).toHaveBeenCalledTimes(2);
    const keys = (await sql(`SELECT office_slug, state FROM bidboard_crm_push_alert_state ORDER BY office_slug`)).rows;
    expect(keys).toEqual([
      { office_slug: `${RFP_APPROVING_STUCK_KEY_PREFIX}${a}`, state: "failing" },
      { office_slug: `${RFP_APPROVING_STUCK_KEY_PREFIX}${b}`, state: "failing" },
    ]);
  });

  it("still stuck an hour later ⇒ no repeat; still stuck 24 h later ⇒ alerted again", async () => {
    const id = await insertApproving(40);
    const t0 = new Date();
    expect((await sweep(t0)).alerted).toEqual([id]);
    expect((await sweep(new Date(t0.getTime() + 60 * 60_000))).alerted).toEqual([]);
    expect((await sweep(new Date(t0.getTime() + 24 * 60 * 60_000))).alerted).toEqual([id]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!BASE_URL)("rfp_request_approving_stuck: clears only on a terminal status", () => {
  it("an attempt (submit_at now set) while still approving does NOT clear it", async () => {
    const id = await insertApproving(40);
    expect((await sweep()).alerted).toEqual([id]);
    await sql(`UPDATE rfp_approval_approving SET submit_at = now() WHERE request_id = $1`, [id]);
    const res = await sweep();
    expect(res.cleared).toEqual([]);
    expect((await sql(`SELECT state FROM bidboard_crm_push_alert_state WHERE office_slug = $1`, [`${RFP_APPROVING_STUCK_KEY_PREFIX}${id}`])).rows[0]?.state).toBe("failing");
  });

  for (const terminal of ["approved", "declined", "held_cross_destination"]) {
    it(`the row reaches ${terminal} ⇒ ONE cleared email and the key goes ok`, async () => {
      const id = await insertApproving(40);
      expect((await sweep()).alerted).toEqual([id]);
      await sql(`UPDATE rfp_approval_requests SET status = $2 WHERE id = $1`, [id, terminal]);
      const res = await sweep();
      expect(res.cleared).toEqual([id]);
      expect(send).toHaveBeenCalledTimes(2);
      expect((await sql(`SELECT state FROM bidboard_crm_push_alert_state WHERE office_slug = $1`, [`${RFP_APPROVING_STUCK_KEY_PREFIX}${id}`])).rows[0]?.state).toBe("ok");
      expect((await sweep()).cleared).toEqual([]);
      expect(send).toHaveBeenCalledTimes(2);
    });
  }

  it("a stuck row that goes back to a NON-terminal status (pending) is not cleared", async () => {
    const id = await insertApproving(40);
    expect((await sweep()).alerted).toEqual([id]);
    await sql(`UPDATE rfp_approval_requests SET status = 'pending' WHERE id = $1`, [id]);
    expect((await sweep()).cleared).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("rfp_request_approving_stuck: the 10-minute scheduler", () => {
  it("start schedules the sweep every 10 minutes; stop stops it", () => {
    cronSchedule.mockClear();
    startRfpApprovingStuckScheduler();
    expect(RFP_APPROVING_STUCK_SWEEP_CRON).toBe("*/10 * * * *");
    expect(cronSchedule).toHaveBeenCalledTimes(1);
    expect(cronSchedule.mock.calls[0][0]).toBe("*/10 * * * *");
    const task = cronSchedule.mock.results[0]?.value;
    stopRfpApprovingStuckScheduler();
    expect(task?.stop).toHaveBeenCalledTimes(1);
  });

  it("the server starts it with the other schedulers (server/routes/index.ts)", () => {
    const src = readFileSync(new URL("../server/routes/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ startRfpApprovingStuckScheduler \} from "\.\.\/cron\/rfpApprovingStuckScheduler"/);
    expect(src).toMatch(/^\s*startRfpApprovingStuckScheduler\(\);/m);
  });
});
