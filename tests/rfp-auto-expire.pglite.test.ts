import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// RFP approval auto-expiry (owner e28361c1, "30 days"; a4: quiet, its own switch, default off). Real Postgres (PGlite)
// with the production change-log trigger (migrations 0005 + 0003), so the ONE statement runs its actual SQL.
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() {
    return dbHolder.db;
  },
  get pool() {
    return dbHolder.pool;
  },
}));

const {
  RFP_AUTO_EXPIRE_DEFAULT_DAYS,
  RFP_AUTO_EXPIRED_ACTION,
  countStalePendingRfpRequests,
  expireStalePendingRfpRequests,
  rfpAutoExpireOptions,
  runRfpAutoExpire,
} = await import("../server/rfpAutoExpire.ts");

const DDL = `
  CREATE TABLE rfp_approval_requests (
    id SERIAL PRIMARY KEY,
    source_system text NOT NULL DEFAULT 'hubspot',
    source_deal_id text NOT NULL,
    source_event_id text,
    project_number text,
    hubspot_deal_id text,
    token text NOT NULL UNIQUE,
    token_expires_at timestamp,
    status text NOT NULL DEFAULT 'pending',
    deal_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    edited_fields jsonb,
    approved_attachments jsonb,
    approved_by text,
    approved_at timestamp,
    declined_by text,
    declined_at timestamp,
    bidboard_project_id text,
    created_at timestamp DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_rfp_approval_live_source_deal ON rfp_approval_requests(source_system, source_deal_id)
    WHERE status IN ('pending', 'approving', 'override_approving');
  CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY, action text NOT NULL, entity_type text NOT NULL, entity_id text, source text NOT NULL,
    destination text, status text NOT NULL, details jsonb, error_message text, duration_ms integer, user_id varchar,
    idempotency_key text, created_at timestamp DEFAULT now(), category text NOT NULL DEFAULT 'system'
  );
  CREATE TABLE rfp_approval_approving (request_id integer PRIMARY KEY REFERENCES rfp_approval_requests(id), started_at timestamp NOT NULL DEFAULT now(), submit_at timestamp);
  CREATE TABLE bidboard_callback_outbox (id SERIAL PRIMARY KEY, rfp_approval_request_id integer);
  CREATE TABLE service_rfp_core_outbox (id SERIAL PRIMARY KEY, rfp_request_id integer NOT NULL);
`;
const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

let pg: PGlite;
let exec: any;
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  await pg.exec(migration("0005_ensure_rfp_change_log.sql"));
  await pg.exec(migration("0003_rfp_change_log_trigger.sql"));
  exec = drizzle(pg);
  dbHolder.pool = pg;
  dbHolder.db = exec;
});

let seq = 0;
/** One request sent `ageSql` ago (an SQL interval), e.g. '31 days'. Returns its id. */
async function seed(ageSql: string | null, cols: { status?: string; tokenExpiresSql?: string; bidboard?: string; deal?: string } = {}) {
  seq += 1;
  const created = ageSql === null ? "NULL" : `(now() AT TIME ZONE 'UTC') - interval '${ageSql}'`;
  const expires = cols.tokenExpiresSql ?? "NULL";
  const res = await pg.query<{ id: number }>(
    `INSERT INTO rfp_approval_requests (source_deal_id, token, status, bidboard_project_id, created_at, token_expires_at)
     VALUES ($1, $2, $3, $4, ${created}, ${expires}) RETURNING id`,
    [cols.deal ?? `deal-${seq}`, `tok-${seq}`, cols.status ?? "pending", cols.bidboard ?? null],
  );
  return res.rows[0].id;
}
const one = async <T = any>(q: string, p: unknown[] = []) => (await pg.query<T>(q, p)).rows[0] as T;
const n = async (q: string, p: unknown[] = []) => Number((await one<{ n: number }>(q, p)).n);
const statusOf = async (id: number) => (await one<{ status: string }>("SELECT status FROM rfp_approval_requests WHERE id = $1", [id])).status;

describe("which requests expire (default 30 days)", () => {
  it("moves a pending request sent 31 days ago to 'expired', link expired now, with ONE system audit row", async () => {
    const id = await seed("31 days");
    const r = await expireStalePendingRfpRequests(30, exec);
    expect(r).toEqual({ expired: 1, audited: 1, ids: [id] });
    const row = await one<any>(
      "SELECT status, token_expires_at <= (now() AT TIME ZONE 'UTC') AS dead, token_expires_at > (now() AT TIME ZONE 'UTC') - interval '1 minute' AS just_now FROM rfp_approval_requests WHERE id = $1",
      [id],
    );
    expect(row).toEqual({ status: "expired", dead: true, just_now: true });
    const audit = await pg.query<any>("SELECT action, entity_type, entity_id, source, status, category, idempotency_key, details FROM audit_logs");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: RFP_AUTO_EXPIRED_ACTION, entity_type: "deal", entity_id: `deal-${seq}`, source: "rfp-auto-expire",
      status: "success", category: "system", idempotency_key: `rfp_auto_expired:${id}`,
    });
    expect(audit.rows[0].details).toMatchObject({ requestId: id, days: 30, from: { status: "pending", token_expires_at: null }, to: { status: "expired" } });
  });

  it("the boundary: 30 days + 1 hour expires, 30 days - 1 hour stays pending", async () => {
    const over = await seed("30 days 1 hour");
    const under = await seed("29 days 23 hours");
    expect((await expireStalePendingRfpRequests(30, exec)).ids).toEqual([over]);
    expect(await statusOf(under)).toBe("pending");
  });

  it("leaves every non-pending status alone", async () => {
    const ids = [];
    for (const status of ["approved", "declined", "approving", "override_approving", "held_cross_destination", "cancelled_source_ineligible", "expired"]) {
      ids.push([await seed("90 days", { status, deal: `d-${status}` }), status] as const);
    }
    expect((await expireStalePendingRfpRequests(30, exec)).expired).toBe(0);
    for (const [id, status] of ids) expect(await statusOf(id)).toBe(status);
    expect(await n("SELECT count(*)::int AS n FROM audit_logs")).toBe(0);
  });

  it("never touches a request with an approval attempt, a Bid Board project, or an approving / callback / Core outbox row", async () => {
    const attempted = await seed("60 days");
    await pg.query("INSERT INTO audit_logs (action, entity_type, source, status, details) VALUES ('rfp_approval_attempt', 'deal', 'rfp-approval', 'failed', $1)", [JSON.stringify({ requestId: attempted })]);
    const withBidboard = await seed("60 days", { bidboard: "bb-1" });
    const approving = await seed("60 days");
    await pg.query("INSERT INTO rfp_approval_approving (request_id) VALUES ($1)", [approving]);
    const callback = await seed("60 days");
    await pg.query("INSERT INTO bidboard_callback_outbox (rfp_approval_request_id) VALUES ($1)", [callback]);
    const coreOutbox = await seed("60 days");
    await pg.query("INSERT INTO service_rfp_core_outbox (rfp_request_id) VALUES ($1)", [coreOutbox]);
    const plain = await seed("60 days");
    expect((await expireStalePendingRfpRequests(30, exec)).ids).toEqual([plain]);
    for (const id of [attempted, withBidboard, approving, callback, coreOutbox]) expect(await statusOf(id)).toBe("pending");
  });

  it("an attempt on a DIFFERENT request does not protect this one (the requestId match is exact)", async () => {
    const a = await seed("60 days");
    await pg.query("INSERT INTO audit_logs (action, entity_type, source, status, details) VALUES ('rfp_approval_attempt', 'deal', 'rfp-approval', 'failed', $1)", [JSON.stringify({ requestId: a + 1000 })]);
    expect((await expireStalePendingRfpRequests(30, exec)).ids).toEqual([a]);
  });

  it("a request with no created_at has no age and is skipped", async () => {
    const id = await seed(null);
    expect((await expireStalePendingRfpRequests(30, exec)).expired).toBe(0);
    expect(await statusOf(id)).toBe("pending");
  });

  it("keeps an EARLIER link expiry (a dead link keeps its real date); a live or never-expiring link becomes now", async () => {
    const dead = await seed("90 days", { tokenExpiresSql: "TIMESTAMP '2026-05-13 12:00:00'" });
    const live = await seed("90 days", { tokenExpiresSql: "(now() AT TIME ZONE 'UTC') + interval '30 days'" });
    const never = await seed("90 days");
    await expireStalePendingRfpRequests(30, exec);
    const rows = await pg.query<any>(
      "SELECT id, token_expires_at = TIMESTAMP '2026-05-13 12:00:00' AS kept, token_expires_at <= (now() AT TIME ZONE 'UTC') AS dead FROM rfp_approval_requests ORDER BY id",
    );
    expect(rows.rows).toEqual([
      { id: dead, kept: true, dead: true },
      { id: live, kept: false, dead: true },
      { id: never, kept: false, dead: true },
    ]);
    const audit = await one<any>("SELECT details FROM audit_logs WHERE (details ->> 'requestId')::int = $1", [dead]);
    expect(audit.details.from.token_expires_at).toMatch(/^2026-05-13T12:00:00/);
  });

  it("is idempotent: a second run expires nothing and writes no audit row", async () => {
    await seed("31 days");
    await seed("45 days");
    expect((await expireStalePendingRfpRequests(30, exec)).expired).toBe(2);
    expect(await expireStalePendingRfpRequests(30, exec)).toEqual({ expired: 0, audited: 0, ids: [] });
    expect(await n("SELECT count(*)::int AS n FROM audit_logs")).toBe(2);
  });

  it("a batch limit takes the lowest ids first and the next run takes the rest", async () => {
    const ids = [await seed("40 days"), await seed("41 days"), await seed("42 days")];
    expect((await expireStalePendingRfpRequests(30, exec, 2)).ids).toEqual(ids.slice(0, 2));
    expect((await expireStalePendingRfpRequests(30, exec, 2)).ids).toEqual(ids.slice(2));
  });

  it("honours a configured window: a 40-day-old request stays under 45 days and expires under 30", async () => {
    const id = await seed("40 days");
    expect((await expireStalePendingRfpRequests(45, exec)).expired).toBe(0);
    expect((await expireStalePendingRfpRequests(30, exec)).ids).toEqual([id]);
  });
});

describe("quiet: nothing outbound", () => {
  it("writes no callback / Core outbox row, and the module has no email, HubSpot, CRM or Core path", async () => {
    await seed("31 days");
    await expireStalePendingRfpRequests(30, exec);
    expect(await n("SELECT count(*)::int AS n FROM bidboard_callback_outbox")).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM service_rfp_core_outbox")).toBe(0);
    const src = readFileSync(new URL("../server/rfpAutoExpire.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^import /.test(l));
    expect(imports).toEqual(['import { sql } from "drizzle-orm";', 'import { db } from "./db";']);
  });

  it("the production change-log trigger records the status change locally (rfp_change_log)", async () => {
    const id = await seed("31 days");
    await expireStalePendingRfpRequests(30, exec);
    const log = await pg.query<any>("SELECT field_changed, old_value, new_value FROM rfp_change_log WHERE rfp_id = $1 AND field_changed = 'status'", [id]);
    expect(log.rows).toEqual([{ field_changed: "status", old_value: "pending", new_value: "expired" }]);
  });

  it("the source deal is free again: a re-sent RFP for it can open a new pending request", async () => {
    await seed("31 days", { deal: "deal-resend" });
    await expireStalePendingRfpRequests(30, exec);
    await expect(seed("0 days", { deal: "deal-resend" })).resolves.toBeGreaterThan(0);
  });
});

describe("the switch and the window (a4: its own switch, default OFF)", () => {
  it("unset: off, 30 days", () => {
    expect(rfpAutoExpireOptions({})).toEqual({ ok: true, enabled: false, days: RFP_AUTO_EXPIRE_DEFAULT_DAYS });
    expect(RFP_AUTO_EXPIRE_DEFAULT_DAYS).toBe(30);
  });

  it("on only for exactly \"true\"", () => {
    expect(rfpAutoExpireOptions({ PENDING_RFP_AUTO_EXPIRE: "true" })).toMatchObject({ ok: true, enabled: true });
    for (const v of ["TRUE", "1", "yes", " true", ""]) expect(rfpAutoExpireOptions({ PENDING_RFP_AUTO_EXPIRE: v })).toMatchObject({ enabled: false });
  });

  it("days: a whole number from 1 to 3650; anything else refuses to run", () => {
    expect(rfpAutoExpireOptions({ PENDING_RFP_AUTO_EXPIRE_DAYS: "45" })).toEqual({ ok: true, enabled: false, days: 45 });
    expect(rfpAutoExpireOptions({ PENDING_RFP_AUTO_EXPIRE_DAYS: " " })).toEqual({ ok: true, enabled: false, days: 30 });
    for (const v of ["0", "-1", "30.5", "abc", "3651", "030", "1e2"]) {
      expect(rfpAutoExpireOptions({ PENDING_RFP_AUTO_EXPIRE: "true", PENDING_RFP_AUTO_EXPIRE_DAYS: v })).toMatchObject({ ok: false, enabled: false });
    }
  });
});

describe("the daily run", () => {
  it("OFF: logs how many WOULD expire and writes nothing", async () => {
    const a = await seed("31 days");
    await seed("2 days");
    const lines: string[] = [];
    expect(await runRfpAutoExpire({}, exec, (l) => lines.push(l))).toEqual({ mode: "dry-run", count: 1 });
    expect(await countStalePendingRfpRequests(30, exec)).toBe(1);
    expect(await statusOf(a)).toBe("pending");
    expect(await n("SELECT count(*)::int AS n FROM audit_logs")).toBe(0);
    expect(lines).toEqual(['[rfp-auto-expire] OFF (PENDING_RFP_AUTO_EXPIRE is not "true"): 1 pending request(s) older than 30 days would expire']);
  });

  it("ON: expires and logs the count and ids", async () => {
    const a = await seed("31 days");
    const lines: string[] = [];
    expect(await runRfpAutoExpire({ PENDING_RFP_AUTO_EXPIRE: "true" }, exec, (l) => lines.push(l))).toEqual({ mode: "expired", count: 1 });
    expect(await statusOf(a)).toBe("expired");
    expect(lines).toEqual([`[rfp-auto-expire] expired=1 audited=1 days=30 ids=${a}`]);
  });

  it("a bad window refuses to run, even switched on", async () => {
    const a = await seed("31 days");
    const lines: string[] = [];
    expect(await runRfpAutoExpire({ PENDING_RFP_AUTO_EXPIRE: "true", PENDING_RFP_AUTO_EXPIRE_DAYS: "3" + "o" }, exec, (l) => lines.push(l))).toEqual({ mode: "refused", count: 0 });
    expect(await statusOf(a)).toBe("pending");
    expect(lines[0]).toMatch(/^\[rfp-auto-expire\] NOT RUN: PENDING_RFP_AUTO_EXPIRE_DAYS must be a whole number/);
  });

  it("a database error is logged, never thrown", async () => {
    await pg.exec("DROP TABLE service_rfp_core_outbox");
    const lines: string[] = [];
    await expect(runRfpAutoExpire({ PENDING_RFP_AUTO_EXPIRE: "true" }, exec, (l) => lines.push(l))).resolves.toEqual({ mode: "refused", count: 0 });
    expect(lines[0]).toMatch(/^\[rfp-auto-expire\] FAILED: /);
  });
});

describe("scheduling", () => {
  it("runs daily at 3:10 AM America/Chicago (no approver acting; before the 5:00 PM digest), and the server starts it beside the digest", async () => {
    const schedule = vi.fn(() => ({ stop: vi.fn() }));
    vi.doMock("node-cron", () => ({ default: { schedule } }));
    const { startRfpAutoExpireScheduler, stopRfpAutoExpireScheduler, RFP_AUTO_EXPIRE_CRON } = await import("../server/cron/rfpAutoExpireScheduler.ts");
    startRfpAutoExpireScheduler();
    expect(RFP_AUTO_EXPIRE_CRON).toBe("10 3 * * *");
    expect(schedule).toHaveBeenCalledWith("10 3 * * *", expect.any(Function), { timezone: "America/Chicago" });
    stopRfpAutoExpireScheduler();
    vi.doUnmock("node-cron");
    const index = readFileSync(new URL("../server/routes/index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/startPendingRfpDigestScheduler\(\);\n\s*startRfpAutoExpireScheduler\(\);/);
  });
});
