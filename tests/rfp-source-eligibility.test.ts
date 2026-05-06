import { beforeEach, describe, expect, it, vi } from "vitest";

const requestRow = vi.hoisted(() => ({ current: undefined as any }));
const auditRows = vi.hoisted(() => [] as any[]);
const updateRows = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "BB-1" })));
const hubspotFetchMode = vi.hoisted(() => ({ stage: "RFP", missing: false }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => requestRow.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => {
      updateRows.push(data);
      requestRow.current = { ...requestRow.current, ...data };
      return requestRow.current;
    }),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(async () => ({
    crm: {
      deals: {
        basicApi: {
          getById: vi.fn(async () => {
            if (hubspotFetchMode.missing) {
              const error: any = new Error("not found");
              error.code = 404;
              error.statusCode = 404;
              throw error;
            }
            return {
              properties: {
                dealname: "HubSpot Deal",
                project_number: "DFW-2-10001",
                project_types: "2",
                dealstage: hubspotFetchMode.stage,
              },
              associations: {},
            };
          }),
        },
      },
    },
  })),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Owner", ownerEmail: "owner@trockgc.com" })),
  updateHubSpotDeal: vi.fn(async () => ({ success: true })),
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));

vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: vi.fn(async () => ({ ok: false })),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(async () => ({ stageId: "stage-1", stageName: "Estimating" })),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));

function makeRequest(overrides: Partial<any> = {}) {
  return {
    id: 10,
    token: "token-1",
    status: "pending",
    sourceSystem: "hubspot",
    sourceDealId: "hs-1",
    hubspotDealId: "hs-1",
    projectNumber: "DFW-2-10001",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    dealData: {
      dealname: "Source Deal",
      project_number: "DFW-2-10001",
      project_types: "2",
      dealstage: "RFP",
      proposalId: "P-1",
    },
    ...overrides,
  };
}

describe("RFP source eligibility check", () => {
  beforeEach(() => {
    vi.resetModules();
    auditRows.length = 0;
    updateRows.length = 0;
    sendEmailMock.mockClear();
    createBidBoardMock.mockClear();
    hubspotFetchMode.stage = "RFP";
    hubspotFetchMode.missing = false;
    requestRow.current = makeRequest();
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    process.env.RFP_REQUEST_SYNC_SECRET = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "opportunity" }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("proceeds when the HubSpot deal exists and remains RFP eligible", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
  });

  it("cancels when the HubSpot deal was deleted", async () => {
    hubspotFetchMode.missing = true;
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(updateRows[0]).toMatchObject({ status: "cancelled_source_ineligible" });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "approver@trockgc.com",
      subject: "RFP approval cancelled — source deal no longer eligible",
    }));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rfp_approval_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "cancelled_source_ineligible" }),
      }),
    ]));
  });

  it("cancels when the HubSpot deal moved out of an eligible stage", async () => {
    hubspotFetchMode.stage = "closedlost";
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("proceeds when the CRM deal exists and remains opportunity", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://crm.example.com/api/internal/deals/eligibility-check",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-rfp-request-signature": expect.stringMatching(/^sha256=/),
        }),
        body: JSON.stringify({ sourceDealId: "crm-1" }),
      })
    );
  });

  it("cancels when the CRM deal was deleted", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("cancels when the CRM stage changed", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "lost" }), { status: 200, headers: { "content-type": "application/json" } })));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: false, error: "source_ineligible", statusCode: 409 });
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("proceeds on CRM network errors because eligibility is a fail-open safety guard", async () => {
    requestRow.current = makeRequest({ sourceSystem: "trock_crm", sourceDealId: "crm-1", hubspotDealId: null });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-1" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
  });
});
