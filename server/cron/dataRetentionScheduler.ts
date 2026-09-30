/**
 * Data retention scheduler — checks hourly, runs at most once per `intervalHours`, and only while
 * automation_config.data_retention is explicitly enabled (it is OFF by default). The config is read
 * on every check, so enabling, disabling or retuning it takes effect without a restart.
 *
 * The last-run time is process memory, so a restart makes the next enabled check eligible again.
 * That costs at most one extra bounded run per deploy (see server/data-retention.ts), which is cheaper
 * than a second source of truth for a timestamp.
 */
import { runDataRetention, resolveDataRetentionConfig, DATA_RETENTION_CONFIG_KEY } from "../data-retention";
import { storage } from "../storage";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** First check 10 minutes after boot, clear of the pollers' staggered start-up cycles. */
const FIRST_CHECK_DELAY_MS = 10 * 60 * 1000;

let checkTimer: ReturnType<typeof setInterval> | null = null;
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRunAt: number | null = null;

export async function checkDataRetention(now: number = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const row = await storage.getAutomationConfig(DATA_RETENTION_CONFIG_KEY);
    const config = resolveDataRetentionConfig(row?.value);
    if (!config.enabled) return;
    if (lastRunAt !== null && now - lastRunAt < config.intervalHours * 60 * 60 * 1000) return;
    lastRunAt = now;
    await runDataRetention(config);
  } catch (e: unknown) {
    console.error("[retention] Scheduled check failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

export function startDataRetentionScheduler() {
  stopDataRetentionScheduler();
  firstCheckTimer = setTimeout(() => void checkDataRetention(), FIRST_CHECK_DELAY_MS);
  checkTimer = setInterval(() => void checkDataRetention(), CHECK_INTERVAL_MS);
  console.log("[retention] Data retention scheduler started (hourly check; runs only when data_retention.enabled is true)");
}

export function stopDataRetentionScheduler() {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** Test seam: forget the in-memory last-run time. */
export function resetDataRetentionSchedulerState() {
  lastRunAt = null;
  running = false;
}
