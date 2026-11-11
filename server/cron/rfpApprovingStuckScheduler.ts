/**
 * Runs the `rfp_request_approving_stuck` sweep (server/sync/rfp-approving-stuck.ts) every 10 minutes (S0b-2b; d9 Q7). A sweep
 * that is still running when the next tick fires is not overlapped. The recipient is BIDBOARD_CRM_ALERT_RECIPIENT, the same
 * env-only ops address the other SyncHub alerts use: unset ⇒ the sweep is a no-op.
 */
import cron from "node-cron";

export const RFP_APPROVING_STUCK_SWEEP_CRON = "*/10 * * * *";

let cronTask: ReturnType<typeof cron.schedule> | null = null;
let running = false;

async function runSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { pool } = await import("../db");
    const { runRfpApprovingStuckSweep } = await import("../sync/rfp-approving-stuck");
    const res = await runRfpApprovingStuckSweep({ db: pool });
    if (res.stuck.length > 0 || res.cleared.length > 0) {
      console.log(`[rfp-approving-stuck] stuck=${res.stuck.length} alerted=${res.alerted.length} cleared=${res.cleared.length}`);
    }
  } catch (err) {
    console.error(`[rfp-approving-stuck] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

export function startRfpApprovingStuckScheduler(): void {
  stopRfpApprovingStuckScheduler();
  cronTask = cron.schedule(RFP_APPROVING_STUCK_SWEEP_CRON, runSweep);
  console.log("[rfp-approving-stuck] stuck-approving sweep scheduler started (every 10 min)");
}

export function stopRfpApprovingStuckScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
