import { sql } from "drizzle-orm";
import { log } from "../log"; // never "../index": that boots the server, and the operator CLIs import this
import { buildBidBoardCreatedCallbackTargetUrl } from "./bidboard-callback-worker";

/**
 * THE CRM'S `approved` CALLBACK (owner 2026-11-13, b0cb0c4f; a4 afa14cfd): with Procore project creation retired, a service
 * RFP's approval completes on its T-Rock Core card, and the CRM is told with an `approved` callback that carries no Procore
 * field (CRM /api/internal/bid-board-created, status 'approved').
 *
 * ONE statement decides and enqueues it, so every caller agrees and every caller is idempotent:
 *   - the request is a CRM one and SyncHub has recorded it `approved` (a still-pending request is never told 'approved');
 *   - Core CONFIRMED its card (service_rfp_core_outbox delivered with a core_bid_id): a refused or still-queued handoff is
 *     NOT told 'approved', it stays visible as it is today (the CRM's core-rfp-handoff refusal notice, the outbox health);
 *   - the request has no callback yet: bidboard_callback_outbox is unique per rfp_approval_request_id, so ON CONFLICT DO
 *     NOTHING makes a second call (a re-drive, a replay, the reconcile run twice) enqueue nothing.
 * Callers: the approval, AFTER its write (Core may already have answered), Core's acceptance, AFTER its update (markSent),
 * and the reconcile for approvals stranded before this existed (scripts/rfp-reconcile-approved-callbacks.ts). Each checks
 * after its own write is committed, so whichever of the two lands second sees the other: neither order strands the CRM.
 */
async function getDb() {
  return (await import("../db")).db;
}

function rowsOf(result: unknown): any[] {
  return Array.isArray(result) ? result : ((result as any)?.rows ?? []);
}

/** Enqueue the CRM `approved` callback for one request when Core has confirmed its card. Returns whether a row was added. */
export async function enqueueRfpApprovedCallbackIfCoreConfirmed(
  requestId: number,
  options: { db?: any; targetUrl?: string | null } = {},
): Promise<boolean> {
  const targetUrl = options.targetUrl === undefined ? buildBidBoardCreatedCallbackTargetUrl() : options.targetUrl;
  if (!targetUrl) {
    log(`[rfp-approved-callback] TROCK_CRM_BASE_URL not configured; the CRM is not told RFP request ${requestId} was approved`, "rfp");
    return false;
  }
  const db = options.db ?? (await getDb());
  const result = await db.execute(sql`
    INSERT INTO bidboard_callback_outbox (source_system, source_deal_id, rfp_approval_request_id, payload, target_url, status, attempt_count, max_attempts, next_attempt_at)
    SELECT r.source_system, r.source_deal_id, r.id,
           jsonb_build_object(
             'status', 'approved',
             'sourceDealId', r.source_deal_id,
             'rfpApprovalRequestId', r.id,
             -- The number Core recorded (Codex P2 on #136): a type changed at approval rewrites the number sent to Core, and
             -- the request's own column keeps the original.
             'projectNumber', COALESCE(o.project_number, r.project_number),
             'coreBidId', o.core_bid_id,
             'approvedAt', to_char(r.approved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ),
           ${targetUrl}, 'pending', 0, 5, NOW()
      FROM rfp_approval_requests r
      JOIN LATERAL (
        SELECT core_bid_id, payload->'deal'->>'rfpProjectNumber' AS project_number FROM service_rfp_core_outbox o
         WHERE o.source_system = r.source_system AND o.source_deal_id = r.source_deal_id AND o.rfp_request_id = r.id
           AND o.status IN ('crm_notify_accepted', 'sent') AND o.core_bid_id IS NOT NULL
         ORDER BY o.id DESC LIMIT 1
      ) o ON TRUE
     WHERE r.id = ${requestId}
       AND r.source_system = 'trock_crm'
       AND r.status = 'approved' AND r.approved_at IS NOT NULL
    ON CONFLICT (rfp_approval_request_id) DO NOTHING
    RETURNING id
  `);
  const added = rowsOf(result).length > 0;
  if (added) log(`[rfp-approved-callback] RFP request ${requestId}: the CRM will be told it is approved (Core confirmed its card)`, "rfp");
  return added;
}

export interface ReconcileCandidate {
  requestId: number;
  status: string;
  service: boolean;
  coreConfirmed: boolean;
  callbackStatus: string | null;
}

export interface ReconcilePlan {
  /** Approved, Core confirmed, no CRM callback: the reconcile tells the CRM. */
  willNotify: number[];
  /** Approved with no Core confirmation (never handed off, refused, still queued): left visible, untouched. */
  coreNotConfirmed: number[];
  /** Already has a CRM callback row (delivered or queued): nothing to do. */
  alreadyHasCallback: number[];
  /** Not a service RFP: there is no Core card to confirm on this path; left for a person. */
  nonService: number[];
}

/**
 * Approved CRM requests with no Procore project: the requests a failed Procore create stranded. READ ONLY.
 * A request that has a Procore project was completed by the old 'created' callback and is not a candidate.
 */
export async function planApprovedCallbackReconcile(options: { db?: any } = {}): Promise<ReconcilePlan> {
  const db = options.db ?? (await getDb());
  const rows = rowsOf(await db.execute(sql`
    SELECT r.id, r.status,
           -- A request handed to Core is a service RFP whatever its stored number says (a type changed at approval keeps the
           -- original number in the column; Codex P2 on #136).
           (split_part(r.project_number, '-', 2) = '4'
             OR EXISTS (SELECT 1 FROM service_rfp_core_outbox h
                         WHERE h.source_system = r.source_system AND h.source_deal_id = r.source_deal_id AND h.rfp_request_id = r.id)) AS service,
           EXISTS (SELECT 1 FROM service_rfp_core_outbox o
                    WHERE o.source_system = r.source_system AND o.source_deal_id = r.source_deal_id AND o.rfp_request_id = r.id
                      AND o.status IN ('crm_notify_accepted', 'sent') AND o.core_bid_id IS NOT NULL) AS core_confirmed,
           (SELECT b.status FROM bidboard_callback_outbox b WHERE b.rfp_approval_request_id = r.id) AS callback_status
      FROM rfp_approval_requests r
     WHERE r.source_system = 'trock_crm' AND r.status = 'approved' AND r.bidboard_project_id IS NULL
     ORDER BY r.id
  `));
  const plan: ReconcilePlan = { willNotify: [], coreNotConfirmed: [], alreadyHasCallback: [], nonService: [] };
  for (const row of rows) {
    const id = Number(row.id);
    if (row.callback_status != null) plan.alreadyHasCallback.push(id);
    else if (!row.service) plan.nonService.push(id);
    else if (!row.core_confirmed) plan.coreNotConfirmed.push(id);
    else plan.willNotify.push(id);
  }
  return plan;
}

/** Apply the plan's willNotify through the same idempotent statement. Returns the request ids actually enqueued. */
export async function applyApprovedCallbackReconcile(plan: ReconcilePlan, options: { db?: any; targetUrl?: string | null } = {}): Promise<number[]> {
  const enqueued: number[] = [];
  for (const id of plan.willNotify) {
    if (await enqueueRfpApprovedCallbackIfCoreConfirmed(id, options)) enqueued.push(id);
  }
  return enqueued;
}
