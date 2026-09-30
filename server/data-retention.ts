// Data retention: prune rows that nothing reads any more, in small batches, from a FIXED allowlist.
//
// Why this exists: the SyncHub Postgres volume sat at 406/500 MB with ~50k EXPIRED idempotency_keys
// that were never deleted, and bidboard_automation_logs / bidboard_stage_sync_runs growing ~280
// rows/day with no retention at all. cleanupOldLogs (server/cron/cleanupScheduler.ts) already prunes
// audit_logs / webhook_logs / email_send_log; this covers the three tables it does not.
//
// Shape of a run:
//  - DISABLED unless automation_config.data_retention has `enabled: true`. The owner decides when it
//    starts deleting; a deploy alone never deletes anything.
//  - Each DELETE touches at most `batchSize` rows (`WHERE id IN (SELECT id … ORDER BY id LIMIT n)`),
//    with a short pause between batches and a hard `maxBatchesPerRun` cap across the whole run, so a
//    run's WAL volume is bounded by batchSize × maxBatchesPerRun rows no matter how large the backlog.
//    A backlog larger than one run is simply finished by later runs.
//  - The tables and columns are string literals below. Nothing from config, a request, or a caller
//    is ever interpolated into the SQL — config only supplies the two bound parameters (cutoff, limit).
//  - Every run writes exactly one audit_logs row with the per-table counts.
//
// Deleting rows frees space INSIDE the table files for reuse by later inserts; it does not shrink
// the files on disk. Returning space to the volume needs VACUUM FULL / pg_repack, which is an owner
// decision and deliberately not done here.
import { storage } from "./storage";

export const DATA_RETENTION_CONFIG_KEY = "data_retention";

export interface DataRetentionConfig {
  enabled: boolean;
  /** Age window for the log tables. idempotency_keys ignores it: those rows carry their own expires_at. */
  retentionDays: number;
  batchSize: number;
  maxBatchesPerRun: number;
  intervalHours: number;
}

export const DATA_RETENTION_DEFAULTS: Readonly<DataRetentionConfig> = Object.freeze({
  enabled: false,
  retentionDays: 90,
  batchSize: 1000,
  maxBatchesPerRun: 20,
  intervalHours: 24,
});

/** Pause between batches, so a run never holds the database busy back-to-back. */
export const DATA_RETENTION_BATCH_PAUSE_MS = 500;

/**
 * The ONLY statements this job can run. `$1` is the cutoff instant, `$2` the batch size.
 * `ORDER BY id LIMIT` inside the subquery is what makes each statement small and deterministic.
 */
export const RETENTION_TARGETS = Object.freeze([
  Object.freeze({
    table: "idempotency_keys" as const,
    rule: "expired" as const,
    sql:
      "DELETE FROM idempotency_keys WHERE id IN " +
      "(SELECT id FROM idempotency_keys WHERE expires_at < $1 ORDER BY id LIMIT $2)",
  }),
  Object.freeze({
    table: "bidboard_automation_logs" as const,
    rule: "older_than_window" as const,
    sql:
      "DELETE FROM bidboard_automation_logs WHERE id IN " +
      "(SELECT id FROM bidboard_automation_logs WHERE created_at < $1 ORDER BY id LIMIT $2)",
  }),
  Object.freeze({
    table: "bidboard_stage_sync_runs" as const,
    rule: "older_than_window" as const,
    sql:
      "DELETE FROM bidboard_stage_sync_runs WHERE id IN " +
      "(SELECT id FROM bidboard_stage_sync_runs WHERE started_at < $1 ORDER BY id LIMIT $2)",
  }),
]);

export type RetentionTable = (typeof RETENTION_TARGETS)[number]["table"];

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * The stored row, made safe. The generic PUT /api/automation-config accepts arbitrary JSON, so every
 * field is validated here rather than trusted: `enabled` is on only when it is literally `true`, and
 * the window has a floor so a stray `0` cannot turn "prune old logs" into "delete every log".
 */
export function resolveDataRetentionConfig(raw: unknown): DataRetentionConfig {
  const v = raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DATA_RETENTION_DEFAULTS;
  return {
    enabled: v.enabled === true,
    retentionDays: clampInt(v.retentionDays, d.retentionDays, 30, 3650),
    batchSize: clampInt(v.batchSize, d.batchSize, 1, 5000),
    maxBatchesPerRun: clampInt(v.maxBatchesPerRun, d.maxBatchesPerRun, 1, 500),
    intervalHours: clampInt(v.intervalHours, d.intervalHours, 1, 24 * 30),
  };
}

export interface RetentionQuerier {
  query(text: string, params?: unknown[]): Promise<{ rowCount?: number | null }>;
}

export interface DataRetentionRunResult {
  status: "success" | "error";
  deleted: Record<RetentionTable, number>;
  batches: number;
  /** True when the run stopped at maxBatchesPerRun with rows possibly still eligible. */
  capped: boolean;
  errors: Partial<Record<RetentionTable, string>>;
  config: Omit<DataRetentionConfig, "enabled">;
  durationMs: number;
}

export interface DataRetentionDeps {
  db?: RetentionQuerier;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  audit?: typeof storage.createAuditLog;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One bounded run, or null without touching the database when the config is not enabled. Tables are
 * visited round-robin so one large backlog cannot starve the others of the shared batch budget. A table that errors (e.g. bidboard_stage_sync_runs missing on a
 * host whose boot migration failed) is recorded and skipped; the others still run.
 */
export async function runDataRetention(
  config: DataRetentionConfig,
  deps: DataRetentionDeps = {},
): Promise<DataRetentionRunResult | null> {
  if (config.enabled !== true) return null;
  const db = deps.db ?? (await import("./db")).pool;
  const sleep = deps.sleep ?? defaultSleep;
  const audit = deps.audit ?? storage.createAuditLog.bind(storage);
  const now = (deps.now ?? (() => new Date()))();
  const started = Date.now();

  const windowCutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000);
  const cutoffFor = (rule: (typeof RETENTION_TARGETS)[number]["rule"]) => (rule === "expired" ? now : windowCutoff);

  const deleted = Object.fromEntries(RETENTION_TARGETS.map((t) => [t.table, 0])) as Record<RetentionTable, number>;
  const errors: Partial<Record<RetentionTable, string>> = {};
  const done = new Set<RetentionTable>();
  let batches = 0;

  outer: while (done.size < RETENTION_TARGETS.length) {
    for (const target of RETENTION_TARGETS) {
      if (done.has(target.table)) continue;
      if (batches >= config.maxBatchesPerRun) break outer;
      if (batches > 0) await sleep(DATA_RETENTION_BATCH_PAUSE_MS);
      batches++;
      try {
        const res = await db.query(target.sql, [cutoffFor(target.rule), config.batchSize]);
        const n = Number(res?.rowCount ?? 0);
        deleted[target.table] += n;
        // A short batch means nothing eligible is left in this table for this run.
        if (n < config.batchSize) done.add(target.table);
      } catch (err) {
        errors[target.table] = err instanceof Error ? err.message : String(err);
        done.add(target.table);
      }
    }
  }

  const capped = done.size < RETENTION_TARGETS.length;
  const status: DataRetentionRunResult["status"] = Object.keys(errors).length > 0 ? "error" : "success";
  const { enabled: _enabled, ...configEcho } = config;
  const result: DataRetentionRunResult = {
    status,
    deleted,
    batches,
    capped,
    errors,
    config: configEcho,
    durationMs: Date.now() - started,
  };

  try {
    await audit({
      action: "data_retention_run",
      entityType: "system",
      source: "cron",
      status,
      category: "system",
      details: {
        deleted,
        batches,
        capped,
        errors,
        retentionDays: config.retentionDays,
        batchSize: config.batchSize,
        maxBatchesPerRun: config.maxBatchesPerRun,
        windowCutoff: windowCutoff.toISOString(),
        expiredCutoff: now.toISOString(),
      },
      errorMessage: status === "error" ? Object.entries(errors).map(([t, m]) => `${t}: ${m}`).join("; ") : null,
      durationMs: result.durationMs,
    });
  } catch (err) {
    console.error("[retention] Failed to write the data_retention_run audit row:", err instanceof Error ? err.message : err);
  }

  console.log(
    `[retention] Run ${status}: ${RETENTION_TARGETS.map((t) => `${t.table}=${deleted[t.table]}`).join(", ")} ` +
      `in ${batches} batch(es)${capped ? " (capped; the remainder is left for the next run)" : ""}`,
  );
  return result;
}
