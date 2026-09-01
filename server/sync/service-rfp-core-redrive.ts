// =============================================================================
// RE-DRIVING A SERVICE-RFP DELIVERY THAT NEVER LANDED.
//
// WHY THIS EXISTS. When a Core delivery fails for a correctable reason — a customer that existed in
// Core's directory without its CRM id, an office the handoff wrongly refused, CRM uuids not yet
// deployed — the approval is already `approved`, and every production entry point refuses to touch it:
// processRfpApproval rejects a non-pending request, override-approve accepts only declined ones, and
// the force path rejects approved ones. So the job simply never reached Core, and the only recovery was
// editing the outbox table by hand. That happened three times before this was written.
//
// WHAT MAKES IT SAFE. Not this module — the UNIQUE INDEX and its upsert guard. A re-drive re-enters
// handOffServiceRfpApprovalToCore, which hits (source_system, source_deal_id, rfp_request_id) and may
// only replace a row that NEVER LEFT (`target_url IS NULL AND status='failed'`). A row already sent, or
// queued with a target, is untouched and the caller gets `duplicate`. So calling this on an approval
// that already landed cannot mint a second bid, which is the failure mode worth designing against:
// `bid` has no deleted_at, so a duplicate card could not be removed.
//
// It is therefore idempotent by construction rather than by convention, and needs no state of its own.
// =============================================================================

import { resolveEffectiveRfpProjectType, replaceProjectTypeInNumber } from "../constants";

export type RedriveOutcome =
  | { ok: true; status: "sent" | "pending" | "failed" | "skipped" | "dead" | "duplicate" }
  | { ok: false; reason: "not_found" | "not_approved" | "not_trock_crm" | "not_service" | "unbuildable" | "prior_delivery_unreadable"; detail: string };

/**
 * Re-attempt the Core handoff for an already-approved RFP request.
 *
 * The gates mirror what the approval path itself required, so a re-drive can never deliver something
 * the original approval would not have: the request must exist, be APPROVED (a pending one still has
 * its normal path), come from the CRM (Core stores uuid identities), and be a SERVICE job.
 */

/**
 * The `rfp.approvedAt` the ORIGINAL outbox row carried, or null when no row exists yet.
 *
 * Read rather than recomputed because it is the one field a re-drive must not move: Core's digest
 * excludes the transport stamp but INCLUDES this, so a different value turns a recovery into a
 * correction. Falls back to null so a first-ever delivery still stamps normally.
 */
async function priorPayloadApprovedAt(
  sourceDealId: string,
  rfpRequestId: number,
): Promise<{ kind: "found"; approvedAt: string } | { kind: "none" } | { kind: "inconclusive" }> {
  try {
    const { db } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const r: any = await db.execute(sql`
      SELECT payload -> 'rfp' ->> 'approvedAt' AS approved_at
        FROM service_rfp_core_outbox
       WHERE source_deal_id = ${sourceDealId} AND rfp_request_id = ${rfpRequestId}
       LIMIT 1
    `);
    const rows = (r?.rows ?? r) as Array<{ approved_at: string | null }>;
    const found = rows?.[0]?.approved_at ?? null;
    return found ? { kind: "found", approvedAt: found } : { kind: "none" };
  } catch {
    // INCONCLUSIVE IS NOT "NO PRIOR DELIVERY" — and the first version of this said exactly that in a
    // comment and then returned null anyway, which is the fallback it was warning against [Codex #83].
    //
    // The cost of getting it wrong is asymmetric. If the SELECT fails transiently and the upsert then
    // succeeds, a `dead` row from an AMBIGUOUS delivery is rebuilt with request.approvedAt — a later
    // timestamp — so Core reads a newer semantic event and may overwrite estimator changes made after
    // the original landed. Refusing costs an operator one retry; guessing silently rewrites their work.
    return { kind: "inconclusive" };
  }
}

export async function redriveServiceRfpToCore(rfpRequestId: number): Promise<RedriveOutcome> {
  // `storage` is imported LAZILY, matching service-rfp-core-outbox's getDb(). A top-level import pulls
  // server/db.ts into the graph of everything that reaches this module — including the route file — and
  // that made thirteen suites fail at import time with "DATABASE_URL must be set", because they mock
  // storage but never provision a database. The dependency is real; only its timing needs to be late.
  const { storage } = await import("../storage");
  const request = await storage.getRfpApprovalRequestById(rfpRequestId);
  if (!request) return { ok: false, reason: "not_found", detail: `RFP request ${rfpRequestId} does not exist` };

  // APPROVED ONLY, and that is the point of the endpoint. A pending request still has its ordinary
  // approval path; re-driving one here would deliver to Core without the approval ever completing.
  if (request.status !== "approved") {
    return { ok: false, reason: "not_approved", detail: `request ${rfpRequestId} is ${request.status}, not approved` };
  }
  if ((request.sourceSystem || "hubspot") !== "trock_crm") {
    return { ok: false, reason: "not_trock_crm", detail: "only trock_crm approvals carry the uuid identity Core stores" };
  }

  const dealData = (request.dealData ?? {}) as Record<string, any>;
  const editedFields = (request.editedFields ?? {}) as Record<string, string>;
  const typeDigit = resolveEffectiveRfpProjectType(dealData, editedFields);
  if (typeDigit !== "4") {
    return { ok: false, reason: "not_service", detail: `project type ${typeDigit} is not a service job` };
  }

  // THE NUMBER IS RECOMPUTED, not read off the row [Codex #83]. When an approver changes project_types,
  // processRfpApproval rewrites the number before its handoff but persists only the changed TYPE —
  // `request.projectNumber` keeps the pre-approval value. Preferring that column let a re-drive pass the
  // service gate on the edited type while sending Core the OLD non-service number, so the two systems
  // would disagree about which job this is. Same derivation as the approval path, so they cannot.
  const storedNumber = request.projectNumber ?? String(dealData.project_number ?? "");
  const projectNumber = storedNumber ? replaceProjectTypeInNumber(storedNumber, typeDigit) : storedNumber;

  // The SAME call the approval path makes, with the SAME inputs — a re-drive that built its payload
  // differently would deliver something the original approval never described.
  // Lazy for the same reason: service-rfp-core-outbox imports `log` from server/index.ts at the top
  // level, so importing IT eagerly drags routes/index.ts and db.ts into this route file's graph. Every
  // dependency in this module is deferred to call time; none of them is needed to define the route.
  const { handOffServiceRfpApprovalToCore, buildServiceRfpApprovedBody } = await import(
    "./service-rfp-core-outbox"
  );

  // ASK WHETHER THE PAYLOAD CAN EVEN BE BUILT, before re-driving [Codex #83]. `dealData` is the snapshot
  // taken when the request was created and is never refreshed, so if the original refusal was
  // missing_crm_identity, deploying the CRM uuid fields does NOT change this row — the rebuild refuses
  // identically. Without this check the conflict handler then returns `duplicate`, which reads as "already
  // delivered" and sends an operator looking in the wrong place. Naming the real reason is the difference
  // between a recoverable error and a confusing one; this case genuinely needs the approval re-issued.
  // What the ORIGINAL delivery told Core, if a row exists — see approvedAt below.
  const prior = await priorPayloadApprovedAt(request.sourceDealId, request.id);
  if (prior.kind === "inconclusive") {
    return {
      ok: false,
      reason: "prior_delivery_unreadable",
      detail: "could not read the prior outbox payload; re-driving now could send a newer approvedAt and overwrite later edits",
    };
  }
  const priorApprovedAt =
    prior.kind === "found"
      ? prior.approvedAt
      : request.approvedAt
        ? new Date(request.approvedAt).toISOString()
        : null;

  const probe: any = buildServiceRfpApprovedBody({
    sourceSystem: "trock_crm",
    sourceDealId: request.sourceDealId,
    rfpRequestId: request.id,
    projectNumber,
    dealData,
    editedFieldsOverride: editedFields,
  } as any);
  if (!probe.ok) {
    return { ok: false, reason: "unbuildable", detail: `${probe.reason}: ${probe.detail}` };
  }

  const result = await handOffServiceRfpApprovalToCore({
    sourceSystem: "trock_crm",
    sourceDealId: request.sourceDealId,
    rfpRequestId: request.id,
    projectNumber,
    dealData,
    editedFieldsOverride: editedFields,
    // approvedAt COMES FROM THE PRIOR PAYLOAD when there is one, and only falls back to the request row.
    //
    // It is Core's newest-wins ordering key and part of the semantic digest, so a re-drive must carry the
    // SAME value the original delivery did or Core reads the retry as a newer CORRECTION — re-entering
    // the update path and outranking whatever an estimator changed in between. `request.approvedAt` is
    // NOT that value: the normal handoff runs before Playwright and lets the builder stamp the time,
    // while processRfpApproval persists this column only after that multi-minute create finishes
    // [Codex #83]. The gap matters most for a `dead` row, where Core may have committed the original.
    ...(priorApprovedAt ? { approvedAt: new Date(priorApprovedAt) } : {}),
  } as any);

  // `log` is imported lazily for the same reason as `storage`: server/index.ts reaches routes/index.ts
  // and therefore db.ts, a chain this route file never touched before. A top-level import of it made
  // thirteen previously-passing tests fail at import time.
  const { log } = await import("../index");
  log(`[service-rfp-core] re-drive of RFP request ${rfpRequestId} -> ${result.status}`, "sync");
  return { ok: true, status: result.status };
}
