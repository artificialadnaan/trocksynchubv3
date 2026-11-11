/**
 * Ops alerts for RFP Phase 2 routing (CONTRACT v2.2 §2 / §10): held_destination_changed, held_cross_destination,
 * approval_kind_conflict, missing Core tables, dead deliveries, orphan / link-refused Core bids.
 *
 * Shares bidboard-crm-alert's debounce state machine (as service-rfp-core-alert does), under its OWN namespace per alert
 * code, so it can neither suppress nor falsely "recover" another stream. The copy is forked: it names RFP routing, not the
 * Bid Board → CRM push. Imported DYNAMICALLY because bidboard-crm-alert's pool import throws without DATABASE_URL.
 * Never throws: an alert failure must not change a routing outcome.
 */
import { log } from "../log"; // never "../index": that boots the server, and the operator CLIs import this (Codex P1 on #128)

export type RfpCoreAlertCode =
  | "destination_changed_hold"
  | "cross_destination_hold"
  | "approval_kind_conflict"
  | "source_event_reused"
  | "core_tables_missing"
  | "core_create_dead"
  | "crm_link_dead"
  | "core_bid_orphan"
  | "core_bid_link_refused"
  | "core_confirm_delayed"
  | "core_request_rejected"
  | "crm_notice_dead"
  | "core_preflight_error"
  | "rfp_request_override_reset"
  // S1a (the E2 sender + the E4 / E5 / N1 follow-ups): every retry, re-arm, refusal and config gap is visible.
  | "rfp_core_unconfigured"
  | "core_create_retry"
  | "core_create_refused"
  | "core_create_rearmed"
  | "core_followup_rearmed"
  | "operator_redrive_sent"
  | "crm_link_retry"
  | "crm_request_rejected"
  | "core_confirm_retry"
  | "crm_notice_retry"
  // S1b: the one-deal operator CLIs (each --apply under its own a4 GO).
  | "rfp_operator_redrive_applied"
  | "rfp_requeue_applied"
  // S1b r2 (d9 Q2): a CRM re-post of a re-driven approval, answered as a no-op replay.
  | "redrive_repost_replayed";

export const RFP_CORE_ALERT_NAMESPACE = "rfp-core:";

export async function raiseRfpCoreAlert(code: RfpCoreAlertCode, detail: Record<string, unknown>): Promise<void> {
  let summary = "";
  try {
    summary = JSON.stringify(detail);
  } catch {
    summary = "(detail not serializable)";
  }
  try {
    log(`[rfp-core] ALERT ${code} ${summary}`, "rfp-core");
  } catch {
    /* logging must not throw either */
  }
  try {
    const { recordPushOutcomeAndMaybeAlert, escapeHtml } = await import("./bidboard-crm-alert");
    await recordPushOutcomeAndMaybeAlert(
      {
        pushResult: { ok: false, attempts: 1, error: `${code}: ${summary}`, rejected: true },
        officeSlug: `${RFP_CORE_ALERT_NAMESPACE}${code}`,
        signatureChanged: true,
      },
      {
        render: (input) => ({
          subject: `[SyncHub] RFP routing alert: ${code}`,
          htmlBody:
            `<p>SyncHub RFP Phase 2 routing raised <b>${escapeHtml(code)}</b> at ${escapeHtml(input.now.toISOString())}.</p>` +
            `<p>${escapeHtml(input.error ?? summary)}</p>` +
            `<p>Where to look: the create command's destination stamp, rfp_core_create_outbox (E2), rfp_core_followup_outbox (E4 / E5 / N1). ` +
            `A held or refused row is resolved by a person; nothing is retried to the other destination.</p>`,
        }),
      },
    );
  } catch (err) {
    try {
      log(`[rfp-core] alert delivery failed for ${code}: ${(err as Error)?.message ?? err}`, "rfp-core");
    } catch {
      /* swallow */
    }
  }
}
