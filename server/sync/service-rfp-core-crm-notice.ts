// TELLING THE CRM HOW TROCK CORE ANSWERED AN APPROVED SERVICE RFP (D-5).
//
// Core answers a refusal with 409 service_rfp_conflict and a closed-vocabulary reason (live_project, job_type_diverged,
// …). Until now that reached only Core's hidden audit row and this service's operator email: the CRM, and so the person
// who asked for the RFP, never learned the job was not in Core's service estimating lane — nor, after an operator fixed
// the cause and re-drove the row, that it now was.
//
// Both outcomes now ride the SAME outbox row they were recorded on:
//   - a Core 409 parks the row in `crm_notify_refused` (instead of going straight to 'failed');
//   - a Core 2xx parks it in `crm_notify_accepted` (instead of going straight to 'sent').
// This drain posts the CRM's signed /api/internal/core-rfp-handoff callback — same HMAC and header as every other
// SyncHub -> CRM callback — and then settles the row where it always ended: 'failed' or 'sent'. The CRM records the
// event on the deal, tells the requester and its admins about a refusal, shows it on the deal page, and clears it when a
// later handoff of the same request is accepted.
//
// THE SIGNED BODY. { event, office, sourceDealId, rfpApprovalRequestId, occurredAt, attempt, reason? }. `occurredAt` is
// when Core answered (last_attempt_at for a refusal, sent_at for an acceptance) and `attempt` the row's attempt count
// then, so the CRM can order events and refuse replays; `office` binds the event to the deal's office.
//
// WHAT THE ROW KEEPS. The notice reads, and never rewrites, the Core evidence on the row: last_error (Core's reason,
// after CORE_REFUSAL_ERROR_PREFIX), last_status_code, attempt_count, last_attempt_at and sent_at. Scheduling uses only
// next_attempt_at, and the retry horizon is measured from occurredAt, so no column is added.
//
// SETTLING. 2xx: done. A deterministic CRM refusal (400/401/404/409/422): settled, and operators are alerted through
// the existing push-alert path. Unreachable, 408/429/5xx, or this side unprovisioned: retried with a growing delay, and
// given up — settled and alerted — once CRM_NOTIFY_HORIZON_MS has passed since Core answered.
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { log } from "../index";
import { CORE_REFUSAL_ERROR_PREFIX } from "./core-ingress-client";

export const CRM_NOTIFY_REFUSED_STATUS = "crm_notify_refused" as const;
export const CRM_NOTIFY_ACCEPTED_STATUS = "crm_notify_accepted" as const;
/** Stop retrying a day after Core answered (the CRM refuses events older than 48 h anyway). */
export const CRM_NOTIFY_HORIZON_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 2 * 60 * 60 * 1000;

async function getDb() {
  return (await import("../db")).db;
}

function rowsOf(result: unknown): any[] {
  return Array.isArray(result) ? result : ((result as any)?.rows ?? []);
}

export function buildCoreHandoffCallbackTargetUrl(baseUrl = process.env.TROCK_CRM_BASE_URL): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/api/internal/core-rfp-handoff` : null;
}

/** Core's reason, read back off the row's last_error; null when the row does not hold a Core 409 refusal. */
export function coreReasonFromLastError(lastError: unknown): string | null {
  if (typeof lastError !== "string" || !lastError.startsWith(CORE_REFUSAL_ERROR_PREFIX)) return null;
  const reason = lastError.slice(CORE_REFUSAL_ERROR_PREFIX.length).trim();
  return reason || null;
}

/** The wait before the next try: about as long as it has already been since Core answered, between 30 s and 2 h. */
export function nextCrmNotifyDelayMs(elapsedMs: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, elapsedMs));
}

export interface CoreHandoffCallbackPayload {
  event: "refused" | "accepted";
  office: string;
  sourceDealId: string;
  rfpApprovalRequestId: number;
  occurredAt: string;
  attempt: number;
  reason?: string;
}

export type CrmCallbackOutcome =
  | { kind: "sent"; status: number }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retryable"; status?: number; error: string };

/** POST the signed callback. Never throws: a transport failure is a retryable outcome. */
export async function postCoreHandoffToCrm(
  payload: CoreHandoffCallbackPayload,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null } = {},
): Promise<CrmCallbackOutcome> {
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  const targetUrl = deps.targetUrl === undefined ? buildCoreHandoffCallbackTargetUrl() : deps.targetUrl;
  if (!secret || !targetUrl) {
    return { kind: "retryable", error: "TROCK_CRM_BASE_URL or RFP_REQUEST_SYNC_SECRET is not configured" };
  }
  const rawBody = JSON.stringify(payload);
  try {
    const response = await (deps.fetchImpl ?? fetchWithTimeout)(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`,
      },
      body: rawBody,
    });
    const text = await response.text().catch(() => "");
    if (response.ok) return { kind: "sent", status: response.status };
    const error = `CRM core-rfp-handoff callback returned ${response.status}: ${text.slice(0, 200)}`;
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { kind: "retryable", status: response.status, error };
    }
    return { kind: "terminal", status: response.status, error };
  } catch (error: any) {
    return { kind: "retryable", error: `CRM core-rfp-handoff callback failed: ${error?.message || error}` };
  }
}

/** Claim due rows. Only next_attempt_at moves (a short lease), so the Core evidence on the row is untouched. */
export async function claimCrmNoticeRows(limit = 5): Promise<any[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET next_attempt_at = NOW() + interval '5 minutes'
     WHERE id IN (
       SELECT id
         FROM service_rfp_core_outbox
        WHERE status IN ('crm_notify_refused', 'crm_notify_accepted')
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return rowsOf(result);
}

/** Settle at the status the row always ended at. Guarded: a re-drive that replaced the row meanwhile owns it now. */
async function settle(id: number, parked: string): Promise<void> {
  const db = await getDb();
  if (parked === CRM_NOTIFY_ACCEPTED_STATUS) {
    await db.execute(sql`
      UPDATE service_rfp_core_outbox SET status = 'sent' WHERE id = ${id} AND status = 'crm_notify_accepted'
    `);
    return;
  }
  await db.execute(sql`
    UPDATE service_rfp_core_outbox SET status = 'failed' WHERE id = ${id} AND status = 'crm_notify_refused'
  `);
}

async function reschedule(id: number, parked: string, delayMs: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET next_attempt_at = NOW() + ${`${Math.round(delayMs / 1000)} seconds`}::interval
     WHERE id = ${id} AND status = ${parked}
  `);
}

/** The notice a parked row describes, or null when it cannot describe one (it is then settled without a POST). */
export function crmNoticeForRow(row: any): CoreHandoffCallbackPayload | null {
  const body = row.payload ?? {};
  const event = row.status === CRM_NOTIFY_ACCEPTED_STATUS ? "accepted" : row.status === CRM_NOTIFY_REFUSED_STATUS ? "refused" : null;
  const office = typeof body?.office === "string" && body.office ? body.office : null;
  const sourceDealId = typeof body?.deal?.id === "string" ? body.deal.id : String(row.source_deal_id ?? "");
  const rfpApprovalRequestId = Number(body?.rfp?.requestId ?? row.rfp_request_id);
  const at = event === "accepted" ? (row.sent_at ?? row.last_attempt_at) : row.last_attempt_at;
  const occurredMs = at ? new Date(at).getTime() : NaN;
  const attempt = Number(row.attempt_count ?? 0);
  if (!event || !office || !sourceDealId || !Number.isInteger(rfpApprovalRequestId) || !Number.isFinite(occurredMs)) return null;
  if (event === "refused") {
    const reason = coreReasonFromLastError(row.last_error);
    if (!reason) return null;
    return { event, office, sourceDealId, rfpApprovalRequestId, occurredAt: new Date(occurredMs).toISOString(), attempt, reason };
  }
  return { event, office, sourceDealId, rfpApprovalRequestId, occurredAt: new Date(occurredMs).toISOString(), attempt };
}

/** At most this long waiting on the alerter (a wedged mail send must not hold the drain), as the Core path does. */
const ALERT_DISPATCH_WAIT_MS = 2_000;

async function bounded(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ALERT_DISPATCH_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** Operators hear about a notice that will never reach the CRM, through the existing push-alert path. */
async function alertSettledFailure(notice: CoreHandoffCallbackPayload | null, row: any, error: string, status?: number): Promise<void> {
  try {
    const { recordServiceRfpCrmNoticeOutcome } = await import("./service-rfp-core-alert");
    await bounded(recordServiceRfpCrmNoticeOutcome({
      office: notice?.office ?? row?.payload?.office ?? null,
      ok: false,
      status,
      error,
      event: notice?.event ?? (row.status === CRM_NOTIFY_ACCEPTED_STATUS ? "accepted" : "refused"),
      rfpRequestId: Number(row.rfp_request_id),
      sourceDealId: String(row.source_deal_id ?? ""),
    }));
  } catch (err: any) {
    log(`[service-rfp-core] CRM notice alert dispatch failed: ${err?.message || err}`, "sync");
  }
}

async function reportNoticeDelivered(notice: CoreHandoffCallbackPayload, row: any): Promise<void> {
  try {
    const { recordServiceRfpCrmNoticeOutcome } = await import("./service-rfp-core-alert");
    await bounded(recordServiceRfpCrmNoticeOutcome({
      office: notice.office,
      ok: true,
      event: notice.event,
      rfpRequestId: Number(row.rfp_request_id),
      sourceDealId: String(row.source_deal_id ?? ""),
    }));
  } catch (err: any) {
    log(`[service-rfp-core] CRM notice alert dispatch failed: ${err?.message || err}`, "sync");
  }
}

/** One callback attempt for one claimed row; the row ends settled or rescheduled. */
export async function notifyCrmForRow(
  row: any,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null; now?: () => number } = {},
): Promise<"sent" | "terminal" | "gave_up" | "retrying"> {
  const id = Number(row.id);
  const parked = String(row.status);
  const notice = crmNoticeForRow(row);
  if (!notice) {
    // Nothing this module can describe; never strand the row in a parked state.
    await settle(id, parked);
    log(`[service-rfp-core] Row ${id} parked for a CRM notice it cannot describe; settled`, "sync");
    if (parked === CRM_NOTIFY_REFUSED_STATUS) await alertSettledFailure(null, row, "the refusal could not be described to the CRM");
    return "terminal";
  }

  const outcome = await postCoreHandoffToCrm(notice, deps);
  if (outcome.kind === "sent") {
    await settle(id, parked);
    await reportNoticeDelivered(notice, row);
    log(`[service-rfp-core] Row ${id}: CRM told Core ${notice.event} RFP request ${notice.rfpApprovalRequestId}`, "sync");
    return "sent";
  }
  if (outcome.kind === "terminal") {
    await settle(id, parked);
    await alertSettledFailure(notice, row, outcome.error, outcome.status);
    log(`[service-rfp-core] Row ${id}: CRM refused the Core ${notice.event} notice: ${outcome.error}`, "sync");
    return "terminal";
  }
  const elapsed = Math.max(0, (deps.now ?? Date.now)() - new Date(notice.occurredAt).getTime());
  if (elapsed >= CRM_NOTIFY_HORIZON_MS) {
    await settle(id, parked);
    await alertSettledFailure(notice, row, `gave up after 24 h: ${outcome.error}`, outcome.status);
    log(`[service-rfp-core] Row ${id}: gave up telling the CRM about Core's ${notice.event} after 24 h: ${outcome.error}`, "sync");
    return "gave_up";
  }
  await reschedule(id, parked, nextCrmNotifyDelayMs(elapsed));
  return "retrying";
}

let crmNoticeRunning = false;

/** The drain, run on the outbox worker's tick after the Core deliveries. */
export async function processCoreHandoffCrmNotices(
  options: { limit?: number; fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null } = {},
): Promise<{ processed: number; sent: number }> {
  if (crmNoticeRunning) return { processed: 0, sent: 0 };
  crmNoticeRunning = true;
  let sent = 0;
  try {
    const rows = await claimCrmNoticeRows(options.limit ?? 5);
    for (const row of rows) {
      try {
        if ((await notifyCrmForRow(row, options)) === "sent") sent += 1;
      } catch (error: any) {
        log(`[service-rfp-core] Row ${row.id} CRM notice threw: ${error?.message || error}`, "sync");
      }
    }
    return { processed: rows.length, sent };
  } finally {
    crmNoticeRunning = false;
  }
}
