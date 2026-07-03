import crypto from "crypto";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE (adaptation): the plan's spec used supertest, but this repo has no supertest dependency —
// sibling tests (tests/rfp-requests-endpoint.test.ts) drive the app via app.listen(0) + fetch. This
// test mirrors that convention. Assertions + mocks are otherwise identical to the plan.

const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "999" })));
// finding S2: callbacks are now enqueued into the durable outbox (storage.enqueueBidboardCallback), not
// delivered in-memory. This mock captures the enqueued rows so tests assert on the persisted payload.
const enqueueBidboardCallbackMock = vi.hoisted(() => vi.fn(async () => ({ id: 1 })));
// finding S1: a per-deal advisory lock; default returns a release fn (acquired). The S1 test overrides it to
// null (another handler holds it) to assert the duplicate is skipped.
const acquireLockMock = vi.hoisted(() => vi.fn(async () => (async () => {}) as (() => Promise<void>) | null));
// finding T3: pre-create CRM eligibility recheck; default eligible.
const checkEligibilityMock = vi.hoisted(() => vi.fn(async () => ({ eligible: true }) as any));
// Default to "no collision" / "no conflicting owner"; individual tests override with mockResolvedValueOnce.
const getRfpByProjectNumberAndStatusMock = vi.hoisted(() => vi.fn(async (_projectNumber: string, _status: string) => undefined as any));
const getRfpBySourceDealAndStatusMock = vi.hoisted(() => vi.fn(async (_ss: string, _sd: string, _status: string) => undefined as any));
const getBidboardMappingByProcoreProjectNumberMock = vi.hoisted(() => vi.fn(async (_projectNumber: string) => undefined as any));

// The last callback payload enqueued into the durable outbox.
const lastCallbackPayload = () => (enqueueBidboardCallbackMock.mock.calls.at(-1)?.[0] as any)?.payload;

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.com/api/internal/bid-board-created",
}));
vi.mock("../server/rfp-approval.ts", () => ({
  createRfpApprovalRequestFromNormalizedInput: vi.fn(),
  processRfpApproval: vi.fn(),
  checkRfpApprovalSourceEligibility: checkEligibilityMock,
}));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })),
    getRfpApprovalRequestByProjectNumberAndStatus: getRfpByProjectNumberAndStatusMock,
    getRfpApprovalRequestBySourceDealAndStatus: getRfpBySourceDealAndStatusMock,
    getBidboardMappingByProcoreProjectNumber: getBidboardMappingByProcoreProjectNumberMock,
    enqueueBidboardCallback: enqueueBidboardCallbackMock,
    acquireCreateFromRfpLock: acquireLockMock,
  },
}));

// Cut the rfp-requests -> rfp-approval -> {hubspot,email-service,procore-hubspot-sync,index} -> db.ts
// import chain (db.ts throws without DATABASE_URL). Mirrors tests/rfp-requests-endpoint.test.ts.
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/email-service.ts", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  renderTemplate: vi.fn(),
}));
vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
}));
vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

const SECRET = "rfp-secret";

function requestBody(overrides: Partial<any> = {}) {
  return {
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    sourceEventId: "crm:rfp-vote:approved:round-1",
    decision: "approved",
    deal: {
      name: "jasonn ranches",
      projectNumber: "TR-1001",
      projectType: "9",
      amount: 100000,
      estimator: null,
      companyName: "Acme",
      contactName: "Jane",
      clientEmail: "jane@acme.com",
      clientPhone: null,
      address: { street: "1 Main", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null,
      dueDate: null,
      workflowRoute: "normal",
    },
    attachments: [],
    ...overrides,
  };
}

function sign(body: string) {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
  const app = express();
  registerRfpRequestRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as any).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("POST /api/bid-board/create-from-rfp", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RFP_REQUEST_SYNC_SECRET = SECRET;
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    createBidBoardMock.mockClear();
    enqueueBidboardCallbackMock.mockClear();
    acquireLockMock.mockReset();
    acquireLockMock.mockResolvedValue((async () => {}) as any);
    checkEligibilityMock.mockReset();
    checkEligibilityMock.mockResolvedValue({ eligible: true } as any);
    getRfpByProjectNumberAndStatusMock.mockReset();
    getRfpByProjectNumberAndStatusMock.mockResolvedValue(undefined);
    getRfpBySourceDealAndStatusMock.mockReset();
    getRfpBySourceDealAndStatusMock.mockResolvedValue(undefined);
    getBidboardMappingByProcoreProjectNumberMock.mockReset();
    getBidboardMappingByProcoreProjectNumberMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    delete process.env.TROCK_CRM_BASE_URL;
  });

  it("409 (and does NOT create) when sourceSystem is not trock_crm", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody({ sourceSystem: "hubspot" }));
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Conflict");
      // No create, no callback — the endpoint rejected before the 202/setImmediate.
      await new Promise((r) => setTimeout(r, 20));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled();
    });
  });

  it("401 on a bad signature", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": "sha256=deadbeef" },
        body: raw,
      });
      expect(res.status).toBe(401);
    });
  });

  it("202, creates the project, and POSTs a 'created' callback keyed by sourceDealId (no rfpApprovalRequestId)", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);

      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));

      expect(createBidBoardMock).toHaveBeenCalledTimes(1);
      const createArgs = createBidBoardMock.mock.calls[0][0] as any;
      expect(createArgs.sourceSystem).toBe("trock_crm");
      expect(createArgs.sourceDealId).toBe("crm-deal-1");
      expect(createArgs.normalizedDealData.project_number).toBe("TR-1001");
      expect(createArgs.normalizedDealData.company_name).toBe("Acme");

      const enqueued = enqueueBidboardCallbackMock.mock.calls[0][0] as any;
      expect(enqueued.targetUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
      // Voting row: NULL rfpApprovalRequestId (keyed by sourceDealId); the worker signs + delivers it durably.
      expect(enqueued.rfpApprovalRequestId).toBeNull();
      expect(enqueued.sourceDealId).toBe("crm-deal-1");
      const cbBody = enqueued.payload;
      expect(cbBody.status).toBe("created");
      expect(cbBody.sourceDealId).toBe("crm-deal-1");
      expect(cbBody.bidboardProjectId).toBe("999");
      expect(cbBody.procoreCompanyId).toBe("42");
      expect(cbBody.rfpApprovalRequestId).toBeUndefined();
    });
  });

  it("delivers a 'failed' callback (not 'created') when the project number is owned by another deal", async () => {
    getBidboardMappingByProcoreProjectNumberMock.mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "some-other-deal",
      bidboardProjectId: "777",
    });
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);

      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      // Refused to adopt: no create ran, and the callback is 'failed' (not 'created' pointing at 777).
      expect(createBidBoardMock).not.toHaveBeenCalled();
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.sourceDealId).toBe("crm-deal-1");
      expect(cbBody.bidboardProjectId).toBeUndefined();
      expect(cbBody.error).toContain("some-other-deal");
    });
  });

  it("allows the idempotent retry: an existing mapping for THIS deal falls through to create/adopt", async () => {
    getBidboardMappingByProcoreProjectNumberMock.mockResolvedValue({
      sourceSystem: "trock_crm",
      sourceDealId: "crm-deal-1",
      bidboardProjectId: "999",
    });
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(createBidBoardMock).toHaveBeenCalledTimes(1);
      expect(lastCallbackPayload().status).toBe("created");
    });
  });

  it("delivers a 'failed' callback (not 'created') when an RFP approval is already in flight for the project number", async () => {
    getRfpByProjectNumberAndStatusMock.mockImplementation(async (_projectNumber: string, status: string) =>
      status === "pending" ? { id: 55, status: "pending" } : undefined
    );
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);

      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.error).toContain("conflicting RFP approval");
    });
  });

  it("[S3] delivers a 'failed' callback when an APPROVED RFP row exists for the project number (stale/missing mapping)", async () => {
    // An earlier email/override approval is 'approved' but its sync_mappings row is missing/stale. A vote
    // command for a different deal on the same number must stop for manual resolution, not adopt/create.
    getRfpByProjectNumberAndStatusMock.mockImplementation(async (_projectNumber: string, status: string) =>
      status === "approved" ? { id: 77, status: "approved" } : undefined
    );
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.error).toContain("conflicting RFP approval");
    });
  });

  it("[S4] delivers a 'failed' callback when the SAME source deal has an in-flight approval (revised project number)", async () => {
    // The project-number check would miss it (the in-flight row carries a revised number), but the same deal
    // already has a 'pending' approval flow — two flows for one deal must not both run.
    getRfpBySourceDealAndStatusMock.mockImplementation(async (_ss: string, _sd: string, status: string) =>
      status === "pending" ? { id: 88, status: "pending" } : undefined
    );
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.error).toContain("conflicting RFP approval");
      expect(getRfpBySourceDealAndStatusMock).toHaveBeenCalledWith("trock_crm", "crm-deal-1", "pending");
    });
  });

  it("delivers a 'failed' callback (not silence) when creation THROWS", async () => {
    createBidBoardMock.mockRejectedValueOnce(new Error("playwright boom"));
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202);

      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.sourceDealId).toBe("crm-deal-1");
      expect(cbBody.projectNumber).toBe("TR-1001");
      expect(cbBody.error).toContain("playwright boom");
      expect(cbBody.bidboardProjectId).toBeUndefined();
    });
  });

  it("[S1] skips (no create, no callback) when the per-deal advisory lock is already held by another handler", async () => {
    // A concurrent duplicate delivery: another handler/instance holds the lock, so acquire returns null.
    acquireLockMock.mockResolvedValueOnce(null as any);
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) },
        body: raw,
      });
      expect(res.status).toBe(202); // still ACKed; the OTHER holder does the work
      await new Promise((r) => setTimeout(r, 30));
      expect(createBidBoardMock).not.toHaveBeenCalled();
      expect(enqueueBidboardCallbackMock).not.toHaveBeenCalled();
    });
  });

  it("[S1] releases the lock after the create (so a subsequent delivery can acquire it)", async () => {
    const release = vi.fn(async () => {});
    acquireLockMock.mockResolvedValueOnce(release as any);
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("[T3] delivers a 'failed' callback and does NOT create when the CRM deal is no longer eligible", async () => {
    // A delayed/retried delivery for a deal the CRM has since deleted or moved out of Opportunity.
    checkEligibilityMock.mockResolvedValueOnce({ eligible: false, reason: "Source CRM deal is no longer in Opportunity stage" } as any);
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(enqueueBidboardCallbackMock).toHaveBeenCalledTimes(1));
      expect(createBidBoardMock).not.toHaveBeenCalled(); // no BidBoard project for an ineligible deal
      expect(acquireLockMock).not.toHaveBeenCalled(); // eligibility is checked before the lock/create
      const cbBody = lastCallbackPayload();
      expect(cbBody.status).toBe("failed");
      expect(cbBody.error).toContain("no longer in Opportunity");
    });
  });
});
