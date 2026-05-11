import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(),
    updateRfpApprovalRequest: vi.fn(),
    createAuditLog: vi.fn(),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(),
  updateHubSpotDeal: vi.fn().mockResolvedValue({ success: true }),
  updateHubSpotDealStage: vi.fn().mockResolvedValue({ success: true }),
  syncSingleHubSpotDeal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn().mockResolvedValue({ stageId: "stage-1", stageName: "Estimating" }),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  renderTemplate: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/browser.ts", () => ({
  withBrowserLock: vi.fn(),
}));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: vi.fn().mockResolvedValue({
    success: true,
    projectId: "BB-123",
    documentsUploaded: 0,
    documentErrors: [],
  }),
}));

vi.mock("../server/sync/crm-immediate-advance-fire.ts", () => ({
  fireCrmImmediateAdvance: vi.fn().mockResolvedValue(undefined),
}));

describe("processRfpApproval", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { storage } = await import("../server/storage.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { fireCrmImmediateAdvance } = await import("../server/sync/crm-immediate-advance-fire.ts");

    vi.mocked(storage.updateRfpApprovalRequest).mockResolvedValue(undefined as any);
    vi.mocked(storage.createAuditLog).mockResolvedValue(undefined as any);
    vi.mocked(createBidBoardProjectFromDeal).mockResolvedValue({
      success: true,
      projectId: "BB-123",
      documentsUploaded: 0,
      documentErrors: [],
    } as any);
    vi.mocked(fireCrmImmediateAdvance).mockResolvedValue(undefined);
  });

  it("creates the BidBoard project without taking an extra browser lock", async () => {
    const { storage } = await import("../server/storage.ts");
    const { withBrowserLock } = await import("../server/playwright/browser.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { updateHubSpotDeal, updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { fireCrmImmediateAdvance } = await import("../server/sync/crm-immediate-advance-fire.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 10,
      status: "pending",
      hubspotDealId: "321011207920",
      dealData: {
        dealname: "Test RFP",
        project_number: "DFW-2-12345",
        project_types: "2",
        proposalId: "456",
      },
    } as any);
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true } as any);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true } as any);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-1", stageName: "Estimating" } as any);

    const result = await processRfpApproval("token-123", {}, "approver@trockgc.com", {
      attachmentsOverride: [],
      newFiles: [],
    });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(createBidBoardProjectFromDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: "hubspot",
        sourceDealId: "321011207920",
        bidboardStage: "Estimate in Progress",
        options: expect.objectContaining({
          syncDocuments: true,
          attachmentsOverride: [],
          proposalId: "456",
        }),
      }),
    );
    expect(fireCrmImmediateAdvance).not.toHaveBeenCalled();
    expect(withBrowserLock).not.toHaveBeenCalled();
  });

  it("fires the CRM immediate advance callback for trock_crm requests after BidBoard succeeds", async () => {
    const { storage } = await import("../server/storage.ts");
    const { fireCrmImmediateAdvance } = await import("../server/sync/crm-immediate-advance-fire.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 77,
      status: "pending",
      sourceSystem: "trock_crm",
      sourceDealId: "deal-77",
      procoreCompanyId: "company-1",
      dealData: {
        dealname: "CRM Test RFP",
        project_number: "DFW-2-77777",
        project_types: "2",
        proposalId: "proposal-77",
      },
    } as any);

    const result = await processRfpApproval("token-crm", {}, "approver@trockgc.com", {
      attachmentsOverride: [],
      newFiles: [],
    });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(fireCrmImmediateAdvance).toHaveBeenCalledOnce();
    expect(fireCrmImmediateAdvance).toHaveBeenCalledWith({
      sourceDealId: "deal-77",
      rfpApprovalRequestId: 77,
      bidboardProjectId: "BB-123",
      procoreCompanyId: "company-1",
    });
    expect(storage.updateRfpApprovalRequest).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ status: "approved", bidboardProjectId: "BB-123" }),
    );
  });

  it("does not fail approval state write when the immediate CRM callback fails", async () => {
    const { storage } = await import("../server/storage.ts");
    const { fireCrmImmediateAdvance } = await import("../server/sync/crm-immediate-advance-fire.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 88,
      status: "pending",
      sourceSystem: "trock_crm",
      sourceDealId: "deal-88",
      procoreCompanyId: "company-1",
      dealData: {
        dealname: "CRM Test RFP Failure",
        project_number: "DFW-2-88888",
        project_types: "2",
      },
    } as any);
    vi.mocked(fireCrmImmediateAdvance).mockRejectedValueOnce(new Error("crm unavailable"));

    const result = await processRfpApproval("token-crm-fail", {}, "approver@trockgc.com", {
      attachmentsOverride: [],
      newFiles: [],
    });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(storage.updateRfpApprovalRequest).toHaveBeenCalledWith(
      88,
      expect.objectContaining({ status: "approved", bidboardProjectId: "BB-123" }),
    );
  });

  it("does not fire the CRM immediate advance callback when BidBoard creation fails", async () => {
    const { storage } = await import("../server/storage.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { fireCrmImmediateAdvance } = await import("../server/sync/crm-immediate-advance-fire.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 99,
      status: "pending",
      sourceSystem: "trock_crm",
      sourceDealId: "deal-99",
      dealData: {
        dealname: "CRM Test RFP BidBoard Failure",
        project_number: "DFW-2-99999",
        project_types: "2",
      },
    } as any);
    vi.mocked(createBidBoardProjectFromDeal).mockResolvedValueOnce({
      success: false,
      error: "BidBoard failed",
    } as any);

    const result = await processRfpApproval("token-crm-bb-fail", {}, "approver@trockgc.com", {
      attachmentsOverride: [],
      newFiles: [],
    });

    expect(result).toMatchObject({ success: false });
    expect(fireCrmImmediateAdvance).not.toHaveBeenCalled();
  });
});
