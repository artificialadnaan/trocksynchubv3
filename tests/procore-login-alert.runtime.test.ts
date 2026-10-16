import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: logMock }));
vi.mock("../server/db.ts", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));

const {
  ensureLoginAlertStateTable,
  readLoginAlertState,
  recordLoginOutcomeAndMaybeAlert,
  renderLoginAlertEmail,
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

  it("does not mark a Querier as ensured when the DDL fails — the next call retries and alerts", async () => {
    // Needs a REAL database: with an in-memory fake the SELECT succeeds whether or not the table
    // exists, so the bug (memoising before the DDL succeeded) is invisible. Here the second call
    // would query a table that was never created, the outer catch would swallow it, and the outage
    // would produce no email at all.
    let failNextDdl = true;
    const flaky = {
      query: async (text: string, params?: any[]) => {
        if (failNextDdl && text.includes("CREATE TABLE")) {
          failNextDdl = false;
          throw new Error("transient DB blip");
        }
        return db.query(text, params);
      },
    };
    const send = vi.fn(async () => ({ success: true, provider: "gmail" }));
    const args = {
      outcome: { ok: false, reason: "credentials_rejected" as const, attempts: 3 },
      realertMinutes: 60,
      recipient: "ops@trock.test",
    };

    const blipped = await recordLoginOutcomeAndMaybeAlert({ ...args, now: NOW }, { db: flaky, send });
    expect(blipped.action).toBe("none"); // swallowed — never crashes the automation
    expect(send).not.toHaveBeenCalled();

    const retried = await recordLoginOutcomeAndMaybeAlert(
      { ...args, now: new Date(NOW.getTime() + MIN) },
      { db: flaky, send }
    );
    expect(retried.action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
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

    // A different failure inside the window is NOT a fresh email (owner, 2026-10-15: at most one sign-in
    // email a day while it stays failed). The unverified-login and export sign-in checks can report
    // different reasons on alternate cycles, and each flip used to email.
    const changed = vi.fn(async () => ({ success: true, provider: "gmail" }));
    await run({ ok: false, reason: "mfa_required", attempts: 3 }, new Date(NOW.getTime() + 45 * MIN), changed);
    expect(changed).not.toHaveBeenCalled();

    // And recovery reports once, then goes quiet.
    const recovery = vi.fn(async () => ({ success: true, provider: "gmail" }));
    await run({ ok: true }, new Date(NOW.getTime() + 70 * MIN), recovery);
    await run({ ok: true }, new Date(NOW.getTime() + 89 * MIN), recovery);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect((await readLoginAlertState(PROCORE_LOGIN_ALERT_SCOPE, db))!.state).toBe("ok");
  });
});

// ── 2026-10: the session-not-established failure, the pinned recipient, and secret hygiene ──────────

describe("session_not_established failures (runtime)", () => {
  const OWNER = "aiqbal@trockgc.com";
  const SECRET = "unit-test-not-a-password-9f3a";
  const prevEnv = process.env.BIDBOARD_CRM_ALERT_RECIPIENT;

  const fail = {
    ok: false,
    reason: "session_not_established" as const,
    error:
      "Export menu button not found because SyncHub cannot confirm a Procore session (no authenticated-session " +
      `element found on the page) at https://us02.procore.com/tools/bid-board?email=automation%40example.invalid&pw=${SECRET}`,
    blocking: "Bid Board stage sync (Excel export)",
  };

  beforeEach(async () => {
    // The ensure-once memo outlives the per-test DROP, so create the table explicitly.
    await ensureLoginAlertStateTable(db);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    else process.env.BIDBOARD_CRM_ALERT_RECIPIENT = prevEnv;
  });

  it("flips the state to failing, stores a secret-free last_error, and emails ONLY the owner", async () => {
    // Whatever the shared ops variable says — staff, clients, a comma list — this alert goes to the owner alone.
    process.env.BIDBOARD_CRM_ALERT_RECIPIENT = "staff@trockgc.com, client@example.com";
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));

    const res = await recordLoginOutcomeAndMaybeAlert(
      { outcome: fail, now: NOW, realertMinutes: 60, redact: [SECRET] },
      { db, send }
    );

    expect(res.action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe(OWNER);
    expect(msg.cc ?? []).toEqual([]);
    expect(msg.bypassGlobalCc).toBe(true);
    expect(JSON.stringify(msg)).not.toContain(SECRET);
    expect(JSON.stringify(msg)).not.toMatch(/staff@|client@/);

    const { rows } = await db.query(`SELECT state, last_reason, last_error FROM procore_login_alert_state WHERE scope = $1`, [
      PROCORE_LOGIN_ALERT_SCOPE,
    ]);
    expect(rows[0].state).toBe("failing");
    expect(rows[0].last_reason).toBe("session_not_established");
    expect(rows[0].last_error).toMatch(/cannot confirm a Procore session/);
    expect(rows[0].last_error).not.toContain(SECRET);
    expect(rows[0].last_error).not.toContain("automation%40example.invalid"); // query strings are dropped
  });

  it("is live even when the shared ops variable is empty (an unset env var used to make it a silent no-op)", async () => {
    delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));

    const res = await recordLoginOutcomeAndMaybeAlert({ outcome: fail, now: NOW, realertMinutes: 60 }, { db, send });

    expect(res.action).toBe("alert_failure");
    expect(send.mock.calls[0][0].to).toBe(OWNER);
  });

  it("refuses a multi-address recipient outright rather than widening the audience", async () => {
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));

    const res = await recordLoginOutcomeAndMaybeAlert(
      { outcome: fail, now: NOW, realertMinutes: 60, recipient: `${OWNER}, staff@trockgc.com` },
      { db, send }
    );

    expect(res.action).toBe("none");
    expect(send).not.toHaveBeenCalled();
  });

  it("emails once per re-alert window across 19-minute cycles, then flips back to ok on a real success", async () => {
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));
    // Ten cycles = three hours of a dead session.
    for (let i = 0; i < 10; i++) {
      await recordLoginOutcomeAndMaybeAlert(
        { outcome: fail, now: new Date(NOW.getTime() + i * 19 * MIN), realertMinutes: 60 },
        { db, send }
      );
    }
    // t=0, t=76, t=152 — not ten.
    expect(send).toHaveBeenCalledTimes(3);

    const recovered = await recordLoginOutcomeAndMaybeAlert(
      { outcome: { ok: true }, now: new Date(NOW.getTime() + 200 * MIN), realertMinutes: 60 },
      { db, send }
    );
    expect(recovered.action).toBe("alert_recovered");
    const { rows } = await db.query(`SELECT state, last_error, last_success_at FROM procore_login_alert_state WHERE scope = $1`, [
      PROCORE_LOGIN_ALERT_SCOPE,
    ]);
    expect(rows[0].state).toBe("ok");
    expect(rows[0].last_error).toBeNull();
    expect(new Date(rows[0].last_success_at).toISOString()).toBe(new Date(NOW.getTime() + 200 * MIN).toISOString());
  });
});

describe("the default re-alert window: at most one sign-in email a day while it stays failed (owner, 2026-10-15)", () => {
  const prev = process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES;
  beforeEach(async () => {
    await ensureLoginAlertStateTable(db);
    await db.query(`DELETE FROM procore_login_alert_state`);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES;
    else process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES = prev;
  });

  const reasons = ["credentials_rejected", "session_not_established", "unknown"] as const;
  const day = async (send: any, startMin: number, cycles: number) => {
    for (let i = 0; i < cycles; i++) {
      await recordLoginOutcomeAndMaybeAlert(
        { outcome: { ok: false, reason: reasons[i % reasons.length], attempts: 3 } as any, now: new Date(NOW.getTime() + (startMin + i * 19) * MIN), recipient: "ops@trock.test" },
        { db, send }
      );
    }
  };

  it("sends one email for a whole day of 19-minute failures, even as the reason changes, and the next a day later", async () => {
    delete process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES;
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));
    await day(send, 0, 75); // 75 cycles x 19 min = 23 h 45 min
    expect(send).toHaveBeenCalledTimes(1);
    await day(send, 24 * 60, 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("an env value can lengthen the window but never shorten it below a day", async () => {
    process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES = "60";
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));
    await day(send, 0, 75);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("recovery still emails at once, and a later failure is a new incident", async () => {
    delete process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES;
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));
    await day(send, 0, 3);
    const rec = await recordLoginOutcomeAndMaybeAlert({ outcome: { ok: true }, now: new Date(NOW.getTime() + 60 * MIN), recipient: "ops@trock.test" }, { db, send });
    expect(rec.action).toBe("alert_recovered");
    await day(send, 120, 1);
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("the login alert's transport and wording (Codex + CodeRabbit on #112)", () => {
  beforeEach(async () => {
    await ensureLoginAlertStateTable(db);
    await db.query(`DELETE FROM procore_login_alert_state`);
  });

  it("is sent past testing-mode redirection, to the owner only", async () => {
    const send = vi.fn(async (_m: any) => ({ success: true, provider: "gmail" }));
    await recordLoginOutcomeAndMaybeAlert({ outcome: { ok: false, reason: "credentials_rejected", attempts: 3 } as any, now: NOW }, { db, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "aiqbal@trockgc.com", bypassTestingMode: true, bypassGlobalCc: true });
  });

  it("the failure email describes the once-a-day throttle, not a re-alert on every changed failure", () => {
    const { htmlBody } = renderLoginAlertEmail({ kind: "login_failed", reason: "credentials_rejected", now: NOW });
    expect(htmlBody).not.toMatch(/until the failure changes/i);
    expect(htmlBody).toMatch(/at most one .*a day/i);
  });

  it("a page change is worded as a blocked export on a signed-in page, not a sign-in failure", () => {
    const { subject, htmlBody } = renderLoginAlertEmail({ kind: "login_failed", reason: "page_unrecognized" as any, blocking: "Bid Board stage sync (Excel export)", now: NOW });
    expect(subject).not.toMatch(/sign-in FAILED/i);
    expect(subject).toMatch(/Bid Board export BLOCKED/i);
    expect(htmlBody).toMatch(/signed in/i);
    const recovered = renderLoginAlertEmail({ kind: "recovered", reason: "page_unrecognized" as any, now: NOW });
    expect(recovered.subject).toMatch(/export/i);
  });

  it("'page or session not confirmed' says both causes are possible and tells him to Test the sign-in first", () => {
    const { subject, htmlBody } = renderLoginAlertEmail({ kind: "login_failed", reason: "page_unconfirmed" as any, now: NOW });
    expect(subject).toMatch(/Bid Board export BLOCKED/i);
    expect(subject).toMatch(/not confirmed/i);
    expect(htmlBody).not.toMatch(/nothing on the password/i);
    expect(htmlBody).toMatch(/Test/);
    // Only a CONFIRMED session (or a delivered export) proves a page change; a route-only success line doesn't.
    expect(htmlBody).toMatch(/session confirmed/);
    expect(htmlBody).toMatch(/delivered export/i);
    expect(htmlBody).toMatch(/app page reached/);
    expect(renderLoginAlertEmail({ kind: "recovered", reason: "page_unconfirmed" as any, now: NOW }).subject).toMatch(/export/i);
  });
});
