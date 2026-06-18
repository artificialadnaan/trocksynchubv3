/**
 * Startup migration: create bidboard_crm_push_alert_state if it doesn't exist.
 *
 * Backs the Bid Board → CRM push failure-alert debounce/recovery state (see
 * server/sync/bidboard-crm-alert.ts). Keyed by office_slug so a single SyncHub process can track
 * each office it pushes. Auto-applied at boot via the same ensure-table pattern as
 * bidboard_stage_sync_runs (db:push is blocked by interactive prompts), so there is NO manual
 * migration step on deploy.
 */
import { pool } from "./db";

export async function ensureBidboardCrmPushAlertStateTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bidboard_crm_push_alert_state (
        office_slug TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'ok',
        last_alerted_at TIMESTAMP,
        last_success_at TIMESTAMP,
        last_error TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    console.log("[migrate] bidboard_crm_push_alert_state table ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure bidboard_crm_push_alert_state table:", e);
    throw e;
  }
}
