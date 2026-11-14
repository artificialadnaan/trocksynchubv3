import { beforeEach, describe, expect, it, vi } from "vitest";

// PROCORE PROJECT CREATION IS RETIRED (owner 2026-11-13, b0cb0c4f; a4 afa14cfd): processRfpApproval no longer claims, creates or
// waits on a Procore Bid Board project. A service RFP completes on its T-Rock Core card (the handoff) and the CRM's `approved`
// callback once Core confirms it; a non-service RFP approved by link has no Core route, so the CRM is told it FAILED. The
// Procore create below is a stub that records calls and throws ("Procore unavailable"): every case expects it untouched.
// Synthetic data only (I7).
vi.mock("../server/sync/rfp-approving.ts", () => ({ RFP_APPROVING_STATUS: "approving" }));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(),
    updateRfpApprovalRequest: vi.fn(),
    createAuditLog: vi.fn(),
    enqueueBidboardCallback: vi.fn(),
    getAutomationConfig: vi.fn(async () => null),
  },
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
vi.mock("../server/log.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({ withBrowserLock: vi.fn() }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-source-eligibility.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/api/internal/bid-board-created",
  buildRfpDeclinedCallbackTargetUrl: () => "https://crm.example.test/api/internal/rfp-declined",
}));
vi.mock("../server/sync/service-rfp-core-outbox.ts", () => ({ handOffServiceRfpApprovalToCore: vi.fn() }));
vi.mock("../server/sync/rfp-approved-callback.ts", () => ({ enqueueRfpApprovedCallbackIfCoreConfirmed: vi.fn() }));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: vi.fn(async () => true) }));

const { storage } = await import("../server/storage.ts");
const { withBrowserLock } = await import("../server/playwright/browser.ts");
const { createBidBoardProjectFromDeal } = await import("../server/playwright/bidboard.ts");
const { handOffServiceRfpApprovalToCore } = await import("../server/sync/service-rfp-core-outbox.ts");
const { enqueueRfpApprovedCallbackIfCoreConfirmed } = await import("../server/sync/rfp-approved-callback.ts");
const { raiseRfpCoreAlert } = await import("../server/sync/rfp-core-alert.ts");
const { sendEmail } = await import("../server/email-service.ts");
const { processRfpApproval } = await import("../server/rfp-approval.ts");
const { PROCORE_CREATE_RETIRED_ERROR } = await import("../server/sync/procore-create-retired.ts");

const DEAL = "00000000-0000-4000-8000-000000000070";
function crmRequest(over: Record<string, unknown> = {}) {
  return {
    id: 70, status: "pending", sourceSystem: "trock_crm", sourceDealId: DEAL, projectNumber: "DFW-4-70070-aa", hubspotDealId: null,
    tokenExpiresAt: new Date(Date.now() + 86_400_000),
    dealData: { dealname: "Synthetic Service RFP", project_number: "DFW-4-70070-aa", project_types: "4" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createBidBoardProjectFromDeal).mockRejectedValue(new Error("Procore unavailable"));
  vi.mocked(storage.updateRfpApprovalRequest).mockImplementation(async (id: number, data: any) => ({ id, ...data }) as any);
  vi.mocked(enqueueRfpApprovedCallbackIfCoreConfirmed).mockResolvedValue(true);
});

describe("processRfpApproval with Procore project creation retired", () => {
  // DFW and ATL are project-number PREFIXES in one shared system (owner 2026-11-13, dcd308cf): both take the same path.
  it.each(["DFW-4-70070-aa", "ATL-4-70070-aa"])("a SERVICE approval (%s) with Procore unavailable completes on Core: approved, handed to Core, the CRM told, ZERO Procore creates", async (pn) => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(
      crmRequest({ projectNumber: pn, dealData: { dealname: "Synthetic Service RFP", project_number: pn, project_types: "4" } }) as any,
    );

    const result = await processRfpApproval("synthetic-token-70", {}, "approver@example.test", { attachmentsOverride: [], newFiles: [] });

    expect(result).toEqual({ success: true });
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
    expect(vi.mocked(withBrowserLock).mock.calls.length).toBe(0);
    expect(handOffServiceRfpApprovalToCore).toHaveBeenCalledTimes(1);
    expect(handOffServiceRfpApprovalToCore).toHaveBeenCalledWith(expect.objectContaining({ rfpRequestId: 70, sourceDealId: DEAL }));
    expect(storage.updateRfpApprovalRequest).toHaveBeenCalledWith(
      70,
      expect.objectContaining({ status: "approved", approvedBy: "approver@example.test", bidboardProjectId: null }),
      { expectedStatus: "pending" },
    );
    expect(enqueueRfpApprovedCallbackIfCoreConfirmed).toHaveBeenCalledWith(70);
    expect(storage.enqueueBidboardCallback).not.toHaveBeenCalled();
  });

  it("CodeRabbit on #136: a SKIPPED Core handoff (no outbox row) stays approved, raises the alert, and the email says a re-drive is needed", async () => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest() as any);
    vi.mocked(handOffServiceRfpApprovalToCore).mockResolvedValueOnce({ status: "skipped" });

    const result = await processRfpApproval("synthetic-token-70", {}, "approver@example.test");

    expect(result).toEqual({ success: true });
    expect(storage.updateRfpApprovalRequest).toHaveBeenCalledWith(70, expect.objectContaining({ status: "approved" }), { expectedStatus: "pending" });
    expect(raiseRfpCoreAlert).toHaveBeenCalledWith("service_handoff_skipped", expect.objectContaining({ requestId: 70, sourceDealId: DEAL }));
    // Core never confirmed a card, so the CRM is not told 'approved' (it waits on the re-drive).
    expect(enqueueRfpApprovedCallbackIfCoreConfirmed).not.toHaveBeenCalled();
    const html = String((vi.mocked(sendEmail).mock.calls.at(-1)?.[0] as any)?.htmlBody ?? "");
    expect(html).toContain("NOT handed to Core: re-drive needed");
    expect(html).not.toContain("Handed to Core; the CRM is told");
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
  });

  it.each(["failed", "dead"] as const)("CodeRabbit on #136: a REFUSED Core handoff (%s) stays approved and the email says it was NOT handed to Core", async (status) => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest() as any);
    vi.mocked(handOffServiceRfpApprovalToCore).mockResolvedValueOnce({ status });

    const result = await processRfpApproval("synthetic-token-70", {}, "approver@example.test");

    expect(result).toEqual({ success: true });
    expect(storage.updateRfpApprovalRequest).toHaveBeenCalledWith(70, expect.objectContaining({ status: "approved" }), { expectedStatus: "pending" });
    // The refusal's own delivery alert has already fired in the outbox; no second alert, and no CRM 'approved'.
    expect(raiseRfpCoreAlert).not.toHaveBeenCalled();
    expect(enqueueRfpApprovedCallbackIfCoreConfirmed).not.toHaveBeenCalled();
    const html = String((vi.mocked(sendEmail).mock.calls.at(-1)?.[0] as any)?.htmlBody ?? "");
    expect(html).toContain("NOT handed to Core: Core refused the job — correct the deal, then re-drive");
    expect(html).not.toContain("Handed to Core; the CRM is told");
  });

  it("keeps the estimator the approver selected: recorded on the request and handed to Core with the job", async () => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest() as any);

    const result = await processRfpApproval("synthetic-token-70", { estimator: "Synthetic Estimator" }, "approver@example.test");

    expect(result).toEqual({ success: true });
    const written = vi.mocked(storage.updateRfpApprovalRequest).mock.calls.at(-1)?.[1] as any;
    expect(written.editedFields).toEqual({ estimator: "Synthetic Estimator" });
    const handed = vi.mocked(handOffServiceRfpApprovalToCore).mock.calls.at(-1)?.[0] as any;
    expect(handed.editedFieldsOverride.estimator).toBe("Synthetic Estimator");
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
  });

  it("a NON-service approval by link has no Core route: approved, the CRM is told it FAILED and why, no Procore create", async () => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(
      crmRequest({ projectNumber: "DFW-2-70071-aa", dealData: { dealname: "Synthetic Non-Service RFP", project_number: "DFW-2-70071-aa", project_types: "2" } }) as any,
    );

    const result = await processRfpApproval("synthetic-token-71", {}, "approver@example.test");

    expect(result).toEqual({ success: true });
    expect(handOffServiceRfpApprovalToCore).not.toHaveBeenCalled();
    expect(enqueueRfpApprovedCallbackIfCoreConfirmed).not.toHaveBeenCalled();
    const callback = vi.mocked(storage.enqueueBidboardCallback).mock.calls.at(-1)?.[0] as any;
    expect(callback.rfpApprovalRequestId).toBe(70);
    expect(callback.payload.status).toBe("failed");
    expect(callback.payload.error).toMatch(/no T-Rock Core route/);
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
  });

  it("a resolver replay (resume) of a request stuck `approving` has nothing left to create: refused, nothing written", async () => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest({ status: "approving" }) as any);

    const result = await processRfpApproval("synthetic-token-70", {}, "resolver@example.test", undefined, { requestId: 70 });

    expect(result).toEqual({ success: false, error: PROCORE_CREATE_RETIRED_ERROR });
    expect(storage.updateRfpApprovalRequest).not.toHaveBeenCalled();
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
  });

  it("a request changed between the read and the write (a concurrent decline) is not approved twice: 409, Core gets no job, the CRM is not told", async () => {
    vi.mocked(storage.getRfpApprovalRequestByToken).mockResolvedValue(crmRequest() as any);
    vi.mocked(storage.updateRfpApprovalRequest).mockResolvedValue(undefined as any);

    const result = await processRfpApproval("synthetic-token-70", {}, "approver@example.test");

    expect(result).toMatchObject({ success: false, statusCode: 409 });
    // The decline race (CodeRabbit on #136): the conditional approval is written BEFORE the Core handoff, so a decline that
    // won the row stops the approval before Core is told anything.
    expect(handOffServiceRfpApprovalToCore).not.toHaveBeenCalled();
    expect(enqueueRfpApprovedCallbackIfCoreConfirmed).not.toHaveBeenCalled();
    expect(vi.mocked(createBidBoardProjectFromDeal).mock.calls.length).toBe(0);
  });
});
