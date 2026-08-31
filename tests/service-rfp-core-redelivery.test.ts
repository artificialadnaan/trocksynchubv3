// =============================================================================
// A REDELIVERY IS A NO-OP. Pinned, because the comment that used to say otherwise drove a review to the
// wrong conclusion.
//
// `classifyResponse` creates two ambiguous outcomes on purpose:
//   • a POST that times out AFTER Core committed is classified retryable, so the worker posts again;
//   • a 2xx whose local "mark sent" write fails leaves the durable row `pending`, so the worker posts again.
//
// Both are only safe because Core's ingress is idempotent: `serviceRfpSemanticDigest` is an ordered
// projection of what the delivery MEANS and deliberately excludes `occurredAt` — the transport stamp this
// client re-stamps on every attempt. A redelivery therefore hashes identically and Core answers
// `outcome: "noop"` with the same bidId.
//
// This file asserts the PRODUCER half of that contract: that a retry sends semantically identical content,
// so Core's digest can recognise it. If someone later re-stamps something meaningful per attempt, these fail
// here rather than by silently minting a second bid in production — where `bid` has no `deleted_at` and the
// duplicate could not be removed.
// =============================================================================

import { describe, expect, it, vi } from "vitest";

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

import {
  buildServiceRfpApprovedBody,
  type ServiceRfpHandoffInput,
} from "../server/sync/service-rfp-core-outbox.ts";

const CRM_DEAL_ID = "11111111-1111-4111-8111-111111111111";
const CRM_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CRM_PROPERTY_ID = "33333333-3333-4333-8333-333333333333";

/** Mirrors the shape the approval path actually hands the builder (see service-rfp-core-handoff.test). */
const BASE: ServiceRfpHandoffInput = {
  sourceSystem: "trock_crm",
  sourceDealId: CRM_DEAL_ID,
  rfpRequestId: 77,
  projectNumber: "DFW-4-12345-aa",
  editedFieldsOverride: {},
  approvedAt: new Date("2026-08-31T12:00:00.000Z"),
  dealData: {
    dealname: "Roof leak triage",
    project_number: "DFW-4-12345-aa",
    project_types: "4",
    amount: 18500,
    company_name: "Acme Retail",
    contact_name: "Dana Ruiz",
    client_email: "Dana.Ruiz@acme.example",
    client_phone: "214-555-0134",
    address: "1200 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    country: "US",
    description: "Emergency roof leak at the north entry",
    notes: "Emergency roof leak at the north entry",
    bid_due_date: "2026-09-15T17:00:00.000Z",
    crm_company_id: CRM_COMPANY_ID,
    crm_property_id: CRM_PROPERTY_ID,
  },
};

/** Everything Core's digest reads — i.e. everything EXCEPT the transport stamp. */
function semanticProjection(body: Record<string, any>): unknown {
  const { occurredAt, ...rest } = body;
  return rest;
}

describe("a redelivery carries the same MEANING, so Core recognises it as a no-op", () => {
  it("separates the TRANSPORT stamp from the APPROVAL instant — the two roles the digest depends on", () => {
    const built = buildServiceRfpApprovedBody(BASE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The builder seeds occurredAt from the approval, and `stampOccurredAt` (module-private, applied at
    // send time) REWRITES it on every attempt because Core enforces a five-minute event-age window — a
    // stored payload replayed by the backoff worker would otherwise 401 on every attempt after the first
    // two intervals. That rewrite is exactly why Core's digest must exclude the field: a byte digest would
    // read each retry as a CORRECTION. `rfp.approvedAt` carries when the human actually approved and is
    // never rewritten, which is what makes it usable as the newest-wins ordering key.
    expect(typeof built.body.occurredAt).toBe("string");
    expect(Number.isNaN(Date.parse(built.body.occurredAt))).toBe(false);
    expect(built.body.rfp.approvedAt).toBe(BASE.approvedAt!.toISOString());
  });

  it("keeps every SEMANTIC field byte-identical across attempts", () => {
    const first = buildServiceRfpApprovedBody(BASE);
    const second = buildServiceRfpApprovedBody(BASE);
    if (!first.ok || !second.ok) throw new Error("fixture must build");
    // If this ever fails, a retry has become a CORRECTION in Core's eyes: it would re-enter the
    // newest-wins update path and could overwrite an estimator's edits to the still-pre-award card.
    expect(semanticProjection(second.body)).toEqual(semanticProjection(first.body));
  });

  it("keeps approvedAt stable across attempts — it is the ordering key, not a send timestamp", () => {
    const first = buildServiceRfpApprovedBody(BASE);
    const second = buildServiceRfpApprovedBody(BASE);
    if (!first.ok || !second.ok) throw new Error("fixture must build");
    // Core orders rounds by the APPROVAL instant. A per-attempt value here would make a retry look like a
    // newer round, which is the defect that made the digest exclude occurredAt in the first place.
    expect(second.body.rfp.approvedAt).toBe(first.body.rfp.approvedAt);
    expect(second.body.rfp.requestId).toBe(first.body.rfp.requestId);
  });

  it("keeps the identity uuids stable, so a retry cannot land on a different customer or site", () => {
    const first = buildServiceRfpApprovedBody(BASE);
    const second = buildServiceRfpApprovedBody(BASE);
    if (!first.ok || !second.ok) throw new Error("fixture must build");
    expect(second.body.deal.id).toBe(first.body.deal.id);
    expect(second.body.company.id).toBe(first.body.company.id);
    expect(second.body.property.id).toBe(first.body.property.id);
  });
});
