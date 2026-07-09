/**
 * sync_mappings integrity reconciler scheduler (#3) — daily 3:00 AM CST, ENV-GATED.
 * Disabled unless SYNC_MAPPINGS_RECONCILE_ENABLED === "true", so merging is inert until Adnaan flips it.
 */
import cron from "node-cron";
import { pool } from "../db";
import { storage } from "../storage";
import { runSyncMappingsReconcile, defaultReconcilerDeps } from "../sync-mappings-reconciler";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startSyncMappingsReconcileScheduler() {
  stopSyncMappingsReconcileScheduler();
  if (process.env.SYNC_MAPPINGS_RECONCILE_ENABLED !== "true") {
    console.log("[sync-mappings-reconcile] scheduler DISABLED (set SYNC_MAPPINGS_RECONCILE_ENABLED=true to enable)");
    return;
  }
  cronTask = cron.schedule(
    "0 3 * * *",
    async () => {
      try {
        console.log("[sync-mappings-reconcile] Starting scheduled integrity scan...");
        const report = await runSyncMappingsReconcile(defaultReconcilerDeps(pool, storage), { commit: true });
        console.log(
          `[sync-mappings-reconcile] Scan complete: counts=${JSON.stringify(report.counts)} alertsWritten=${report.alertsWritten}`,
        );
      } catch (e: unknown) {
        console.error("[sync-mappings-reconcile] Scheduled scan failed:", e instanceof Error ? e.message : e);
      }
    },
    { timezone: "America/Chicago" },
  );
  console.log("[sync-mappings-reconcile] Daily integrity scan scheduler started (3:00 AM CST)");
}

export function stopSyncMappingsReconcileScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
