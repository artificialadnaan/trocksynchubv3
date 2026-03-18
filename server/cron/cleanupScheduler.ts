/**
 * Cleanup Scheduler — Weekly log retention on Sundays at 3:00 AM CST
 * Runs after reconciliation (2 AM) to avoid overlap.
 */

import cron from "node-cron";
import { storage } from "../storage";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startCleanupScheduler() {
  stopCleanupScheduler();
  // Run weekly on Sundays at 3:00 AM CST (America/Chicago)
  cronTask = cron.schedule(
    "0 3 * * 0",
    async () => {
      try {
        console.log("[cleanup] Starting scheduled log cleanup...");
        const result = await storage.cleanupOldLogs(90, 30, 90);
        console.log(
          `[cleanup] Log cleanup complete: audit=${result.auditDeleted}, webhook=${result.webhookDeleted}, email=${result.emailDeleted}`
        );
        await storage.createAuditLog({
          action: "log_cleanup",
          entityType: "system",
          source: "cron",
          status: "success",
          details: result,
        });
      } catch (e: unknown) {
        console.error(
          "[cleanup] Scheduled cleanup failed:",
          e instanceof Error ? e.message : e
        );
      }
    },
    {
      timezone: "America/Chicago",
    }
  );
  console.log("[cleanup] Weekly log cleanup scheduler started (Sundays 3:00 AM CST)");
}

export function stopCleanupScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
