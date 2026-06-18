import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: logMock }));
vi.mock("../server/db.ts", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));

const { readPushAlertState, upsertPushAlertState, recordPushOutcomeAndMaybeAlert } = await import(
  "../server/sync/bidboard-crm-alert.ts"
);

/**
 * Runtime (PGlite) proof that the real debounce-state SQL — the SELECT and the INSERT ... ON CONFLICT —
 * actually parse and round-trip against Postgres, and that the stall→throttle→recovery state machine is
 * durable across separate calls (i.e. survives a SyncHub restart mid-outage and does not re-spam). The
 * unit tests use an in-memory fake; this exercises the literal SQL the ensure-table migration creates.
 */

const NOW = new Date("2026-06-18T22:00:00Z");
const MIN = 60_000;

let pg: PGlite;
let db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

beforeAll(async () => {
  pg = new PGlite();
  db = { query: async (text, params) => (await pg.query(text, params as any[])) as any };
  // Mirror server/migrate-bidboard-crm-push-alert.ts exactly.
  await pg.exec(`
    CREATE TABLE bidboard_crm_push_alert_state (
      office_slug TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'ok',
      last_alerted_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}, 30000); // PGlite cold-start can exceed the default 10s hook timeout under parallel runtime suites

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`TRUNCATE bidboard_crm_push_alert_state;`);
});

describe("push-alert state SQL (real Postgres round-trip)", () => {
  it("read returns null when no row exists, then upsert + read round-trips", async () => {
    expect(await readPushAlertState("dallas", db)).toBeNull();

    await upsertPushAlertState(
      "dallas",
      { state: "failing", lastAlertedAt: NOW, lastSuccessAt: null, lastError: "boom", now: NOW },
      db
    );
    const s = await readPushAlertState("dallas", db);
    expect(s?.state).toBe("failing");
    expect(s?.last_alerted_at?.toISOString()).toBe(NOW.toISOString());
  });

  it("ON CONFLICT (office_slug) updates in place rather than inserting a duplicate", async () => {
    await upsertPushAlertState("dallas", { state: "failing", lastAlertedAt: NOW, lastSuccessAt: null, lastError: "x", now: NOW }, db);
    await upsertPushAlertState("dallas", { state: "ok", lastAlertedAt: null, lastSuccessAt: NOW, lastError: null, now: NOW }, db);

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM bidboard_crm_push_alert_state`);
    expect(rows[0].n).toBe(1);
    expect((await readPushAlertState("dallas", db))?.state).toBe("ok");
  });
});

describe("recordPushOutcomeAndMaybeAlert against real Postgres — durable across calls (restart-safe)", () => {
  const send = vi.fn(async () => ({ success: true, provider: "gmail" }));
  const run = (pushResult: any, now: Date) =>
    recordPushOutcomeAndMaybeAlert(
      { pushResult, officeSlug: "dallas", sourceFilename: "ProjectList.xlsx", now, realertMinutes: 60, recipient: "ops@trock.test" },
      { db, send }
    );

  it("first failure alerts and persists; a separate call inside the window does NOT re-alert", async () => {
    send.mockClear();
    await run({ ok: false, attempts: 3, status: 500, error: "CRM responded 500" }, NOW);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await readPushAlertState("dallas", db))?.state).toBe("failing");

    // Simulate the next cron/cycle (a fresh process would re-read this same row).
    await run({ ok: false, attempts: 3, status: 500, error: "CRM responded 500" }, new Date(NOW.getTime() + 19 * MIN));
    expect(send).toHaveBeenCalledTimes(1); // still 1 — debounced via the persisted row
  });

  it("recovers exactly once when a push succeeds, and clears state", async () => {
    await run({ ok: false, attempts: 3, error: "x" }, NOW);
    send.mockClear();
    await run({ ok: true, attempts: 1 }, new Date(NOW.getTime() + 20 * MIN));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await readPushAlertState("dallas", db))?.state).toBe("ok");
  });
});
