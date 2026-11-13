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

// S0b-2a: processRfpApproval's P3 claim (per-deal lock + Core footprint, CONTRACT v2.2 §10) runs on a real database with
// 0027 applied (tests/rfp-approving-claim.pg.test.ts, tests/rfp-approval-p3.pg.test.ts). This file's database is a stub, so
// the claim reports 0027 absent ("legacy") and today's path runs, exactly as on a database without 0027.
vi.mock("../server/sync/rfp-approving.ts", () => ({
  RFP_APPROVING_STATUS: "approving",
  claimRfpRequestForCreate: vi.fn(async () => ({ outcome: "legacy" })),
  markRfpApprovingSubmitted: vi.fn(async () => {}),
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => approvalRequest.current),
    getRfpApprovalRequestById: vi.fn(async () => approvalRequest.current),
    getRfpApprovalRequestByProjectNumberAndStatus: vi.fn(async () => undefined),
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
    process.env.RFP_REQUEST_SYNC_SECRET = "synthetic-rfp-request-sync-secret-0123456789"; // ≥ 32 bytes (SIGNING-HARDENING r1)
    approvalRequest.current = makeDeclinedRequest();
    // Eligibility check (trock_crm) → opportunity stage so the override proceeds.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ stage: "opportunity" }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  // Procore project creation is retired (owner 2026-11-13, b0cb0c4f): an override approves the request and hands a SERVICE job to Core;
  // the CRM is told 'approved' once Core confirms the card (rfp-approved-callback.ts, through the outbox, not this storage mock).
  it("force-approves a declined CRM service RFP: approved with the reviewer's email, the decline cleared, NO Procore create", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result).toEqual({ success: true });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    // Named accountability: the reviewer's real email is recorded as the approver, and the prior
    // decline is cleared (no approved + rejected decision for the same request).
    expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com", bidboardProjectId: null });
    expect(approvalRequest.current.declinedBy).toBeNull();
    expect(approvalRequest.current.declinedAt).toBeNull();
    // No 'created' (nothing was created in Procore); the CRM's 'approved' follows Core's confirmation.
    expect(callbackRows).toHaveLength(0);
  });

  it("force-approves a declined NON-service RFP: approved, and the CRM is told it FAILED because it has no Core route (no Procore create)", async () => {
    approvalRequest.current = makeDeclinedRequest({
      projectNumber: "DFW-2-12345-aa",
      dealData: { dealname: "CRM RFP", project_number: "DFW-2-12345-aa", project_types: "2", workflow_route: "normal" },
    });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result).toEqual({ success: true });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com" });
    expect(callbackRows).toHaveLength(1);
    expect(callbackRows[0].targetUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
    expect(callbackRows[0].payload).toMatchObject({ status: "failed", rfpApprovalRequestId: 77, sourceDealId: "crm-deal-1" });
    expect(callbackRows[0].payload.error).toMatch(/no T-Rock Core route/);
  });

  it("without force, a declined request is rejected and never creates a project (regression guard)", async () => {
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", {});

    expect(result).toEqual({ success: false, error: "Request already declined" });
    expect(createBidBoardMock).not.toHaveBeenCalled();
    expect(callbackRows).toHaveLength(0);
  });

  it("force aborts (no second create) when the claimed request was already resolved with a project id", async () => {
    // Between the 202 and processRfpApproval's re-read, the row could be approved manually (gaining a
    // project id). The force path must not blindly create — it aborts.
    approvalRequest.current = makeDeclinedRequest({ status: "override_approving", bidboardProjectId: "BB-EXISTING" });
    const { processRfpApproval } = await import("../server/rfp-approval.ts");

    const result = await processRfpApproval("token-1", {}, "ashaw@trockgc.com", { force: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already resolved/i);
    expect(createBidBoardMock).not.toHaveBeenCalled();
  });

  it("end-to-end: a signed override request drives the REAL processRfpApproval: approved by the reviewer, NO Procore create", async () => {
    // Wire the real HTTP route to the real processRfpApproval (only storage/playwright are mocked).
    const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
    const app = express();
    registerRfpRequestRoutes(app);
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const port = (server.address() as any).port;
      const status = await postOverrideViaRoute(port);

      expect(status).toBe(202);
      await vi.waitFor(() => expect(approvalRequest.current).toMatchObject({ status: "approved", approvedBy: "ashaw@trockgc.com" }));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      expect(callbackRows).toHaveLength(0);
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
