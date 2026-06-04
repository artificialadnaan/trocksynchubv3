import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import crypto from "crypto";
import http from "http";

// CORE behavior of the override-approve path: processRfpApproval(token, {}, email, { force: true }).
// Mirrors tests/bidboard-callback-outbox.test.ts (real processRfpApproval + full mocks), adding
// upsertBidboardCallback and the force-aware approve callback to the storage mock.

const approvalRequest = vi.hoisted(() => ({ current: undefined as any }));
const callbackRows = vi.hoisted(() => [] as any[]);
const updateRows = vi.hoisted(() => [] as any[]);
const auditRows = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "BB-123" })));

// Simulate the unique-per-request outbox: an upsert replaces the existing row for the request.
const upsertCallbackRow = (row: any) => {
  const idx = callbackRows.findIndex((r) => r.rfpApprovalRequestId === row.rfpApprovalRequestId);
  if (idx >= 0) callbackRows[idx] = row;
  else callbackRows.push(row);
};

vi.mock("../server/db.ts", () => ({ db: { execute: vi.fn() } }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => approvalRequest.current),
    getRfpApprovalRequestById: vi.fn(async () => approvalRequest.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => {
      updateRows.push(data);
      approvalRequest.current = { ...approvalRequest.current, ...data };
      return approvalRequest.current;
    }),
    approveRfpApprovalRequestWithOptionalCallback: vi.fn(async (_id: number, data: any, callback: any, opts?: any) => {
      updateRows.push(data);
      approvalRequest.current = { ...approvalRequest.current, ...data };
      if (callback) {
        if (opts?.upsertCallback) upsertCallbackRow(callback);
        else if (!callbackRows.some((row) => row.rfpApprovalRequestId === callback.rfpApprovalRequestId)) callbackRows.push(callback);
      }
      return approvalRequest.current;
    }),
    upsertBidboardCallback: vi.fn(async (row: any) => {
      upsertCallbackRow(row);
      return { id: callbackRows.length, ...row };
    }),
    enqueueBidboardCallback: vi.fn(async (row: any) => {
      callbackRows.push(row);
      return { id: callbackRows.length, ...row };
    }),
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

vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));

function makeDeclinedRequest(overrides: Partial<any> = {}) {
  return {
    id: 77,
    token: "token-1",
    status: "declined",
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    hubspotDealId: null,
    projectNumber: "DFW-4-12345-aa",
    bidboardProjectId: null,
    declinedBy: "reviewer@trockgc.com",
    declinedAt: new Date(Date.now() - 60_000),
    tokenExpiresAt: new Date(Date.now() - 60_000), // already past — force must bypass expiry
    dealData: {
      dealname: "CRM RFP",
      project_number: "DFW-4-12345-aa",
      project_types: "4",
      workflow_route: "normal",
    },
    ...overrides,
  };
}

describe("processRfpApproval — override (force) path", () => {
  beforeEach(() => {
    vi.resetModules();
    callbackRows.length = 0;
    updateRows.length = 0;
    auditRows.length = 0;
    sendEmailMock.mockClear();
    createBidBoardMock.mockReset();
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "BB-123" });
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    process.env.RFP_REQUEST_SYNC_SECRET = "secret";
    approvalRequest.current = makeDeclinedRequest();
    // Eligibility check (trock_crm) → opportunity stage so the override proceeds.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "opportunity" }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("force-approves a declined CRM RFP: creates the project, marks approved with the reviewer's email, enqueues a 'created' callback", async () => {
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "BB-777" });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result).toMatchObject({ success: true, bidboardProjectId: "BB-777" });
    expect(createBidBoardMock).toHaveBeenCalledTimes(1);
    // Named accountability: the reviewer's real email is recorded as the approver.
    expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com", bidboardProjectId: "BB-777" });
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0].targetUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
    expect(callbackRows[0].payload).toMatchObject({ status: "created", bidboardProjectId: "BB-777", rfpApprovalRequestId: 77, sourceDealId: "crm-deal-1" });
  });

  it("without force, a declined request is rejected and never creates a project (regression guard)", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", {});

    expect(result).toEqual({ success: false, error: "Request already declined" });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(callbackRows).toHaveLength(0);
  });

  it("a Playwright failure in the override path does NOT mark approved and enqueues a 'failed' callback (re-tryable)", async () => {
    createBidBoardMock.mockResolvedValue({ success: false, error: "bid board unreachable" });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result.success).toBe(false);
    // CRITICAL: must NOT be marked approved — left re-tryable.
    expect(approvalRequest.current.status).toBe("declined");
    expect(updateRows.some((row) => row.status === "approved")).toBe(false);
    // A 'failed' callback is emitted to the same CRM URL.
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0].targetUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
    expect(callbackRows[0].payload).toMatchObject({ status: "failed", rfpApprovalRequestId: 77, sourceDealId: "crm-deal-1" });
    expect(callbackRows[0].payload.error).toContain("bid board unreachable");
    expect(callbackRows[0].payload.bidboardProjectId).toBeUndefined();
  });

  it("a retry after a failure supersedes the prior 'failed' callback with a 'created' one", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    createBidBoardMock.mockResolvedValueOnce({ success: false, error: "transient" });
    await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0].payload.status).toBe("failed");

    createBidBoardMock.mockResolvedValueOnce({ success: true, projectId: "BB-999" });
    await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    // The unique-per-request outbox row is replaced, not duplicated.
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0].payload).toMatchObject({ status: "created", bidboardProjectId: "BB-999" });
  });

  it("end-to-end: a signed override request drives the REAL processRfpApproval and enqueues a 'created' callback", async () => {
    // Wire the real HTTP route to the real processRfpApproval (only storage/playwright are mocked),
    // proving the route → core → 'created' callback path the endpoint test (which stubs the core) cannot.
    createBidBoardMock.mockResolvedValue({ success: true, projectId: "BB-INT" });
    const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
    const app = express();
    registerRfpRequestRoutes(app);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const port = (server.address() as any).port;
      const raw = JSON.stringify({ approverEmail: "ashaw@trockgc.com" });
      const sig = `sha256=${crypto.createHmac("sha256", process.env.RFP_REQUEST_SYNC_SECRET!).update(raw).digest("hex")}`;
      // Use the http module (not fetch) — global fetch is stubbed for the eligibility check.
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/rfp-requests/77/override-approve",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(raw),
              "x-rfp-request-signature": sig,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        req.on("error", reject);
        req.write(raw);
        req.end();
      });

      expect(status).toBe(202);
      await vi.waitFor(() => expect(callbackRows).toHaveLength(1));
      expect(callbackRows[0].payload).toMatchObject({ status: "created", bidboardProjectId: "BB-INT" });
      expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
