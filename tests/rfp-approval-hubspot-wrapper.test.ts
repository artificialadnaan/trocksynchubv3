import { beforeEach, describe, expect, it, vi } from "vitest";

const rfpRows = vi.hoisted(() => [] as any[]);
const emailLogs = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
// Mutable HubSpot deal properties so a test can swap in a routing/number mismatch.
const LEGACY_DEAL_PROPS = vi.hoisted(() => ({
  dealname: "Legacy HubSpot RFP",
  project_number: "DFW-2-99999",
  project_types: "2",
  amount: "250000",
  company_name: "HubSpot Client",
  client_email: "client@example.com",
  client_phone: "555-0100",
  address: "100 Main St",
  city: "Flower Mound",
  state: "TX",
  zip: "75022",
  description: "Legacy description",
  estimator: "Estimator",
  hubspot_owner_id: "owner-1",
}));
const dealProps = vi.hoisted(() => ({ current: { ...LEGACY_DEAL_PROPS } as Record<string, any> }));

vi.mock("../server/storage.ts", () => ({
  isUniqueViolation: vi.fn(() => false),
  storage: {
    getRfpApprovalRequestByDealId: vi.fn(async () => undefined),
    getRfpApprovalRequestBySourceEventId: vi.fn(async () => undefined),
    getRfpApprovalRequestByProjectNumberAndStatus: vi.fn(async () => undefined),
    getRfpApprovalRequestBySourceDealAndStatus: vi.fn(async () => undefined),
    createRfpApprovalRequest: vi.fn(async (row: any) => {
      const inserted = { id: rfpRows.length + 1, createdAt: new Date(), ...row };
      rfpRows.push(inserted);
      return inserted;
    }),
    getAutomationConfig: vi.fn(async () => null),
    getEmailTemplate: vi.fn(async () => ({ key: "rfp_review", enabled: true })),
    // Type-aware routing config: service (type 4) -> service@trockgc.com; everything else falls
    // through to the '*' default -> reviewer@trockgc.com. selectConfiguredRfpRecipients picks the
    // exact-projectType row first, then the '*' default.
    getRfpApproverConfigs: vi.fn(async () => [
      {
        projectType: "4",
        sourceSystem: null,
        approverEmails: ["service@trockgc.com"],
        isActive: true,
      },
      {
        projectType: "*",
        sourceSystem: null,
        approverEmails: ["reviewer@trockgc.com"],
        isActive: true,
      },
    ]),
    createEmailSendLog: vi.fn(async (row: any) => {
      emailLogs.push(row);
      return { id: emailLogs.length, ...row };
    }),
    createAuditLog: vi.fn(async (row: any) => ({ id: 1, ...row })),
    getHubspotDealByHubspotId: vi.fn(async () => undefined),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(async () => ({
    crm: {
      deals: {
        basicApi: {
          getById: vi.fn(async () => ({
            properties: dealProps.current,
            associations: {},
          })),
        },
      },
    },
  })),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Deal Owner", ownerEmail: "owner@trockgc.com" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));

vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: vi.fn(async () => ({ ok: false })),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn(),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

describe("legacy HubSpot RFP approval wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    rfpRows.length = 0;
    emailLogs.length = 0;
    sendEmailMock.mockClear();
    dealProps.current = { ...LEGACY_DEAL_PROPS };
    process.env.APP_URL = "https://synchub.example.com";
  });

  it("keeps the webhook-facing createRfpApprovalRequest outcome: one pending row and one review email", async () => {
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");

    const result = await createRfpApprovalRequest("hs-deal-1");

    expect(result).toMatchObject({ success: true });
    expect(result.token).toBeTruthy();
    expect(rfpRows).toHaveLength(1);
    expect(rfpRows[0]).toMatchObject({
      sourceSystem: "hubspot",
      sourceDealId: "hs-deal-1",
      hubspotDealId: "hs-deal-1",
      projectNumber: "DFW-2-99999",
      status: "pending",
    });
    expect(rfpRows[0].dealData).toMatchObject({
      dealname: "Legacy HubSpot RFP",
      ownerName: "Deal Owner",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: "reviewer@trockgc.com",
      subject: "Review Required: Legacy HubSpot RFP",
      fromName: "T-Rock Sync Hub",
    });
    expect(sendEmailMock.mock.calls[0][0].htmlBody).toContain("View in HubSpot");
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0]).toMatchObject({
      templateKey: "rfp_review",
      recipientEmail: "reviewer@trockgc.com",
      dedupeKey: `rfp_review:hs-deal-1:reviewer@trockgc.com:${result.token}`,
      metadata: { hubspotDealId: "hs-deal-1", token: result.token },
    });
  });

  it("routes the review email by the CANONICAL type when project_number's digit differs from project_types", async () => {
    // Mismatch: routed project_types is '2' (non-service) but the project NUMBER encodes type 4
    // (service). The send path must notify the SERVICE approvers (service@trockgc.com — the canonical
    // type the approval would create and the gate authorizes), NOT the non-service reviewer the raw
    // project_types would have routed to. (Old behavior routed by project_types '2' -> reviewer.)
    dealProps.current = { ...LEGACY_DEAL_PROPS, dealname: "Mismatched Service", project_number: "DFW-4-12345", project_types: "2" };
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");

    const result = await createRfpApprovalRequest("hs-deal-2");

    expect(result).toMatchObject({ success: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "service@trockgc.com" });
    expect(emailLogs).toHaveLength(1);
    expect(emailLogs[0]).toMatchObject({ recipientEmail: "service@trockgc.com" });
  });
});
