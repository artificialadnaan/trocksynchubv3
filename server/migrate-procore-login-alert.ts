/**
 * Startup migration: create procore_login_alert_state if it doesn't exist.
 *
 * Backs the Procore browser sign-in failure-alert debounce/recovery state (see
 * server/sync/procore-login-alert.ts). Keyed by scope so a second Procore automation account could be
 * tracked without a migration. Auto-applied at boot via the same ensure-table pattern as
 * bidboard_crm_push_alert_state (db:push is blocked by interactive prompts), so there is NO manual
 * migration step on deploy.
 */
import { ensureLoginAlertStateTable } from "./sync/procore-login-alert";

export async function ensureProcoreLoginAlertStateTable(): Promise<void> {
  try {
    // Single source of truth for the DDL lives next to the reader/writer (it is also self-healed at
    // the top of recordLoginOutcomeAndMaybeAlert for standalone entrypoints). TIMESTAMPTZ because the
    // debounce compares INSTANTS across runs/processes — a tz-naive column would skew the window off-UTC.
    await ensureLoginAlertStateTable();
    console.log("[migrate] procore_login_alert_state table ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure procore_login_alert_state table:", e);
    throw e;
  }
}
