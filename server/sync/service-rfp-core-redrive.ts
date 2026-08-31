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

import { resolveEffectiveRfpProjectType } from "../constants";

export type RedriveOutcome =
  | { ok: true; status: "sent" | "pending" | "failed" | "skipped" | "dead" | "duplicate" }
  | { ok: false; reason: "not_found" | "not_approved" | "not_trock_crm" | "not_service"; detail: string };

/**
 * Re-attempt the Core handoff for an already-approved RFP request.
 *
 * The gates mirror what the approval path itself required, so a re-drive can never deliver something
 * the original approval would not have: the request must exist, be APPROVED (a pending one still has
 * its normal path), come from the CRM (Core stores uuid identities), and be a SERVICE job.
 */
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
  const projectNumber = request.projectNumber ?? String(dealData.project_number ?? "");
  const typeDigit = resolveEffectiveRfpProjectType(dealData, editedFields);
  if (typeDigit !== "4") {
    return { ok: false, reason: "not_service", detail: `project type ${typeDigit} is not a service job` };
  }

  // The SAME call the approval path makes, with the SAME inputs — a re-drive that built its payload
  // differently would deliver something the original approval never described.
  // Lazy for the same reason: service-rfp-core-outbox imports `log` from server/index.ts at the top
  // level, so importing IT eagerly drags routes/index.ts and db.ts into this route file's graph. Every
  // dependency in this module is deferred to call time; none of them is needed to define the route.
  const { handOffServiceRfpApprovalToCore } = await import("./service-rfp-core-outbox");
  const result = await handOffServiceRfpApprovalToCore({
    sourceSystem: "trock_crm",
    sourceDealId: request.sourceDealId,
    rfpRequestId: request.id,
    projectNumber,
    dealData,
    editedFieldsOverride: editedFields,
    // approvedAt is deliberately NOT re-stamped: it is Core's newest-wins ordering key, and moving it
    // would make a recovery look like a newer round than an edit somebody made in between.
    ...(request.approvedAt ? { approvedAt: new Date(request.approvedAt) } : {}),
  } as any);

  // `log` is imported lazily for the same reason as `storage`: server/index.ts reaches routes/index.ts
  // and therefore db.ts, a chain this route file never touched before. A top-level import of it made
  // thirteen previously-passing tests fail at import time.
  const { log } = await import("../index");
  log(`[service-rfp-core] re-drive of RFP request ${rfpRequestId} -> ${result.status}`, "sync");
  return { ok: true, status: result.status };
}
