/**
 * Runs the `rfp_request_approving_stuck` sweep (server/sync/rfp-approving-stuck.ts) every 10 minutes (S0b-2b; d9 Q7). A sweep
 * that is still running when the next tick fires is not overlapped. The recipient is BIDBOARD_CRM_ALERT_RECIPIENT, the same
 * env-only ops address the other SyncHub alerts use: unset ⇒ the sweep is a no-op.
 *
 * S0b-2b RED: stub. Schedules nothing.
 */
export const RFP_APPROVING_STUCK_SWEEP_CRON = "*/10 * * * *";

export function startRfpApprovingStuckScheduler(): void {}

export function stopRfpApprovingStuckScheduler(): void {}
