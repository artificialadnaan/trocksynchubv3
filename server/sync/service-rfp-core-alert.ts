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
  realertMinutesFromEnv,
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
/** Which approval the outcome was for, so the email names the RFP an operator has to re-drive. */
export interface ServiceRfpAlertSubject {
  requestId: number;
  sourceDealId: string;
  projectNumber?: string | null;
  companyName?: string | null;
}

export function renderServiceRfpCoreAlertEmail(
  e: PushAlertEmailInput,
  rfp?: ServiceRfpAlertSubject,
): { subject: string; htmlBody: string } {
  const office = displayOffice(e.office);
  const safeOffice = escapeHtml(office);
  // The subject names the RFP by the number people use (the project number), else its request id.
  const label = rfp ? ` — ${rfp.projectNumber?.trim() || `RFP request ${rfp.requestId}`}` : "";
  const rfpLines = rfp
    ? `
      <p><strong>RFP request:</strong> ${escapeHtml(String(rfp.requestId))}</p>
      <p><strong>Project number:</strong> ${escapeHtml(rfp.projectNumber?.trim() || "—")}</p>
      <p><strong>Company:</strong> ${escapeHtml(rfp.companyName?.trim() || "—")}</p>
      <p><strong>CRM deal:</strong> ${escapeHtml(rfp.sourceDealId)}</p>`
    : "";
  // Only the FIRST failure of a reason is emailed inside the re-alert window (a different reason always is), so
  // the email says where the rest are.
  const others = `
      <p>Other approvals that failed for the same reason inside the alert window are not emailed one by one. List
      the recent ones (last_error carries the reason shown above; a re-driven row keeps its created_at, so the
      latest attempt decides) with <code>select rfp_request_id, source_deal_id, status, last_error,
      coalesce(last_attempt_at, created_at) as failed_at from service_rfp_core_outbox where status in ('failed','dead')
      and coalesce(last_attempt_at, created_at) &gt; now() - interval '1 day' order by failed_at desc</code>.</p>`;

  const details = `${rfpLines}
      <p><strong>Office:</strong> ${safeOffice}</p>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Delivery attempts:</strong> ${e.attempts ?? "—"}</p>
      <p><strong>Last HTTP status:</strong> ${e.status ?? "—"}</p>
      <p><strong>Error:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Row:</strong> service_rfp_core_outbox, keyed by source_system + source_deal_id + rfp_request_id</p>`;

  // Said in every failure branch because it is the first thing a reader needs in order to decide how
  // fast to move. It stops at what is actually known: the handoff never blocks or fails the approval,
  // and the Procore automation is not gated on it. It does NOT claim the create succeeded — on the
  // inline path this email is rendered BEFORE createBidBoardProjectFromDeal is even called (the
  // handoff is awaited in front of it), and that create can fail on its own. Reporting an outcome
  // nobody has observed would have an operator assume a Procore project exists when it may not.
  const unaffected = `
      <p>The approval itself is <strong>not</strong> affected: this handoff is fail-open, so the RFP was
      approved and the Procore create proceeds independently of it — this alert reports nothing about
      the outcome of that create, which surfaces on its own. What is missing here is the job in Core's
      service estimating lane, which an estimator can still be given by hand in the meantime.</p>`;

  if (e.kind === "request_rejected") {
    return {
      subject: `⚠️ TROCK Core REJECTED an approved service RFP — office ${office}${label}`,
      htmlBody: `
      <h2>TROCK Core refused an approved service RFP</h2>${details}
      <p>Core returned a deterministic refusal (a 409 conflict, a bad request, or a rejected signature),
      or the approval could not be expressed on the v1 contract at all — a non-CRM source deal, an office
      with no Core tenant, or a missing CRM company/property uuid. Either way it will <strong>not</strong>
      be accepted as-is, so the row is recorded 'failed' in service_rfp_core_outbox and is never retried;
      the Error above is the reason. Fix the cause and re-drive the row.</p>${unaffected}${others}
    `,
    };
  }

  if (e.kind === "terminal_failure") {
    return {
      subject: `⚠️ TROCK Core service-RFP delivery DEAD-LETTERED — office ${office}${label}`,
      htmlBody: `
      <h2>TROCK Core service-RFP delivery exhausted its retries</h2>${details}
      <p>The row reached its attempt ceiling and is now 'dead' in service_rfp_core_outbox. It will not be
      retried again, and nothing re-sends on its own. The usual causes are configuration:
      CORE_INGRESS_BASE_URL wrong or unreachable, Core still serving the ingress dark (404) or holding no
      secret of its own (503), or SERVICE_RFP_INGRESS_SECRET_CURRENT missing on this side / shorter than
      Core's 32-byte floor. Fix the cause, then re-drive the row. Further alerts are throttled to roughly
      hourly until deliveries recover.</p>${unaffected}${others}
    `,
    };
  }

  if (e.kind === "unconfirmed") {
    return {
      subject: `⚠️ TROCK Core service-RFP delivery UNCONFIRMED — office ${office}${label}`,
      htmlBody: `
      <h2>TROCK Core service-RFP delivery could not be confirmed</h2>${details}
      <p>The POST ended in a state this producer could not classify as accepted or refused. That is
      <strong>not</strong> proof Core dropped it — check whether a bid already exists for this deal in
      Core before re-driving the service_rfp_core_outbox row, so a retry cannot become a second
      bid.</p>${unaffected}${others}
    `,
    };
  }

  return {
    subject: `✅ TROCK Core service-RFP delivery RECOVERED — office ${office}`,
    htmlBody: `
    <h2>TROCK Core service-RFP delivery has recovered</h2>
    <p><strong>Office:</strong> ${safeOffice}</p>
    <p><strong>When:</strong> ${e.now.toISOString()}</p>
    ${rfpLines}
    <p>An approved service RFP has reached Core again, so deliveries are working. This does <strong>not</strong>
    re-send approvals that already failed or dead-lettered: those rows stay in service_rfp_core_outbox until
    re-driven.</p>
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
  /** The approval this outcome is for; named in the email. */
  rfp?: ServiceRfpAlertSubject;
}

/**
 * Per-office serialization of the read-decide-send-upsert transition.
 *
 * recordPushOutcomeAndMaybeAlert takes no lock and documents exactly why: its original caller, the
 * stage-sync cycle, is ALREADY serialized by bidboardStageSyncRunning, so the only overlap it can see
 * is a rare manual trigger. That is a precondition, and this caller does not meet it — service
 * approvals are fire-and-forget behind a 202, they can complete concurrently, and DFW is the only
 * Core tenant, so every Core alert in flight contends for one primary-key row. Interleaved, two
 * failures both read 'ok', both decide "first failure", and both email; a success and a failure
 * racing can leave the state describing whichever upsert happened to land last.
 *
 * So the caller supplies the serialization the shared module assumes, rather than the shared module
 * growing a lock its owner deliberately declined.
 *
 * A promise chain per office, not a lock: it cannot deadlock, and a predecessor is waited on for at
 * most CHAIN_WAIT_MS, so a wedged dispatch DELAYS the next alert instead of silencing the stream. The
 * degraded case therefore degrades to exactly today's behaviour — a possible duplicate ops email —
 * which is the trade this table's owner already accepted over coordination machinery.
 */
const CHAIN_WAIT_MS = 5_000;
const alertChain = new Map<string, Promise<unknown>>();

async function serializedByOffice<T>(officeSlug: string, work: () => Promise<T>): Promise<T> {
  const predecessor = alertChain.get(officeSlug);
  const mine = (async () => {
    if (predecessor) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        predecessor,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CHAIN_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return work();
  })();

  // The chain link must never reject, or the next caller's await would throw someone else's error.
  const link = mine.catch(() => undefined);
  alertChain.set(officeSlug, link);
  try {
    return await mine;
  } finally {
    // Only if nobody has queued behind us; otherwise the newer link is the live tail.
    if (alertChain.get(officeSlug) === link) alertChain.delete(officeSlug);
  }
}

/**
 * The refusal reasons already EMAILED for each office inside the re-alert window (error text → when). A reason not in
 * here is a new incident and is emailed even inside the window; one in here is throttled with the rest. Every reason
 * in the window is remembered, not only the latest, so failures alternating between two reasons (a re-drive of mixed
 * rows) stay one email per reason. Core's errors name a reason, never a row.
 *
 * In memory: SyncHub is one process, and a restart forgets at most one window (one extra email per reason). Cleared
 * when the office recovers. Only touched inside serializedByOffice, so reads and writes for an office never interleave.
 */
const alertedReasons = new Map<string, Map<string, number>>();

function reasonsInWindow(officeSlug: string, nowMs: number, windowMs: number): Map<string, number> {
  const reasons = alertedReasons.get(officeSlug) ?? new Map<string, number>();
  for (const [reason, at] of reasons) if (nowMs - at >= windowMs) reasons.delete(reason);
  alertedReasons.set(officeSlug, reasons);
  return reasons;
}

/** Test seam: forget every remembered reason. */
export function resetServiceRfpCoreAlertReasons(): void {
  alertedReasons.clear();
}

/**
 * Record one Core delivery outcome against the shared debounce, rendered in this stream's own words.
 * Never throws — recordPushOutcomeAndMaybeAlert wraps everything, because alerting must never be able
 * to fail the work it is reporting on.
 */
export async function recordServiceRfpCoreDelivery(
  outcome: ServiceRfpCoreDeliveryOutcome,
): Promise<{ action: PushAlertAction } | { skipped: true }> {
  const officeSlug = serviceRfpCoreAlertOffice(outcome.office);
  return serializedByOffice(officeSlug, async () => {
    const now = new Date();
    const reasons = reasonsInWindow(officeSlug, now.getTime(), realertMinutesFromEnv() * 60_000);
    const reason = outcome.error ?? "(none captured)";
    const result = await recordPushOutcomeAndMaybeAlert(
      {
        pushResult: {
          ok: outcome.ok,
          attempts: outcome.attempts,
          status: outcome.status,
          error: outcome.error,
          rejected: !outcome.ok && outcome.terminal === true,
          terminalFailure: !outcome.ok && outcome.terminal !== true,
        },
        officeSlug,
        now,
        // A reason not yet emailed in this window is a new incident; a repeat of any emailed one is throttled.
        signatureChanged: !outcome.ok && !reasons.has(reason),
      },
      { render: (input) => renderServiceRfpCoreAlertEmail(input, outcome.rfp) },
    );
    // Recovered (and the operator told so): the next failure of any reason is a new incident anyway.
    if (outcome.ok && "action" in result && result.action === "alert_recovered" && result.sent) reasons.clear();
    else if (!outcome.ok && "action" in result && result.action === "alert_failure" && result.sent) {
      reasons.set(reason, now.getTime());
    }
    return "action" in result ? { action: result.action } : result;
  });
}
