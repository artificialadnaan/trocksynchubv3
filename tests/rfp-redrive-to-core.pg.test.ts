import { readFileSync } from "fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// S1b (REDRIVE-DESIGN.r2 §3) on REAL postgres, where separate sessions make the races real: the re-drive's --apply runs in ONE
// transaction under the per-deal lock `rfp_create:<deal>` and RE-CHECKS its preconditions there. Two applies racing on one
// deal ⇒ ONE row, the other refused by (b) (never a unique-violation error); an apply that waits on the lock held by another
// create path re-checks after it, so a Core row that path committed ⇒ refused. The runner's throwaway postgres
// (DATABASE_URL), one fresh database per run; LIVE=1 without DATABASE_URL FAILS, it never skips. Synthetic data only (I7).
const LIVE = process.env.LIVE === "1";
const BASE_URL = process.env.DATABASE_URL;
if (LIVE && !BASE_URL) throw new Error("LIVE=1 needs DATABASE_URL (a real postgres): refusing to skip the S1b re-drive race tests");
const SENTINEL_DATABASE_URL = "postgres://s1b-real-db-must-not-be-used.invalid:5432/sentinel";
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
const { runRedriveToCore } = await import("../server/sync/rfp-redrive-to-core.ts");

const DDL_0023 = readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8");
const DDL_0027 = readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8");

const DEAL = "00000000-0000-4000-8000-0000000000e1";
const KEY = "crm:rfp-vote:approved:round-3";
const OTHER_KEY = "crm:rfp-vote:approved:round-4";
const GO = "A4-GO-SYN-REDRIVE-0002";
const CORE_ENV = { RFP_NONSERVICE_DESTINATION: "core" } as NodeJS.ProcessEnv;

let admin: pg.Client;
let pool: pg.Pool;
let savedSetting: string | undefined;
const DB_NAME = `s1b_redrive_${process.pid}_${Date.now()}`;
const sql = (text: string, params: unknown[] = []) => pool.query(text, params);

async function waitNoSessions(name: string) {
  for (let i = 0; i < 100; i++) {
    const n = Number((await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [name])).rows[0].n);
    if (n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
beforeAll(async () => {
  savedSetting = process.env.RFP_NONSERVICE_DESTINATION;
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
    CREATE TABLE audit_logs (
      id serial PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text, source text NOT NULL,
      destination text, status text NOT NULL, details jsonb, error_message text, duration_ms integer, user_id varchar,
      idempotency_key text, category text NOT NULL DEFAULT 'system', created_at timestamp DEFAULT now()
    );
  `);
  await sql(DDL_0023);
  await sql(DDL_0027);
  dbHolder.pool = pool;
  dbHolder.db = drizzle(pool);
}, 60000);
afterAll(async () => {
  process.env.DATABASE_URL = BASE_URL; // the sentinel must not outlive this file in a reused worker
  if (savedSetting === undefined) delete process.env.RFP_NONSERVICE_DESTINATION;
  else process.env.RFP_NONSERVICE_DESTINATION = savedSetting;
  if (!BASE_URL) return;
  await pool?.end();
  if (admin) await waitNoSessions(DB_NAME);
  await admin?.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin?.end();
});
beforeEach(async () => {
  if (!BASE_URL) return;
  await sql(`TRUNCATE rfp_core_followup_outbox, rfp_core_create_outbox, bidboard_create_outbox, bidboard_callback_outbox, audit_logs
             RESTART IDENTITY CASCADE`);
  alertMock.mockReset();
  delete process.env.RFP_NONSERVICE_DESTINATION;
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
async function seedProcoreDone() {
  await enqueueBidboardCreateCommand(e1()); // setting unset ⇒ procore
  await sql(`UPDATE bidboard_create_outbox SET status = 'done', processed_at = NOW() WHERE source_event_id = $1`, [KEY]);
  return (await sql(`SELECT id FROM bidboard_create_outbox WHERE source_event_id = $1`, [KEY])).rows[0].id as number;
}
const APPLY = ["--deal", DEAL, "--source-event-id", KEY, "--go", GO, "--actor", "Synthetic Operator", "--apply"];
const apply = () => runRedriveToCore(APPLY, { db: dbHolder.db, out: () => {}, env: CORE_ENV, osUser: "os:synthetic-runner" } as any);
const count = async (table: string) => Number((await sql(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
async function until(cond: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(!BASE_URL)("the re-drive --apply under the per-deal lock (real PG, separate sessions)", () => {
  it("two applies racing on one deal ⇒ ONE row and ONE audit row; the other is refused by (b), never a unique-violation error", async () => {
    await seedProcoreDone();
    const results = await Promise.allSettled([apply(), apply()]);
    const errors = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as any)?.message ?? r.reason)] : []));
    expect(errors).toEqual([]);
    const codes = results.map((r) => (r.status === "fulfilled" ? r.value.code : -1)).sort();
    expect(codes).toEqual([0, 1]);
    const refused = results.flatMap((r) => (r.status === "fulfilled" && r.value.code === 1 ? [r.value.refused ?? ""] : []));
    expect(refused[0]).toContain("(b)");
    expect(await count("rfp_core_create_outbox")).toBe(1);
    expect(await count("audit_logs")).toBe(1);
    expect(alertMock.mock.calls.map((c) => c[0])).toEqual(["rfp_operator_redrive_applied"]);
  });
  it("an apply WAITS on rfp_create:<deal> held by another create path and re-checks after it: that path's committed Core row ⇒ refused", async () => {
    const commandId = await seedProcoreDone();
    const holder = await pool.connect();
    let waited = false;
    let result: Awaited<ReturnType<typeof apply>> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rfp_create:${DEAL}`]);
      await holder.query(
        `INSERT INTO rfp_core_create_outbox (command_id, source_system, source_deal_id, source_event_id, project_number, status)
         VALUES ($1, 'trock_crm', $2, $3, 'DFW-2-12345-ab', 'pending')`,
        [commandId, DEAL, OTHER_KEY],
      );
      const running = apply();
      waited = await until(async () =>
        Number((await sql(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
                            WHERE d.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`)).rows[0].n) > 0);
      await holder.query("COMMIT");
      result = await running;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
    expect(waited).toBe(true);
    expect(result).toMatchObject({ code: 1, applied: false });
    expect(result?.refused).toContain("(b)");
    expect((await sql(`SELECT source_event_id FROM rfp_core_create_outbox ORDER BY id`)).rows).toEqual([{ source_event_id: OTHER_KEY }]);
    expect(await count("audit_logs")).toBe(0);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
