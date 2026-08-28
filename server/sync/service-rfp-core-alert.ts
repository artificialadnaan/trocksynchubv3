// Approved service RFP → TROCK Core delivery alert: the COPY, not the debounce.
//
// The failure/recovery state machine, its table (bidboard_crm_push_alert_state) and its send path all
// belong to bidboard-crm-alert and are reused unchanged — this stream simply keys that table under a
// NAMESPACED office slug, so a Core failure and a Bid Board → CRM failure cannot collide on one
// primary key and suppress each other's recovery email.
//
// What is NOT reusable is the wording. renderPushAlertEmail names the CRM push in every branch, and
// its sentences are instructions: inspect bid_board_ingestion_inbox, check BID_BOARD_SYNC_SECRET, mind
// the 25MB body limit. Sent for a Core failure every one of them is false — the operator goes looking
// in a system that holds no row for the incident, using a secret that had nothing to do with it, while
// the approval sits undelivered. A shared renderer that names the wrong subsystem in an operator's
// inbox is a real defect, not a cosmetic one, so the copy is forked here.
//
// This is exactly the split procore-login-alert.ts already makes: share decideAlertTransition and the
// state machinery, fork the renderer.
//
// Imported DYNAMICALLY by service-rfp-core-outbox.ts. bidboard-crm-alert imports its pool statically
// and ../db throws at import time without DATABASE_URL, so a static import on the approval path would
// drag that throw into rfp-approval.ts's module graph.
import {
  escapeHtml,
  recordPushOutcomeAndMaybeAlert,
  type PushAlertAction,
  type PushAlertEmailInput,
} from "./bidboard-crm-alert";

/**
 * office_slug is the alert table's PRIMARY KEY, and the Bid Board → CRM push writes it as the bare
 * slug ("dallas"). Namespacing is what keeps the two streams on separate rows.
 */
export const SERVICE_RFP_CORE_ALERT_NAMESPACE = "service-rfp-core:";

export function serviceRfpCoreAlertOffice(office: string | null): string {
  return `${SERVICE_RFP_CORE_ALERT_NAMESPACE}${office ?? "unmapped"}`;
}

/** The namespace is machinery for that primary key; a reader learns nothing from it, so it is stripped
 *  for display and only the office an operator recognises is shown. */
function displayOffice(officeSlug: string): string {
  return officeSlug.startsWith(SERVICE_RFP_CORE_ALERT_NAMESPACE)
    ? officeSlug.slice(SERVICE_RFP_CORE_ALERT_NAMESPACE.length)
    : officeSlug;
}

/**
 * Pure renderer, same contract as renderPushAlertEmail so it can be passed straight to the shared
 * orchestrator. Kinds carry the same meanings the orchestrator assigns them:
 *  - `request_rejected`: Core refused deterministically, or the approval could not be represented on
 *    the v1 contract at all. Never retried.
 *  - `terminal_failure`: the row exhausted its retry ladder and dead-lettered.
 *  - `unconfirmed`: an outcome this producer could not classify either way.
 *  - `recovered`: deliveries are working again.
 */
export function renderServiceRfpCoreAlertEmail(e: PushAlertEmailInput): { subject: string; htmlBody: string } {
  const office = displayOffice(e.office);
  const safeOffice = escapeHtml(office);

  const details = `
      <p><strong>Office:</strong> ${safeOffice}</p>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Delivery attempts:</strong> ${e.attempts ?? "—"}</p>
      <p><strong>Last HTTP status:</strong> ${e.status ?? "—"}</p>
      <p><strong>Error:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Row:</strong> service_rfp_core_outbox, keyed by source_system + source_deal_id + rfp_request_id</p>`;

  // Said in every failure branch because it is the first thing a reader needs in order to decide how
  // fast to move: the handoff is fail-open by construction, so the approval completed and the Procore
  // automation ran regardless. What is missing is only the card in Core's estimating lane.
  const unaffected = `
      <p>The approval itself is <strong>not</strong> affected: this handoff is fail-open, so the RFP was
      approved and the Procore create ran regardless. What is missing is the job in Core's service
      estimating lane, which an estimator can still be given by hand in the meantime.</p>`;

  if (e.kind === "request_rejected") {
    return {
      subject: `⚠️ TROCK Core REJECTED an approved service RFP — office ${office}`,
      htmlBody: `
      <h2>TROCK Core refused an approved service RFP</h2>${details}
      <p>Core returned a deterministic refusal (a 409 conflict, a bad request, or a rejected signature),
      or the approval could not be expressed on the v1 contract at all — a non-CRM source deal, an office
      with no Core tenant, or a missing CRM company/property uuid. Either way it will <strong>not</strong>
      be accepted as-is, so the row is recorded 'failed' in service_rfp_core_outbox and is never retried;
      the Error above is the reason. Fix the cause and re-drive the row.</p>${unaffected}
    `,
    };
  }

  if (e.kind === "terminal_failure") {
    return {
      subject: `⚠️ TROCK Core service-RFP delivery DEAD-LETTERED — office ${office}`,
      htmlBody: `
      <h2>TROCK Core service-RFP delivery exhausted its retries</h2>${details}
      <p>The row reached its attempt ceiling and is now 'dead' in service_rfp_core_outbox. It will not be
      retried again, and nothing re-sends on its own. The usual causes are configuration:
      CORE_INGRESS_BASE_URL wrong or unreachable, Core still serving the ingress dark (404) or holding no
      secret of its own (503), or SERVICE_RFP_INGRESS_SECRET_CURRENT missing on this side / shorter than
      Core's 32-byte floor. Fix the cause, then re-drive the row. Further alerts are throttled to roughly
      hourly until deliveries recover.</p>${unaffected}
    `,
    };
  }

  if (e.kind === "unconfirmed") {
    return {
      subject: `⚠️ TROCK Core service-RFP delivery UNCONFIRMED — office ${office}`,
      htmlBody: `
      <h2>TROCK Core service-RFP delivery could not be confirmed</h2>${details}
      <p>The POST ended in a state this producer could not classify as accepted or refused. That is
      <strong>not</strong> proof Core dropped it — check whether a bid already exists for this deal in
      Core before re-driving the service_rfp_core_outbox row, so a retry cannot become a second
      bid.</p>${unaffected}
    `,
    };
  }

  return {
    subject: `✅ TROCK Core service-RFP delivery RECOVERED — office ${office}`,
    htmlBody: `
    <h2>TROCK Core service-RFP delivery has recovered</h2>
    <p><strong>Office:</strong> ${safeOffice}</p>
    <p><strong>When:</strong> ${e.now.toISOString()}</p>
    <p>An approved service RFP has reached Core again; the prior failure has cleared.</p>
  `,
  };
}

export interface ServiceRfpCoreDeliveryOutcome {
  /** The Core tenant slug, or null when the approval never resolved to one. */
  office: string | null;
  /** Delivered. Reported as well as the failures — the state only leaves 'failing' on an ok outcome. */
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
  /** A refusal that can never be accepted as-is, as opposed to a dead-lettered retry. Ignored when ok. */
  terminal?: boolean;
}

/**
 * Record one Core delivery outcome against the shared debounce, rendered in this stream's own words.
 * Never throws — recordPushOutcomeAndMaybeAlert wraps everything, because alerting must never be able
 * to fail the work it is reporting on.
 */
export async function recordServiceRfpCoreDelivery(
  outcome: ServiceRfpCoreDeliveryOutcome,
): Promise<{ action: PushAlertAction } | { skipped: true }> {
  return recordPushOutcomeAndMaybeAlert(
    {
      pushResult: {
        ok: outcome.ok,
        attempts: outcome.attempts,
        status: outcome.status,
        error: outcome.error,
        rejected: !outcome.ok && outcome.terminal === true,
        terminalFailure: !outcome.ok && outcome.terminal !== true,
      },
      officeSlug: serviceRfpCoreAlertOffice(outcome.office),
    },
    { render: renderServiceRfpCoreAlertEmail },
  );
}
