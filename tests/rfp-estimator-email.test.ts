import { beforeEach, describe, expect, it, vi } from "vitest";

// L69 (a4 40810897 + OK a92858a3; d6 e78360df): the estimator the CRM SENT with an RFP (#1869's estimatorEmail, from its
// deals.estimator_user_id) reaches T-Rock Core through SyncHub's approval. SyncHub used to drop it at intake (normalizedDealData kept the
// name only), so an approval with no exact estimator_list name match seated no estimator (bid 91a8d0b8 / DFW-4-27426-aw: its approval
// carried no name at all, the silent branch). Now:
//   - the intake keeps it as deal_data.estimator_email (lower-cased, valid only; jsonb, no migration);
//   - an approval that did not change the estimator (the effective name, by the handoff's own rule, equals the stored one: no edit, a
//     blank edit, or the same name re-picked) hands Core that email; a different name falls to the exact list match, as before;
//   - no email at all is never silent: one plain line (warn, not wait: "the handoff is never blocked", service-rfp-core-outbox.ts).
// Synthetic data only.

const storageMock = vi.hoisted(() => ({ getAutomationConfig: vi.fn() }));
vi.mock("../server/storage.ts", () => ({ isUniqueViolation: vi.fn(() => false), storage: storageMock }));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn(async () => ({ ok: false })) }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const { normalizedDealData } = await import("../server/rfp-approval.ts");
const { resolveApprovalEstimator, ESTIMATOR_WARNING } = await import("../server/sync/rfp-estimator.ts");

const LIST = [
  { name: "Listed Estimator", email: "Listed.Estimator@Example.test" },
  { name: "No Email Estimator", email: "" },
];
const CRM_EMAIL = "crm.estimator@example.test";
const input = (dealData: Record<string, unknown>, edited: Record<string, string> = {}) => ({
  sourceSystem: "trock_crm", sourceDealId: "00000000-0000-4000-8000-000000000069", rfpRequestId: 69, projectNumber: "DFW-4-69069-aa",
  dealData, editedFieldsOverride: edited,
});

beforeEach(() => {
  storageMock.getAutomationConfig.mockReset();
  storageMock.getAutomationConfig.mockImplementation(async (key: string) => (key === "estimator_list" ? { value: { estimators: LIST } } : null));
});

describe("the intake keeps the CRM's estimator email", () => {
  const deal = (estimatorEmail: unknown) => ({
    sourceSystem: "trock_crm" as const, sourceDealId: "d-69", sourceEventId: "e-69",
    deal: { name: "Synthetic", projectNumber: "DFW-4-69069-aa", projectType: "4", amount: null, estimator: "Crm Estimator", estimatorEmail } as any,
  });

  it("a valid email is stored lower-cased as deal_data.estimator_email; a malformed or absent one is not stored", () => {
    expect(normalizedDealData(deal(" Crm.Estimator@Example.test ") as any, {}, null).estimator_email).toBe(CRM_EMAIL);
    expect("estimator_email" in normalizedDealData(deal("not-an-email") as any, {}, null)).toBe(false);
    expect("estimator_email" in normalizedDealData(deal(undefined) as any, {}, null)).toBe(false);
  });
});

describe("resolveApprovalEstimator: the email the approval hands Core, and the line when there is none", () => {
  const stored = { estimator: "Crm Estimator", estimator_email: CRM_EMAIL };

  it("(a) stored WITH the CRM's email and the estimator unchanged: that email; the list is not read", async () => {
    expect(await resolveApprovalEstimator(input(stored) as any)).toEqual({ email: CRM_EMAIL, warning: null, source: "crm" });
    expect(storageMock.getAutomationConfig).not.toHaveBeenCalled();
  });

  it("(b) the same name re-picked (trimmed equal), or a blank edit: the CRM's email is kept", async () => {
    expect((await resolveApprovalEstimator(input(stored, { estimator: "  Crm Estimator " }) as any)).email).toBe(CRM_EMAIL);
    expect((await resolveApprovalEstimator(input(stored, { estimator: "" }) as any)).email).toBe(CRM_EMAIL);
  });

  it("(c) a DIFFERENT name picked: that name's estimator_list email (lower-cased), never the CRM's", async () => {
    expect(await resolveApprovalEstimator(input(stored, { estimator: "Listed Estimator" }) as any))
      .toEqual({ email: "listed.estimator@example.test", warning: null, source: "list" });
  });

  it("(d) stored WITHOUT the email (a request from before this change), name in the list: the list email, as today", async () => {
    expect((await resolveApprovalEstimator(input({ estimator: "Listed Estimator" }) as any)).email).toBe("listed.estimator@example.test");
  });

  it("(e) a pick with no list email: no email, and the plain fix-path line", async () => {
    for (const name of ["Not Listed", "No Email Estimator"]) {
      expect(await resolveApprovalEstimator(input({ estimator: name }) as any)).toEqual({ email: null, warning: ESTIMATOR_WARNING.noListEmail, source: "none" });
    }
    expect(ESTIMATOR_WARNING.noListEmail).toBe("This estimator has no email in SyncHub's estimator list; add it there, or pick another.");
  });

  it("(f) no estimator at all and no stored email (bid 91a8d0b8's shape, a blank edit included): no email, and the no-estimator line", async () => {
    expect(await resolveApprovalEstimator(input({ estimator: "" }, { estimator: "" }) as any)).toEqual({ email: null, warning: ESTIMATOR_WARNING.none, source: "none" });
    expect(ESTIMATOR_WARNING.none).toBe("No estimator was picked; set one on the bid in T-Rock Core.");
  });

  it("an unreadable estimator_list: no email, and its own line", async () => {
    storageMock.getAutomationConfig.mockRejectedValue(new Error("synthetic read failure"));
    expect(await resolveApprovalEstimator(input({ estimator: "Listed Estimator" }) as any)).toEqual({ email: null, warning: ESTIMATOR_WARNING.listUnreadable, source: "none" });
    expect(ESTIMATOR_WARNING.listUnreadable).toBe("SyncHub's estimator list can't be read right now; set the estimator on the bid in T-Rock Core.");
  });
});
