import { beforeEach, describe, expect, it, vi } from "vitest";

// F-181, the RFP stage branch (scope d9 11-11). createRfpApprovalRequest never throws: both catches (rfp-approval.ts:1270 inside
// createRfpApprovalRequestFromNormalizedInput, :1338 in the wrapper) returned a plain {success:false, error}, so a FAULT (a
// HubSpot fetch, a DB read or write, the review-email template read) looked exactly like a refusal and the webhook dropped
// it. Both catches now mark `fault: true`; refusals stay unmarked. A fault is replayed by calling createRfpApprovalRequest
// again, and the approvers must get EXACTLY ONE review email across the original + the replay (a4): the template + recipient
// reads move BEFORE the insert, so a fault before the insert leaves no row (the replay creates and sends once) and a fault
// after it (the audit write) comes after the send (the replay's pending-row path sends nothing more). Synthetic data only.

const rfpRows = vi.hoisted(() => [] as any[]);
const emailLogs = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const getByIdMock = vi.hoisted(() => vi.fn());
const auditFault = vi.hoisted(() => ({ armed: false }));
const DEAL_PROPS = vi.hoisted(() => ({
  dealname: "Synthetic F181 Deal",
  project_number: "DFW-2-91810",
  project_types: "2",
  amount: "120000",
  company_name: "Synthetic Client",
  client_email: "client@example.com",
  address: "1 Synthetic Way",
  city: "Flower Mound",
  state: "TX",
  zip: "75022",
  hubspot_owner_id: "owner-f181",
}));
const storageMock = vi.hoisted(() => ({
  getRfpApprovalRequestByDealId: vi.fn(),
  getRfpApprovalRequestBySourceEventId: vi.fn(),
  getRfpApprovalRequestByProjectNumberAndStatus: vi.fn(),
  getRfpApprovalRequestBySourceDealAndStatus: vi.fn(),
  getRfpApprovalRequestBySourceDealId: vi.fn(),
  createRfpApprovalRequest: vi.fn(),
  getAutomationConfig: vi.fn(),
  getEmailTemplate: vi.fn(),
  getRfpApproverConfigs: vi.fn(),
  createEmailSendLog: vi.fn(),
  createAuditLog: vi.fn(),
  getHubspotDealByHubspotId: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ isUniqueViolation: vi.fn(() => false), storage: storageMock }));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(async () => ({ crm: { deals: { basicApi: { getById: getByIdMock } } } })),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Synthetic Owner", ownerEmail: "owner@example.com" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: vi.fn(async () => ({ ok: false })) }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: sendEmailMock, renderTemplate: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const DEAL = "hs-f181-1";

beforeEach(() => {
  vi.clearAllMocks();
  rfpRows.length = 0;
  emailLogs.length = 0;
  auditFault.armed = false;
  process.env.APP_URL = "https://synchub.example.com";
  getByIdMock.mockImplementation(async () => ({ properties: { ...DEAL_PROPS }, associations: {} }));
  storageMock.getRfpApprovalRequestByDealId.mockImplementation(async (dealId: string) =>
    rfpRows.find((r) => r.hubspotDealId === dealId && r.status === "pending"));
  storageMock.getRfpApprovalRequestBySourceEventId.mockImplementation(async (system: string, eventId: string) =>
    rfpRows.find((r) => r.sourceSystem === system && r.sourceEventId === eventId));
  storageMock.getRfpApprovalRequestByProjectNumberAndStatus.mockImplementation(async (projectNumber: string, status: string) =>
    rfpRows.find((r) => r.projectNumber === projectNumber && r.status === status));
  storageMock.getRfpApprovalRequestBySourceDealAndStatus.mockImplementation(async (system: string, dealId: string, status: string) =>
    rfpRows.find((r) => r.sourceSystem === system && r.sourceDealId === dealId && r.status === status));
  storageMock.getRfpApprovalRequestBySourceDealId.mockImplementation(async (system: string, dealId: string) =>
    rfpRows.find((r) => r.sourceSystem === system && r.sourceDealId === dealId));
  storageMock.createRfpApprovalRequest.mockImplementation(async (row: any) => {
    const inserted = { id: rfpRows.length + 1, createdAt: new Date(), ...row };
    rfpRows.push(inserted);
    return inserted;
  });
  storageMock.getAutomationConfig.mockResolvedValue(null);
  storageMock.getEmailTemplate.mockResolvedValue({ key: "rfp_review", enabled: true });
  storageMock.getRfpApproverConfigs.mockResolvedValue([{ projectType: "*", sourceSystem: null, approverEmails: ["reviewer@example.com"], isActive: true }]);
  storageMock.createEmailSendLog.mockImplementation(async (row: any) => {
    emailLogs.push(row);
    return { id: emailLogs.length, ...row };
  });
  storageMock.createAuditLog.mockImplementation(async (row: any) => {
    if (auditFault.armed && row?.action === "rfp_approval_request_created") {
      auditFault.armed = false;
      throw new Error("synthetic audit write failure");
    }
    return { id: 1, ...row };
  });
  storageMock.getHubspotDealByHubspotId.mockResolvedValue(undefined);
});

describe("F-181: createRfpApprovalRequest marks a fault, and a replay sends exactly one review email", () => {
  it("a HubSpot fetch that throws ⇒ fault: true, no row, no email; the replay creates once and sends exactly ONE", async () => {
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");
    getByIdMock.mockRejectedValueOnce(new Error("synthetic HubSpot fetch timeout"));
    const first = await createRfpApprovalRequest(DEAL);
    expect(first).toMatchObject({ success: false, fault: true, error: expect.stringContaining("synthetic HubSpot fetch timeout") });
    expect(rfpRows).toHaveLength(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    const replayed = await createRfpApprovalRequest(DEAL);
    expect(replayed).toMatchObject({ success: true });
    expect(rfpRows).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("the review-email template read throws ⇒ fault: true and NO request row; the replay creates once and sends exactly ONE", async () => {
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");
    storageMock.getEmailTemplate.mockRejectedValueOnce(new Error("synthetic template read failure"));
    const first = await createRfpApprovalRequest(DEAL);
    expect(first).toMatchObject({ success: false, fault: true, error: expect.stringContaining("synthetic template read failure") });
    expect(rfpRows).toHaveLength(0);
    const replayed = await createRfpApprovalRequest(DEAL);
    expect(replayed).toMatchObject({ success: true });
    expect(rfpRows).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(emailLogs).toHaveLength(1);
  });

  it("the audit write throws after the send ⇒ fault: true; the replay finds the pending row and sends nothing more (exactly ONE)", async () => {
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");
    auditFault.armed = true;
    const first = await createRfpApprovalRequest(DEAL);
    expect(first).toMatchObject({ success: false, fault: true, error: expect.stringContaining("synthetic audit write failure") });
    expect(rfpRows).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const replayed = await createRfpApprovalRequest(DEAL);
    expect(replayed).toMatchObject({ success: true, token: rfpRows[0].token });
    expect(rfpRows).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("(guard) a refusal (an approved project-number collision) is not a fault, and sends nothing", async () => {
    rfpRows.push({ id: 90, sourceSystem: "hubspot", sourceDealId: "hs-f181-other", sourceEventId: "hubspot:event:f181-other", projectNumber: "DFW-2-91810", hubspotDealId: "hs-f181-other", token: "token-f181-other", status: "approved", bidboardProjectId: "900190" });
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");
    const result: any = await createRfpApprovalRequest(DEAL);
    expect(result.success).toBe(false);
    expect(result.fault).toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("(guard) an existing pending request returns its token: success, no fault, no second email", async () => {
    const { createRfpApprovalRequest } = await import("../server/rfp-approval.ts");
    const first = await createRfpApprovalRequest(DEAL);
    const again: any = await createRfpApprovalRequest(DEAL);
    expect(first).toMatchObject({ success: true });
    expect(again).toMatchObject({ success: true, token: (first as any).token });
    expect(again.fault).toBeUndefined();
    expect(rfpRows).toHaveLength(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
