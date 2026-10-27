// TELLING THE CRM THAT TROCK CORE REFUSED AN APPROVED SERVICE RFP (D-5).
//
// Core answers a refusal with 409 service_rfp_conflict and a closed-vocabulary reason (live_project, job_type_diverged,
// …). Until now that reached only Core's hidden audit row and this service's operator email: the CRM, and so the person
// who asked for the RFP, never learned the job was not in Core's service estimating lane.
//
// The refusal now rides the SAME outbox row it was recorded on. A Core 409 parks the row in
// `crm_notify_pending` (instead of going straight to 'failed'); this drain posts the CRM's signed
// /api/internal/core-handoff-refused callback — same HMAC and header as every other SyncHub -> CRM callback — and
// then settles the row at 'failed', exactly where a refusal always ended. The CRM records it on the deal, tells the
// requester and its admins in-app, and shows it on the deal page.
//
// WHAT THE ROW KEEPS. The callback reads, and never rewrites, the Core evidence on the row: last_error (Core's reason,
// after CORE_REFUSAL_ERROR_PREFIX), last_status_code (409), attempt_count and last_attempt_at (the moment Core
// refused). Scheduling uses only next_attempt_at, and the retry horizon is measured from last_attempt_at, so no column
// is added and nothing an operator reads about the Core delivery changes.
//
// SETTLING. 2xx (recorded, duplicate or stale on the CRM side): done. A deterministic CRM refusal (400/401/404/409/422):
// done, logged — retrying cannot change it. Unreachable, 408/429/5xx, or this side unprovisioned: retried with a
// growing delay, and given up (logged) once CRM_NOTIFY_HORIZON_MS has passed since Core refused.
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { log } from "../index";
import { CORE_REFUSAL_ERROR_PREFIX } from "./core-ingress-client";

export const CRM_NOTIFY_PENDING_STATUS = "crm_notify_pending" as const;
/** Stop retrying the CRM callback a day after Core refused: the operator email already went out. */
export const CRM_NOTIFY_HORIZON_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 2 * 60 * 60 * 1000;

async function getDb() {
  return (await import("../db")).db;
}

function rowsOf(result: unknown): any[] {
  return Array.isArray(result) ? result : ((result as any)?.rows ?? []);
}

export function buildCoreRefusalCallbackTargetUrl(baseUrl = process.env.TROCK_CRM_BASE_URL): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/api/internal/core-handoff-refused` : null;
}

/** Core's reason, read back off the row's last_error; null when the row does not hold a Core 409 refusal. */
export function coreReasonFromLastError(lastError: unknown): string | null {
  if (typeof lastError !== "string" || !lastError.startsWith(CORE_REFUSAL_ERROR_PREFIX)) return null;
  const reason = lastError.slice(CORE_REFUSAL_ERROR_PREFIX.length).trim();
  return reason || null;
}

/** The wait before the next try: about as long as it has already been since Core refused, between 30 s and 2 h. */
export function nextCrmNotifyDelayMs(elapsedMs: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, elapsedMs));
}

export interface CoreRefusalCallbackPayload {
  sourceDealId: string;
  rfpApprovalRequestId: number;
  reason: string;
  refusedAt: string;
}

export type CrmCallbackOutcome =
  | { kind: "sent"; status: number }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retryable"; status?: number; error: string };

/** POST the signed callback. Never throws: a transport failure is a retryable outcome. */
export async function postCoreRefusalToCrm(
  payload: CoreRefusalCallbackPayload,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null } = {},
): Promise<CrmCallbackOutcome> {
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  const targetUrl = deps.targetUrl === undefined ? buildCoreRefusalCallbackTargetUrl() : deps.targetUrl;
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
    const error = `CRM core-handoff-refused callback returned ${response.status}: ${text.slice(0, 200)}`;
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { kind: "retryable", status: response.status, error };
    }
    return { kind: "terminal", status: response.status, error };
  } catch (error: any) {
    return { kind: "retryable", error: `CRM core-handoff-refused callback failed: ${error?.message || error}` };
  }
}

/** Claim due rows. Only next_attempt_at moves (a short lease), so the Core evidence on the row is untouched. */
export async function claimCrmNotifyRows(limit = 5): Promise<any[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET next_attempt_at = NOW() + interval '5 minutes'
     WHERE id IN (
       SELECT id
         FROM service_rfp_core_outbox
        WHERE status = 'crm_notify_pending'
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return rowsOf(result);
}

async function settle(id: number): Promise<void> {
  const db = await getDb();
  // Guarded on the status: a re-drive that replaced this row meanwhile owns it now.
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET status = 'failed'
     WHERE id = ${id} AND status = 'crm_notify_pending'
  `);
}

async function reschedule(id: number, delayMs: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET next_attempt_at = NOW() + ${`${Math.round(delayMs / 1000)} seconds`}::interval
     WHERE id = ${id} AND status = 'crm_notify_pending'
  `);
}

/** One callback attempt for one claimed row; the row ends settled or rescheduled. */
export async function notifyCrmForRow(
  row: any,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null; now?: () => number } = {},
): Promise<"sent" | "terminal" | "gave_up" | "retrying"> {
  const id = Number(row.id);
  const reason = coreReasonFromLastError(row.last_error);
  const body = row.payload ?? {};
  const sourceDealId = typeof body?.deal?.id === "string" ? body.deal.id : String(row.source_deal_id ?? "");
  const rfpApprovalRequestId = Number(body?.rfp?.requestId ?? row.rfp_request_id);
  const refusedAtMs = new Date(row.last_attempt_at ?? row.created_at ?? Date.now()).getTime();
  if (!reason || !sourceDealId || !Number.isInteger(rfpApprovalRequestId)) {
    // Not a Core 409 refusal this module can describe; never strand the row in the pending state.
    await settle(id);
    log(`[service-rfp-core] Row ${id} parked for a CRM refusal notice without a Core reason; settled as failed`, "sync");
    return "terminal";
  }

  const outcome = await postCoreRefusalToCrm(
    { sourceDealId, rfpApprovalRequestId, reason, refusedAt: new Date(refusedAtMs).toISOString() },
    deps,
  );
  if (outcome.kind === "sent") {
    await settle(id);
    log(`[service-rfp-core] Row ${id}: CRM told that Core refused RFP request ${rfpApprovalRequestId} (${reason})`, "sync");
    return "sent";
  }
  if (outcome.kind === "terminal") {
    await settle(id);
    log(`[service-rfp-core] Row ${id}: CRM refused the Core-refusal notice: ${outcome.error}`, "sync");
    return "terminal";
  }
  const elapsed = Math.max(0, (deps.now ?? Date.now)() - refusedAtMs);
  if (elapsed >= CRM_NOTIFY_HORIZON_MS) {
    await settle(id);
    log(`[service-rfp-core] Row ${id}: gave up telling the CRM about Core's refusal after 24 h: ${outcome.error}`, "sync");
    return "gave_up";
  }
  await reschedule(id, nextCrmNotifyDelayMs(elapsed));
  return "retrying";
}

let crmNotifyRunning = false;

/** The drain, run on the outbox worker's tick after the Core deliveries. */
export async function processCoreRefusalCrmNotifications(
  options: { limit?: number; fetchImpl?: typeof fetchWithTimeout; secret?: string; targetUrl?: string | null } = {},
): Promise<{ processed: number; sent: number }> {
  if (crmNotifyRunning) return { processed: 0, sent: 0 };
  crmNotifyRunning = true;
  let sent = 0;
  try {
    const rows = await claimCrmNotifyRows(options.limit ?? 5);
    for (const row of rows) {
      try {
        if ((await notifyCrmForRow(row, options)) === "sent") sent += 1;
      } catch (error: any) {
        log(`[service-rfp-core] Row ${row.id} CRM refusal notice threw: ${error?.message || error}`, "sync");
      }
    }
    return { processed: rows.length, sent };
  } finally {
    crmNotifyRunning = false;
  }
}
