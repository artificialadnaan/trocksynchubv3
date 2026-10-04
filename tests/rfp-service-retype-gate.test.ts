import { beforeEach, describe, expect, it, vi } from "vitest";

// trockcrm#1479: an approver can retype a non-service CRM RFP to Service (type 4) on the SyncHub approval form. The
// CRM's service gate never saw it as service, so Core would refuse the handoff AFTER the deal moved and the BidBoard
// project was created. The approval is refused up front instead, using the same builder as the handoff.

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(),
    updateRfpApprovalRequest: vi.fn(),
    createAuditLog: vi.fn(),
  },
  isUniqueViolation: vi.fn(() => false),
}));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn(), GLOBAL_CC_RECIPIENTS: [] }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({ withBrowserLock: vi.fn() }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/sync/service-rfp-core-outbox.ts", async () => ({
  ...(await vi.importActual<any>("../server/sync/service-rfp-core-outbox.ts")),
  handOffServiceRfpApprovalToCore: vi.fn(),
}));

const DEAL = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b";
const COMPANY = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
const PROPERTY = "0a1b2c3d-4e5f-4a6b-9c7d-8e9fa0b1c2d3";

function crmRequest(dealData: Record<string, any>) {
  return {
    id: 77,
    status: "pending",
    sourceSystem: "trock_crm",
    sourceDealId: DEAL,
    dealData: {
      dealname: "Roof leak at Oak Plaza",
      project_number: "DFW-2-01234-ab",
      project_types: "2",
      crm_company_id: COMPANY,
      crm_property_id: PROPERTY,
      company_name: "Oak Plaza LLC",
      contact_name: "Pat Lee",
      client_email: "pat@example.test",
      ...dealData,
    },
  };
}

describe("serviceRetypeRefusal", () => {
  it("refuses a retype to 4 when Core's CRM identity is missing, naming it", async () => {
    const { serviceRetypeRefusal } = await import("../server/rfp-service-retype.ts");
    const gap = serviceRetypeRefusal(crmRequest({ crm_property_id: null }), { project_types: "4" });
    expect(gap).toMatch(/property/);
  });

  it("refuses a retype to 4 when a required field is missing, even if the form blanked it", async () => {
    const { serviceRetypeRefusal } = await import("../server/rfp-service-retype.ts");
    expect(serviceRetypeRefusal(crmRequest({ company_name: "" }), { project_types: "4" })).toMatch(/company name/);
  });

  it("allows a complete retype to 4; a form edit can supply what the deal lacked", async () => {
    const { serviceRetypeRefusal } = await import("../server/rfp-service-retype.ts");
    expect(serviceRetypeRefusal(crmRequest({}), { project_types: "4" })).toBeNull();
    expect(serviceRetypeRefusal(crmRequest({ company_name: "" }), { project_types: "4", company_name: "Oak Plaza LLC" })).toBeNull();
  });

  it("never applies to an RFP that was already service, a non-service approval, or a HubSpot RFP", async () => {
    const { serviceRetypeRefusal } = await import("../server/rfp-service-retype.ts");
    // Already service: the CRM's own gate covered it.
    expect(serviceRetypeRefusal(crmRequest({ project_number: "DFW-4-01234-ab", project_types: "4", crm_property_id: null }), {})).toBeNull();
    // Not service at all.
    expect(serviceRetypeRefusal(crmRequest({ crm_property_id: null }), { project_types: "3" })).toBeNull();
    // HubSpot: the Core handoff never applies (no uuid identity), unchanged here.
    expect(serviceRetypeRefusal({ ...crmRequest({ crm_property_id: null }), sourceSystem: "hubspot" }, { project_types: "4" })).toBeNull();
  });
});

describe("processRfpApproval — retype to service without Core's fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is refused before any side effect: no HubSpot write, no Core handoff, no BidBoard create", async () => {
    const { storage } = await import("../server/storage.ts");
    const { updateHubSpotDeal, updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { handOffServiceRfpApprovalToCore } = await import("../server/sync/service-rfp-core-outbox.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest({ crm_company_id: "" }) as any);

    const result = await processRfpApproval("tok", { project_types: "4" }, "approver@trockgc.com");

    expect(result).toMatchObject({ success: false, error: "service_retype_incomplete", statusCode: 422 });
    expect(result.message).toMatch(/company/);
    expect(updateHubSpotDeal).not.toHaveBeenCalled();
    expect(updateHubSpotDealStage).not.toHaveBeenCalled();
    expect(handOffServiceRfpApprovalToCore).not.toHaveBeenCalled();
    expect(createBidBoardProjectFromDeal).not.toHaveBeenCalled();
    expect(storage.updateRfpApprovalRequest).not.toHaveBeenCalled();
    const audits = vi.mocked(storage.createAuditLog).mock.calls.map((c: any[]) => c[0]?.details?.outcome ?? c[0]?.details);
    expect(JSON.stringify(audits)).toContain("service_retype_incomplete");
  });
});
