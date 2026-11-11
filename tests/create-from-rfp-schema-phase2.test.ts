import { describe, expect, it, vi } from "vitest";

// CONTRACT v2.2 §3 (E1 additive fields) + d9's confirmation of deal.scopeTitle / attachmentsOmitted (CRM rfp-payload.ts @6046965):
// every new field is OPTIONAL and SOFT (a malformed value is dropped, never a 422), so an old CRM body still parses unchanged.
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/rfp-approval.ts", () => ({ createRfpApprovalRequestFromNormalizedInput: vi.fn(), processRfpApproval: vi.fn(), checkRfpApprovalSourceEligibility: vi.fn() }));
vi.mock("../server/sync/bidboard-create-worker.ts", () => ({ enqueueBidboardCreateCommand: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ getHubSpotClient: vi.fn(), getAccessToken: vi.fn(), getDealOwnerInfo: vi.fn(), updateHubSpotDeal: vi.fn(), updateHubSpotDealStage: vi.fn(), syncSingleHubSpotDeal: vi.fn() }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const { createFromRfpBodySchema } = await import("../server/routes/rfp-requests.ts");

function body(o: Record<string, any> = {}, deal: Record<string, any> = {}) {
  return {
    sourceSystem: "trock_crm", sourceDealId: "00000000-0000-4000-8000-0000000000d3", sourceEventId: "crm:rfp-vote:approved:round-3",
    decision: "approved",
    deal: { name: "Synthetic", projectNumber: "DFW-2-11111-ab", projectType: "2", amount: null, estimator: null, companyName: null,
      contactName: null, clientEmail: null, clientPhone: null, address: null, description: null, dueDate: null, workflowRoute: "normal", ...deal },
    attachments: [],
    ...o,
  };
}
const APPROVAL = { roundEventId: "round-3", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-03T16:00:00.000Z" };

describe("createFromRfpBodySchema: Phase 2 E1 fields", () => {
  it("keeps approvalKind, approval, office, attachmentsOmitted and deal.scopeTitle", () => {
    const out = createFromRfpBodySchema.parse(body({ approvalKind: "vote", approval: APPROVAL, office: "dallas", attachmentsOmitted: 2 }, { scopeTitle: "Roof scope" })) as any;
    expect(out.approvalKind).toBe("vote");
    expect(out.approval).toEqual(APPROVAL);
    expect(out.office).toBe("dallas");
    expect(out.attachmentsOmitted).toBe(2);
    expect(out.deal.scopeTitle).toBe("Roof scope");
  });
  it("keeps approvalKind override and a null scopeTitle", () => {
    const out = createFromRfpBodySchema.parse(body({ approvalKind: "override" }, { scopeTitle: null })) as any;
    expect(out.approvalKind).toBe("override");
    expect(out.deal.scopeTitle).toBeNull();
  });
  it("is SOFT: malformed new fields are dropped, never a parse failure", () => {
    const r = createFromRfpBodySchema.safeParse(body({ approvalKind: "VOTE", approval: { approvals: "two" }, office: 7, attachmentsOmitted: -1 }, { scopeTitle: 42 }));
    expect(r.success).toBe(true);
    const out = (r as any).data;
    expect(out.approvalKind).toBeUndefined();
    expect(out.approval).toBeUndefined();
    expect(out.office).toBeUndefined();
    expect(out.attachmentsOmitted).toBeUndefined();
    expect(out.deal.scopeTitle).toBeUndefined();
  });
  it("an old CRM body (none of the new fields) still parses", () => {
    expect(createFromRfpBodySchema.safeParse(body()).success).toBe(true);
  });
});
