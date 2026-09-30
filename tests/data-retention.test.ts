import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The retention job deletes production rows, so every guard is pinned here: default OFF, a fixed
// allowlist of three statements, batches bounded by ORDER BY id LIMIT, a hard per-run batch cap, and
// one audit row per run. The PGlite block runs the SHIPPED statements against real Postgres to prove
// they delete only expired / out-of-window rows.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    createAuditLog: vi.fn(),
  },
  pool: { query: vi.fn() },
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/db.ts", () => ({ pool: mocks.pool, db: {} }));

const {
  RETENTION_TARGETS,
  DATA_RETENTION_DEFAULTS,
  resolveDataRetentionConfig,
  runDataRetention,
} = await import("../server/data-retention.ts");
const { checkDataRetention, resetDataRetentionSchedulerState } = await import(
  "../server/cron/dataRetentionScheduler.ts"
);

const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ENABLED = { ...resolveDataRetentionConfig({ enabled: true }) };

/** A querier that reports `perTable[table]` rows remaining and deletes up to the LIMIT each call. */
function fakeQuerier(remaining: Record<string, number>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    const table = /^DELETE FROM (\w+) /.exec(text)?.[1] ?? "";
    const limit = Number(params[1]);
    const n = Math.min(limit, remaining[table] ?? 0);
    remaining[table] = (remaining[table] ?? 0) - n;
    return { rowCount: n };
  });
  return { query, calls };
}

const noSleep = async () => {};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storage.createAuditLog.mockResolvedValue({});
  mocks.storage.getAutomationConfig.mockResolvedValue(undefined);
  resetDataRetentionSchedulerState();
});

describe("data retention — configuration", () => {
  it("is DISABLED by default: no row, an empty row, and non-true values all resolve to off", () => {
    expect(DATA_RETENTION_DEFAULTS.enabled).toBe(false);
    for (const raw of [undefined, null, {}, [], "yes", { enabled: "true" }, { enabled: 1 }, { enabled: false }]) {
      expect(resolveDataRetentionConfig(raw).enabled).toBe(false);
    }
    expect(resolveDataRetentionConfig({ enabled: true }).enabled).toBe(true);
  });

  it("defaults to a 90-day window and clamps junk so a stray 0 cannot delete every log", () => {
    const d = resolveDataRetentionConfig({ enabled: true });
    expect(d).toEqual({ enabled: true, retentionDays: 90, batchSize: 1000, maxBatchesPerRun: 20, intervalHours: 24 });
    const junk = resolveDataRetentionConfig({ enabled: true, retentionDays: 0, batchSize: -5, maxBatchesPerRun: 1e9, intervalHours: "x" });
    expect(junk.retentionDays).toBe(30);
    expect(junk.batchSize).toBe(1);
    expect(junk.maxBatchesPerRun).toBe(500);
    expect(junk.intervalHours).toBe(24);
  });
});

describe("data retention — the run", () => {
  it("does nothing at all when the config is not enabled", async () => {
    const q = fakeQuerier({ idempotency_keys: 10 });
    const out = await runDataRetention(resolveDataRetentionConfig(undefined), { db: q, sleep: noSleep });
    expect(out).toBeNull();
    expect(q.query).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();
  });

  it("runs ONLY the three allowlisted statements, each bounded by ORDER BY id LIMIT $2", async () => {
    const q = fakeQuerier({ idempotency_keys: 5, bidboard_automation_logs: 5, bidboard_stage_sync_runs: 5 });
    await runDataRetention({ ...ENABLED, batchSize: 100 }, { db: q, sleep: noSleep, now: () => NOW });

    const tables = new Set(q.calls.map((c) => /^DELETE FROM (\w+) /.exec(c.text)?.[1]));
    expect([...tables].sort()).toEqual(["bidboard_automation_logs", "bidboard_stage_sync_runs", "idempotency_keys"]);
    for (const c of q.calls) {
      expect(c.text).toMatch(/^DELETE FROM (\w+) WHERE id IN \(SELECT id FROM \1 WHERE (expires_at|created_at|started_at) < \$1 ORDER BY id LIMIT \$2\)$/);
      expect(c.params[1]).toBe(100);
    }
    expect(RETENTION_TARGETS.map((t) => t.table)).toEqual(["idempotency_keys", "bidboard_automation_logs", "bidboard_stage_sync_runs"]);
  });

  it("uses now() for expired idempotency keys and now − retentionDays for the log tables", async () => {
    const q = fakeQuerier({});
    await runDataRetention({ ...ENABLED, retentionDays: 90 }, { db: q, sleep: noSleep, now: () => NOW });
    const cutoff = (t: string) => (q.calls.find((c) => c.text.startsWith(`DELETE FROM ${t} `))!.params[0] as Date).getTime();
    expect(cutoff("idempotency_keys")).toBe(NOW.getTime());
    expect(cutoff("bidboard_automation_logs")).toBe(NOW.getTime() - 90 * DAY);
    expect(cutoff("bidboard_stage_sync_runs")).toBe(NOW.getTime() - 90 * DAY);
  });

  it("deletes in batches with a pause between them until each table comes up short", async () => {
    const remaining = { idempotency_keys: 250, bidboard_automation_logs: 30, bidboard_stage_sync_runs: 0 };
    const q = fakeQuerier(remaining);
    const sleep = vi.fn(async () => {});
    const out = await runDataRetention({ ...ENABLED, batchSize: 100, maxBatchesPerRun: 50 }, { db: q, sleep, now: () => NOW });

    expect(out!.deleted).toEqual({ idempotency_keys: 250, bidboard_automation_logs: 30, bidboard_stage_sync_runs: 0 });
    // idempotency: 100, 100, 50(short) = 3; logs: 30(short) = 1; runs: 0(short) = 1
    expect(out!.batches).toBe(5);
    expect(out!.capped).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(remaining.idempotency_keys).toBe(0);
  });

  it("stops at maxBatchesPerRun and leaves the remainder for the next run", async () => {
    const remaining = { idempotency_keys: 50_000, bidboard_automation_logs: 50_000, bidboard_stage_sync_runs: 50_000 };
    const q = fakeQuerier(remaining);
    const out = await runDataRetention({ ...ENABLED, batchSize: 1000, maxBatchesPerRun: 7 }, { db: q, sleep: noSleep, now: () => NOW });

    expect(q.query).toHaveBeenCalledTimes(7);
    expect(out!.batches).toBe(7);
    expect(out!.capped).toBe(true);
    const total = Object.values(out!.deleted).reduce((a, b) => a + b, 0);
    expect(total).toBe(7000);
    // round-robin: no table starves the others of the shared budget
    expect(out!.deleted).toEqual({ idempotency_keys: 3000, bidboard_automation_logs: 2000, bidboard_stage_sync_runs: 2000 });
  });

  it("writes exactly one audit_logs row per run with the per-table counts", async () => {
    const q = fakeQuerier({ idempotency_keys: 12, bidboard_automation_logs: 3, bidboard_stage_sync_runs: 1 });
    await runDataRetention({ ...ENABLED, batchSize: 100 }, { db: q, sleep: noSleep, now: () => NOW });

    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    const row = mocks.storage.createAuditLog.mock.calls[0][0];
    expect(row).toMatchObject({
      action: "data_retention_run",
      entityType: "system",
      status: "success",
      category: "system",
      details: {
        deleted: { idempotency_keys: 12, bidboard_automation_logs: 3, bidboard_stage_sync_runs: 1 },
        retentionDays: 90,
        batchSize: 100,
        capped: false,
      },
    });
  });

  it("a failing table is recorded (status error) and does not stop the others", async () => {
    const q = {
      query: vi.fn(async (text: string) => {
        if (text.includes("bidboard_stage_sync_runs")) throw new Error('relation "bidboard_stage_sync_runs" does not exist');
        return { rowCount: 0 };
      }),
    };
    const out = await runDataRetention(ENABLED, { db: q, sleep: noSleep, now: () => NOW });
    expect(out!.status).toBe("error");
    expect(out!.errors.bidboard_stage_sync_runs).toMatch(/does not exist/);
    expect(q.query).toHaveBeenCalledTimes(3);
    expect(mocks.storage.createAuditLog.mock.calls[0][0]).toMatchObject({ status: "error", category: "system" });
  });
});

describe("data retention — scheduler check", () => {
  it("with no data_retention row it never touches the database", async () => {
    await checkDataRetention(NOW.getTime());
    expect(mocks.storage.getAutomationConfig).toHaveBeenCalledWith("data_retention");
    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();
  });

  it("when enabled, runs once, then waits intervalHours before running again", async () => {
    mocks.storage.getAutomationConfig.mockResolvedValue({ key: "data_retention", value: { enabled: true, intervalHours: 6 } });
    mocks.pool.query.mockResolvedValue({ rowCount: 0 });

    await checkDataRetention(NOW.getTime());
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);

    await checkDataRetention(NOW.getTime() + 5 * 60 * 60 * 1000);
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);

    await checkDataRetention(NOW.getTime() + 6 * 60 * 60 * 1000);
    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(2);
  });
});

describe("data retention — shipped SQL against real Postgres (PGlite)", () => {
  let pg: PGlite;
  let db: { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number }> };

  beforeAll(async () => {
    pg = new PGlite();
    db = {
      query: async (text, params) => {
        const r = await pg.query(text, params as any[]);
        return { rowCount: r.affectedRows ?? 0 };
      },
    };
  }, 30000);

  beforeEach(async () => {
    await pg.exec(`
      DROP TABLE IF EXISTS idempotency_keys, bidboard_automation_logs, bidboard_stage_sync_runs, webhook_logs;
      CREATE TABLE idempotency_keys (id SERIAL PRIMARY KEY, key TEXT NOT NULL UNIQUE, expires_at TIMESTAMP);
      CREATE TABLE bidboard_automation_logs (id SERIAL PRIMARY KEY, action TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE bidboard_stage_sync_runs (id SERIAL PRIMARY KEY, started_at TIMESTAMP NOT NULL DEFAULT NOW());
      CREATE TABLE webhook_logs (id SERIAL PRIMARY KEY, created_at TIMESTAMP);
    `);
  });

  it("deletes only expired keys and rows older than the window; never touches other tables", async () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    for (let i = 0; i < 25; i++) {
      await pg.query(`INSERT INTO idempotency_keys (key, expires_at) VALUES ($1, $2)`, [`old-${i}`, at(-DAY)]);
    }
    await pg.query(`INSERT INTO idempotency_keys (key, expires_at) VALUES ('live', $1), ('no-expiry', NULL)`, [at(DAY)]);
    for (let i = 0; i < 7; i++) {
      await pg.query(`INSERT INTO bidboard_automation_logs (action, created_at) VALUES ('x', $1)`, [at(-100 * DAY)]);
    }
    await pg.query(`INSERT INTO bidboard_automation_logs (action, created_at) VALUES ('recent', $1), ('undated', NULL)`, [at(-10 * DAY)]);
    await pg.query(`INSERT INTO bidboard_stage_sync_runs (started_at) VALUES ($1), ($2)`, [at(-91 * DAY), at(-89 * DAY)]);
    await pg.query(`INSERT INTO webhook_logs (created_at) VALUES ($1)`, [at(-1000 * DAY)]);

    const out = await runDataRetention({ ...ENABLED, batchSize: 10, maxBatchesPerRun: 100 }, { db, sleep: noSleep, now: () => NOW });

    expect(out!.deleted).toEqual({ idempotency_keys: 25, bidboard_automation_logs: 7, bidboard_stage_sync_runs: 1 });
    expect((await pg.query(`SELECT key FROM idempotency_keys ORDER BY key`)).rows.map((r: any) => r.key)).toEqual(["live", "no-expiry"]);
    expect((await pg.query(`SELECT action FROM bidboard_automation_logs ORDER BY action`)).rows.map((r: any) => r.action)).toEqual(["recent", "undated"]);
    expect((await pg.query(`SELECT count(*)::int AS n FROM bidboard_stage_sync_runs`)).rows[0]).toEqual({ n: 1 });
    expect((await pg.query(`SELECT count(*)::int AS n FROM webhook_logs`)).rows[0]).toEqual({ n: 1 });
  });

  it("each statement deletes at most batchSize rows, lowest ids first", async () => {
    for (let i = 0; i < 12; i++) {
      await pg.query(`INSERT INTO idempotency_keys (key, expires_at) VALUES ($1, $2)`, [`k-${i}`, "2000-01-01T00:00:00Z"]);
    }
    const out = await runDataRetention({ ...ENABLED, batchSize: 5, maxBatchesPerRun: 1 }, { db, sleep: noSleep, now: () => NOW });
    expect(out!.deleted.idempotency_keys).toBe(5);
    expect(out!.capped).toBe(true);
    const ids = (await pg.query(`SELECT id FROM idempotency_keys ORDER BY id`)).rows.map((r: any) => r.id);
    expect(ids).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });
});
