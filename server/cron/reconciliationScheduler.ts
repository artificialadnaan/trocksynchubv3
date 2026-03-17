/**
 * Reconciliation Scheduler — Weekly scan on Sundays at 2:00 AM CST
 */

import cron from "node-cron";
import { runReconciliationScan } from "../services/reconciliation/engine";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startReconciliationScheduler() {
  stopReconciliationScheduler();
  // Run weekly on Sundays at 2:00 AM CST (America/Chicago)
  cronTask = cron.schedule(
    "0 2 * * 0",
    async () => {
      try {
        console.log("[reconciliation] Starting scheduled weekly scan...");
        const result = await runReconciliationScan("scheduled");
        console.log(
          `[reconciliation] Scheduled scan complete: ${JSON.stringify(result)}`
        );
      } catch (e: unknown) {
        console.error(
          "[reconciliation] Scheduled scan failed:",
          e instanceof Error ? e.message : e
        );
      }
    },
    {
      timezone: "America/Chicago",
    }
  );
  console.log("[reconciliation] Weekly scan scheduler started (Sundays 2:00 AM CST)");
}

export function stopReconciliationScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
