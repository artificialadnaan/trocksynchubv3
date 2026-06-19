/**
 * Startup migration: create bidboard_crm_push_alert_state if it doesn't exist.
 *
 * Backs the Bid Board → CRM push failure-alert debounce/recovery state (see
 * server/sync/bidboard-crm-alert.ts). Keyed by office_slug so a single SyncHub process can track
 * each office it pushes. Auto-applied at boot via the same ensure-table pattern as
 * bidboard_stage_sync_runs (db:push is blocked by interactive prompts), so there is NO manual
 * migration step on deploy.
 */
import { ensurePushAlertStateTable } from "./sync/bidboard-crm-alert";

export async function ensureBidboardCrmPushAlertStateTable(): Promise<void> {
  try {
    // Single source of truth for the DDL lives next to the reader/writer (it is also self-healed at
    // the top of recordPushOutcomeAndMaybeAlert for standalone entrypoints). TIMESTAMPTZ because the
    // debounce compares INSTANTS across runs/processes — a tz-naive column would skew the window off-UTC.
    await ensurePushAlertStateTable();
    console.log("[migrate] bidboard_crm_push_alert_state table ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure bidboard_crm_push_alert_state table:", e);
    throw e;
  }
}
