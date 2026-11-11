/**
 * F-181: a failed HubSpot deal-stage trigger is visible and, only when no Procore project can exist, replayable.
 *
 * The webhook used to log a stage-trigger failure and mark the event `processed`, so a stage change that should have created
 * a Bid Board project could vanish. Now the failure marks the webhook `failed` (internal only: HubSpot still gets 200, so it
 * never auto-retries into a duplicate create) and its errorMessage carries the replay class:
 * - "replayable: …" ONLY on positive evidence that the create never reached a create control (the result's `beforeSubmit`
 *   with no projectId), a Core hold check that could not run (the create never ran), or a createRfpApprovalRequest fault
 *   (dedupe-safe on replay);
 * - "manual: a project may exist; …" for everything else (a throw, an indeterminate create, any projectId). The replay
 *   endpoint refuses it, and a stage event with no prefix, before touching the row.
 * No DDL: the class lives in the webhook log's errorMessage.
 */
import { log } from "../log";

export const REPLAYABLE_PREFIX = "replayable: ";
export const MANUAL_PREFIX = "manual: a project may exist; ";

export type StageTriggerOutcome = { triggered: boolean; result?: any; reason?: string };
export type StageTriggerAlertCode = "stage_trigger_failed" | "rfp_request_fault";

/** The live handler's object-type rule (HubSpot v3 events carry no objectType), shared with the replay. */
export function hubspotObjectType(event: any): string {
  const eventType = event?.subscriptionType || event?.eventType || "";
  return event?.objectType || (eventType.startsWith("deal.") ? "deal" : eventType.startsWith("contact.") ? "contact" : eventType.startsWith("company.") ? "company" : "");
}

export function isHubspotDealStageEvent(event: any): boolean {
  const eventType = event?.subscriptionType || event?.eventType || "";
  return hubspotObjectType(event) === "deal" && eventType.includes("propertyChange") && (event?.propertyName || "") === "dealstage";
}

/**
 * A stage trigger's outcome as a webhook failure, or null when it succeeded or did nothing by design (disabled, not a
 * trigger stage, already linked, held). `alert` is false for the hold check that could not run: A3 already raised
 * core_preflight_error for it.
 */
export function stageTriggerFailure(dealId: string, outcome: StageTriggerOutcome | undefined): { errorMessage: string; alert: boolean } | null {
  if (outcome?.triggered) {
    const result = outcome.result;
    if (result?.success === true) return null;
    const replayable = result?.beforeSubmit === true && !result?.projectId;
    return {
      errorMessage: `${replayable ? REPLAYABLE_PREFIX : MANUAL_PREFIX}the BidBoard create for deal ${dealId} failed: ${result?.error || "no result"}`,
      alert: true,
    };
  }
  if (outcome?.reason === "core_footprint_check_failed") {
    return { errorMessage: `${REPLAYABLE_PREFIX}the Core footprint check for deal ${dealId} could not run; the create was not attempted`, alert: false };
  }
  return null;
}

/** A throw carries no pre-submit evidence: manual. */
export function stageTriggerThrowMessage(dealId: string, err: any): string {
  return `${MANUAL_PREFIX}the stage trigger for deal ${dealId} threw: ${err?.message ?? String(err)}`;
}

export function rfpRequestFaultMessage(dealId: string, error: string | undefined): string {
  return `${REPLAYABLE_PREFIX}the RFP approval request for deal ${dealId} faulted: ${error || "unknown error"}`;
}

/**
 * ONE windowed ops alert per outage (namespace "hubspot-stage-trigger:<code>", signatureChanged false): every failed deal is
 * also listed by GET /api/webhooks/failed. Shares bidboard-crm-alert's debounce state machine under its own namespace, as
 * rfp-core-alert does. Never throws: an alert failure must not change the webhook outcome.
 */
export async function raiseHubspotStageTriggerAlert(
  code: StageTriggerAlertCode,
  detail: { dealId: string; stage: string; webhookLogId: number; error: string },
): Promise<void> {
  const summary = `deal ${detail.dealId}, stage ${detail.stage}, webhook log ${detail.webhookLogId}: ${detail.error}`;
  try {
    log(`[hubspot-stage-trigger] ALERT ${code} ${summary}`, "webhook");
  } catch {
    /* logging must not throw either */
  }
  try {
    const { recordPushOutcomeAndMaybeAlert, escapeHtml } = await import("../sync/bidboard-crm-alert");
    await recordPushOutcomeAndMaybeAlert(
      {
        pushResult: { ok: false, attempts: 1, error: `${code}: ${summary}`, rejected: true },
        officeSlug: `hubspot-stage-trigger:${code}`,
        signatureChanged: false,
      },
      {
        render: (input) => ({
          subject: `[SyncHub] HubSpot stage trigger alert: ${code}`,
          htmlBody:
            `<p>A HubSpot deal-stage trigger failed (<b>${escapeHtml(code)}</b>) at ${escapeHtml(input.now.toISOString())}.</p>` +
            `<p>${escapeHtml(input.error ?? summary)}</p>` +
            `<p>Where to look: GET /api/webhooks/failed. A "replayable:" row can be replayed; a "manual:" row may already have ` +
            `a Procore project, so check Bid Board by the deal's project number before acting. Further failures inside the ` +
            `re-alert window are not emailed.</p>`,
        }),
      },
    );
  } catch (err) {
    try {
      log(`[hubspot-stage-trigger] alert delivery failed for ${code}: ${(err as Error)?.message ?? err}`, "webhook");
    } catch {
      /* swallow */
    }
  }
}
