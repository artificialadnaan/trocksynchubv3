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

vi.mock("../server/db.ts", () => ({ db: { execute: vi.fn() } }));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => approvalRequest.current),
    getRfpApprovalRequestById: vi.fn(async () => approvalRequest.current),
    // Atomic claim: declined + no project → override_approving (NOT 'pending', so the email route
    // can't approve it), deleting any stale outbox row (mirrors the real UPDATE...RETURNING + DELETE).
    claimDeclinedRfpForOverride: vi.fn(async (id: number) => {
      const r = approvalRequest.current;
      if (r?.status === "declined" && !r?.bidboardProjectId) {
        approvalRequest.current = { ...r, status: "override_approving" };
        const idx = callbackRows.findIndex((row) => row.rfpApprovalRequestId === id);
        if (idx >= 0) callbackRows.splice(idx, 1);
        return approvalRequest.current;
      }
      return undefined;
    }),
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
    // onConflictDoNothing semantics: don't insert if a row already exists for the request.
    enqueueBidboardCallback: vi.fn(async (row: any) => {
      if (!callbackRows.some((r) => r.rfpApprovalRequestId === row.rfpApprovalRequestId)) callbackRows.push(row);
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
    // Named accountability: the reviewer's real email is recorded as the approver, and the prior
    // decline is cleared (no approved + rejected decision for the same request).
    expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com", bidboardProjectId: "BB-777" });
    expect(approvalRequest.current.declinedBy).toBeNull();
    expect(approvalRequest.current.declinedAt).toBeNull();
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

  it("a THROWN (indeterminate) Playwright error does NOT restore/retry and emits NO callback (a project may exist)", async () => {
    // createBidBoardProjectFromDeal does post-create work; a throw may arrive AFTER a project was
    // created, so the state is unknown — leave the request claimed and emit no callback (manual resolution).
    createBidBoardMock.mockRejectedValue(new Error("playwright crashed mid-create"));
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result.success).toBe(false);
    expect(callbackRows).toHaveLength(0); // no 'failed' (a project may exist) and no 'created'
    // No restore-to-declined and no flip-to-approved: the claim is left as-is for manual resolution.
    expect(updateRows.some((row) => row.status === "approved" || row.status === "declined")).toBe(false);
  });

  it("end-to-end via the route: a failed override then a successful retry ends with a single 'created' callback (claim supersedes the stale 'failed')", async () => {
    // Real route → real processRfpApproval (storage/playwright mocked). The route's atomic claim
    // deletes the stale 'failed' outbox row at the start of the retry, so the success enqueues a
    // fresh 'created' — proving the supersede now happens via the claim, not an in-place upsert.
    const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
    const app = express();
    registerRfpRequestRoutes(app);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const port = (server.address() as any).port;

      // Attempt 1 — Playwright fails → 'failed' callback, request released back to 'declined'.
      createBidBoardMock.mockResolvedValueOnce({ success: false, error: "transient" });
      await postOverrideViaRoute(port);
      await vi.waitFor(() => expect(callbackRows).toHaveLength(1));
      expect(callbackRows[0].payload.status).toBe("failed");
      await vi.waitFor(() => expect(approvalRequest.current.status).toBe("declined"));

      // Attempt 2 — Playwright succeeds → claim deletes the 'failed' row, 'created' enqueued.
      createBidBoardMock.mockResolvedValueOnce({ success: true, projectId: "BB-999" });
      await postOverrideViaRoute(port);
      await vi.waitFor(() => expect(approvalRequest.current.status).toBe("approved"));

      expect(callbackRows).toHaveLength(1);
      expect(callbackRows[0].payload).toMatchObject({ status: "created", bidboardProjectId: "BB-999" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      const status = await postOverrideViaRoute(port);

      expect(status).toBe(202);
      await vi.waitFor(() => expect(callbackRows).toHaveLength(1));
      expect(callbackRows[0].payload).toMatchObject({ status: "created", bidboardProjectId: "BB-INT" });
      expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// POST a signed override request via the http module (global fetch is stubbed for the eligibility check).
function postOverrideViaRoute(port: number): Promise<number> {
  const raw = JSON.stringify({ approverEmail: "ashaw@trockgc.com" });
  const sig = `sha256=${crypto.createHmac("sha256", process.env.RFP_REQUEST_SYNC_SECRET!).update(raw).digest("hex")}`;
  return new Promise<number>((resolve, reject) => {
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
}
