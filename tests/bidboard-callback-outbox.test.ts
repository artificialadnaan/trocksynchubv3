import { beforeEach, describe, expect, it, vi } from "vitest";

const dbExecuteMock = vi.hoisted(() => vi.fn());
const approvalRequest = vi.hoisted(() => ({ current: undefined as any }));
const callbackRows = vi.hoisted(() => [] as any[]);
const updateRows = vi.hoisted(() => [] as any[]);
const auditRows = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "BB-123" })));

vi.mock("../server/db.ts", () => ({
  db: { execute: dbExecuteMock },
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => approvalRequest.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => {
      updateRows.push(data);
      approvalRequest.current = { ...approvalRequest.current, ...data };
      return approvalRequest.current;
    }),
    approveRfpApprovalRequestWithOptionalCallback: vi.fn(async (_id: number, data: any, callback: any) => {
      updateRows.push(data);
      approvalRequest.current = { ...approvalRequest.current, ...data };
      if (callback && !callbackRows.some((row) => row.rfpApprovalRequestId === callback.rfpApprovalRequestId)) {
        callbackRows.push(callback);
      }
      return approvalRequest.current;
    }),
    enqueueBidboardCallback: vi.fn(async (row: any) => {
      callbackRows.push(row);
      return { id: callbackRows.length, ...row };
    }),
    createRfpApprovalEdit: vi.fn(async (row: any) => ({ id: 1, ...row })),
    getAutomationConfig: vi.fn(async (key: string) => {
      if (key === "procore_config") return { value: { companyId: "598134325683880" } };
      return null;
    }),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(async () => "token"),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "Owner", ownerEmail: "owner@example.com" })),
  updateHubSpotDeal: vi.fn(async () => ({ success: true })),
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));

vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: vi.fn(async () => new Response("", { status: 200 })),
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
    id: 77,
    token: "token-1",
    status: "pending",
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    hubspotDealId: null,
    projectNumber: "DFW-4-12345-aa",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    dealData: {
      dealname: "CRM RFP",
      project_number: "DFW-4-12345-aa",
      project_types: "4",
      workflow_route: "normal",
    },
    ...overrides,
  };
}

describe("BidBoard callback outbox worker", () => {
  beforeEach(() => {
    vi.resetModules();
    dbExecuteMock.mockReset();
    process.env.RFP_REQUEST_SYNC_SECRET = "secret";
  });

  it("posts a pending callback and marks it sent", async () => {
    dbExecuteMock
      .mockResolvedValueOnce([{ id: 1, attempt_count: 1, max_attempts: 5, payload: { sourceDealId: "crm-deal-1" }, target_url: "https://crm.example.com/api/internal/bid-board-created", rfp_approval_request_id: 77 }])
      .mockResolvedValue({ rows: [] });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");

    const result = await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: "secret" });

    expect(result).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://crm.example.com/api/internal/bid-board-created",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-rfp-request-signature": expect.stringMatching(/^sha256=/) }),
      })
    );
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain("status = 'sent'");
  });

  it("retries a transient 503 and then marks sent on the next tick", async () => {
    dbExecuteMock
      .mockResolvedValueOnce([{ id: 1, attempt_count: 1, max_attempts: 5, payload: { sourceDealId: "crm-deal-1" }, target_url: "https://crm.example.com/api/internal/bid-board-created", rfp_approval_request_id: 77 }])
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce([{ id: 1, attempt_count: 2, max_attempts: 5, payload: { sourceDealId: "crm-deal-1" }, target_url: "https://crm.example.com/api/internal/bid-board-created", rfp_approval_request_id: 77 }])
      .mockResolvedValue({ rows: [] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");

    await expect(processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: "secret" })).resolves.toMatchObject({ sent: 0, failed: 1 });
    await expect(processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: "secret" })).resolves.toMatchObject({ sent: 1, failed: 0 });

    const sqlText = JSON.stringify(dbExecuteMock.mock.calls);
    expect(sqlText).toContain("status = 'pending'");
    expect(sqlText).toContain("status = 'sent'");
  });

  it("marks the callback dead after the fifth failed attempt", async () => {
    dbExecuteMock
      .mockResolvedValueOnce([{ id: 1, attempt_count: 5, max_attempts: 5, payload: { sourceDealId: "crm-deal-1" }, target_url: "https://crm.example.com/api/internal/bid-board-created", rfp_approval_request_id: 77 }])
      .mockResolvedValue({ rows: [] });
    const fetchMock = vi.fn(async () => new Response("bad secret", { status: 401 }));
    const { processBidBoardCallbackOutbox } = await import("../server/sync/bidboard-callback-worker.ts");

    const result = await processBidBoardCallbackOutbox({ fetchImpl: fetchMock as any, secret: "secret" });

    expect(result).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    expect(JSON.stringify(dbExecuteMock.mock.calls)).toContain("status = 'dead'");
  });
});

describe("CRM-sourced RFP approval callback enqueue", () => {
  beforeEach(() => {
    vi.resetModules();
    callbackRows.length = 0;
    updateRows.length = 0;
    auditRows.length = 0;
    sendEmailMock.mockClear();
    createBidBoardMock.mockClear();
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    process.env.RFP_REQUEST_SYNC_SECRET = "secret";
    approvalRequest.current = makeRequest();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "opportunity" }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("enqueues one callback when a CRM-sourced RFP creates a BidBoard project", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0]).toMatchObject({
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-1",
      rfpApprovalRequestId: 77,
      targetUrl: "https://crm.example.com/api/internal/bid-board-created",
      status: "pending",
      maxAttempts: 5,
    });
    expect(callbackRows[0].payload).toMatchObject({
      sourceDealId: "crm-deal-1",
      rfpApprovalRequestId: 77,
      bidboardProjectId: "BB-123",
      projectNumber: "DFW-4-12345-aa",
      procoreCompanyId: "598134325683880",
    });
  });

  it("does not enqueue a callback for HubSpot-sourced approvals", async () => {
    approvalRequest.current = makeRequest({ sourceSystem: "hubspot", sourceDealId: "hs-1", hubspotDealId: "hs-1" });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-123" });
    expect(callbackRows).toHaveLength(0);
  });

  it("does not enqueue duplicate callbacks when the storage transaction handles the same approval twice", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });
    approvalRequest.current = { ...approvalRequest.current, status: "pending" };
    await processRfpApproval("token-1", {}, "approver@trockgc.com", { attachmentsOverride: [], newFiles: [] });

    const uniqueByRequest = new Map(callbackRows.map((row) => [row.rfpApprovalRequestId, row]));
    expect(uniqueByRequest.size).toBe(1);
  });
});
