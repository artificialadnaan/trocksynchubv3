import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: logMock }));
vi.mock("../server/db.ts", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));

const {
  ensureLoginAlertStateTable,
  readLoginAlertState,
  recordLoginOutcomeAndMaybeAlert,
  upsertLoginAlertState,
  PROCORE_LOGIN_ALERT_SCOPE,
} = await import("../server/sync/procore-login-alert.ts");

/**
 * Runtime (PGlite) proof that the SHIPPED SQL parses and round-trips against real Postgres: the DDL
 * here is not a copy, it is ensureLoginAlertStateTable() itself, so the test cannot drift away from
 * the table the boot migration actually creates. Also proves the debounce is durable across separate
 * calls — i.e. a SyncHub restart mid-outage does not restart the email storm.
 */

const NOW = new Date("2026-08-03T14:00:00Z");
const MIN = 60_000;

let pg: PGlite;
let db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

beforeAll(async () => {
  pg = new PGlite();
  db = { query: async (text, params) => (await pg.query(text, params as any[])) as any };
}, 30000); // PGlite cold-start can exceed the default hook timeout under parallel runtime suites

beforeEach(async () => {
  await pg.exec(`DROP TABLE IF EXISTS procore_login_alert_state;`);
});

describe("procore_login_alert_state DDL (runtime)", () => {
  it("creates a table matching the reader/writer, and is idempotent", async () => {
    await ensureLoginAlertStateTable(db);
    await ensureLoginAlertStateTable(db); // CREATE TABLE IF NOT EXISTS — must not throw on re-run

    const { rows } = await db.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'procore_login_alert_state'
        ORDER BY ordinal_position`
    );
    expect(rows.map((r: any) => r.column_name)).toEqual([
      "scope",
      "state",
      "last_reason",
      "last_alerted_at",
      "last_success_at",
      "last_error",
      "updated_at",
    ]);
    // The debounce compares instants across runs and processes; a tz-naive column would skew it.
    const tz = rows.filter((r: any) => r.column_name.endsWith("_at"));
    expect(tz.every((r: any) => r.data_type === "timestamp with time zone")).toBe(true);
  });

  it("round-trips every field the debounce reads, including the failure signature", async () => {
    await ensureLoginAlertStateTable(db);
    await upsertLoginAlertState(
      PROCORE_LOGIN_ALERT_SCOPE,
      {
        state: "failing",
        lastReason: "credentials_rejected",
        lastAlertedAt: NOW,
        lastSuccessAt: new Date(NOW.getTime() - 90 * MIN),
        lastError: "Login failed: The email address or password you entered is not valid.",
        now: NOW,
      },
      db
    );

    const read = await readLoginAlertState(PROCORE_LOGIN_ALERT_SCOPE, db);
    expect(read).toMatchObject({ state: "failing", last_reason: "credentials_rejected" });
    expect(read!.last_alerted_at!.toISOString()).toBe(NOW.toISOString());
  });

  it("upserts on conflict rather than raising a duplicate key", async () => {
    await ensureLoginAlertStateTable(db);
    const write = (state: "ok" | "failing") =>
      upsertLoginAlertState(
        PROCORE_LOGIN_ALERT_SCOPE,
        { state, lastReason: null, lastAlertedAt: null, lastSuccessAt: NOW, lastError: null, now: NOW },
        db
      );
    await write("failing");
    await expect(write("ok")).resolves.toBeUndefined();
    expect((await readLoginAlertState(PROCORE_LOGIN_ALERT_SCOPE, db))!.state).toBe("ok");
  });

  it("self-heals the missing table on the first call from a standalone entrypoint", async () => {
    // No ensure call, no boot migration — recordLoginOutcomeAndMaybeAlert must create it itself
    // rather than swallow the very first alert of an outage.
    const send = vi.fn(async () => ({ success: true, provider: "gmail" }));
    const res = await recordLoginOutcomeAndMaybeAlert(
      {
        outcome: { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" },
        now: NOW,
        realertMinutes: 60,
        recipient: "ops@trock.test",
      },
      { db, send }
    );
    expect(res.action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    expect((await readLoginAlertState(PROCORE_LOGIN_ALERT_SCOPE, db))!.state).toBe("failing");
  });
});

describe("login-alert debounce durability across calls (runtime)", () => {
  const run = (outcome: any, now: Date, send: any) =>
    recordLoginOutcomeAndMaybeAlert(
      { outcome, now, realertMinutes: 60, recipient: "ops@trock.test" },
      { db, send }
    );

  it("survives a restart mid-outage: one email, then silence for the 19-minute cycles", async () => {
    await ensureLoginAlertStateTable(db);
    const fail = { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" };

    const first = vi.fn(async () => ({ success: true, provider: "gmail" }));
    await run(fail, NOW, first);
    expect(first).toHaveBeenCalledTimes(1);

    // A fresh send mock stands in for a restarted process: only the DB row carries the throttle.
    const afterRestart = vi.fn(async () => ({ success: true, provider: "gmail" }));
    for (const mins of [19, 38, 57]) await run(fail, new Date(NOW.getTime() + mins * MIN), afterRestart);
    expect(afterRestart).not.toHaveBeenCalled();

    // A different failure is a new incident even inside the window.
    const changed = vi.fn(async () => ({ success: true, provider: "gmail" }));
    await run({ ok: false, reason: "mfa_required", attempts: 3 }, new Date(NOW.getTime() + 60 * MIN), changed);
    expect(changed).toHaveBeenCalledTimes(1);

    // And recovery reports once, then goes quiet.
    const recovery = vi.fn(async () => ({ success: true, provider: "gmail" }));
    await run({ ok: true }, new Date(NOW.getTime() + 70 * MIN), recovery);
    await run({ ok: true }, new Date(NOW.getTime() + 89 * MIN), recovery);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect((await readLoginAlertState(PROCORE_LOGIN_ALERT_SCOPE, db))!.state).toBe("ok");
  });
});
