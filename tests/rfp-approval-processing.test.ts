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
  GLOBAL_CC_RECIPIENTS: [], // rfp-approval imports this; keep the partial mock complete
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

describe("processRfpApproval", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates the BidBoard project without taking an extra browser lock", async () => {
    const { storage } = await import("../server/storage.ts");
    const { withBrowserLock } = await import("../server/playwright/browser.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { updateHubSpotDeal, updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
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
      "321011207920",
      "Estimate in Progress",
      expect.objectContaining({
        syncDocuments: true,
        attachmentsOverride: [],
        proposalId: "456",
      }),
    );
    expect(withBrowserLock).not.toHaveBeenCalled();
  });

  it("forwards the CRM activity log to the create for a HUBSPOT-sourced request too", async () => {
    // normalizedDealData is passed only for trock_crm, so a hubspot request carrying crmActivityLog
    // would have it persisted in deal_data and then silently dropped before the create — "accepted but
    // unused". editedFieldsOverride is passed for BOTH source systems, so it travels there instead.
    const { storage } = await import("../server/storage.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { updateHubSpotDeal, updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const activityLog = "CRM Activity Log — DFW-2-12345 (as of Aug 17, 2026)\n\nAug 14 · Call · Jane Rep";
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 11,
      status: "pending",
      sourceSystem: "hubspot",
      hubspotDealId: "321011207920",
      dealData: {
        dealname: "Test RFP",
        project_number: "DFW-2-12345",
        project_types: "2",
        crm_activity_log: activityLog,
      },
    } as any);
    vi.mocked(createBidBoardProjectFromDeal).mockResolvedValue({ success: true, projectId: "BB-124" } as any);
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true } as any);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true } as any);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-1", stageName: "Estimating" } as any);

    await processRfpApproval("token-124", {}, "approver@trockgc.com");

    // The call uses the args-OBJECT form: ({ sourceSystem, sourceDealId, bidboardStage, options }).
    const args = vi.mocked(createBidBoardProjectFromDeal).mock.calls.at(-1)?.[0] as any;
    expect(args.options.editedFieldsOverride.crm_activity_log).toBe(activityLog);
    // normalizedDealData stays trock_crm-only — this is the path that makes hubspot work.
    expect(args.normalizedDealData).toBeUndefined();
  });

  it("omits crm_activity_log entirely when the request carries none", async () => {
    const { storage } = await import("../server/storage.ts");
    const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
    const { updateHubSpotDeal, updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { resolveHubspotStageId } = await import("../server/procore-hubspot-sync.ts");
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue({
      id: 12,
      status: "pending",
      hubspotDealId: "321011207920",
      dealData: { dealname: "Test RFP", project_number: "DFW-2-12345", project_types: "2" },
    } as any);
    vi.mocked(createBidBoardProjectFromDeal).mockResolvedValue({ success: true, projectId: "BB-125" } as any);
    vi.mocked(updateHubSpotDeal).mockResolvedValue({ success: true } as any);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true } as any);
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "stage-1", stageName: "Estimating" } as any);

    await processRfpApproval("token-125", {}, "approver@trockgc.com");

    const args = vi.mocked(createBidBoardProjectFromDeal).mock.calls.at(-1)?.[0] as any;
    expect("crm_activity_log" in args.options.editedFieldsOverride).toBe(false);
  });
});
