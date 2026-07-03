import crypto from "crypto";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE (adaptation): the plan's spec used supertest, but this repo has no supertest dependency —
// sibling tests (tests/rfp-requests-endpoint.test.ts) drive the app via app.listen(0) + fetch. This
// test mirrors that convention. Assertions + mocks are otherwise identical to the plan.

const createBidBoardMock = vi.hoisted(() => vi.fn(async () => ({ success: true, projectId: "999" })));
const callbackFetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));

vi.mock("../server/playwright/bidboard.ts", () => ({
  createBidBoardProjectFromDeal: createBidBoardMock,
}));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({
  buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.com/api/internal/bid-board-created",
}));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({
  fetchWithTimeout: callbackFetchMock,
}));
vi.mock("../server/storage.ts", () => ({
  storage: { getAutomationConfig: vi.fn(async () => ({ value: { companyId: "42" } })) },
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
    callbackFetchMock.mockClear();
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
      expect(callbackFetchMock).not.toHaveBeenCalled();
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

      await vi.waitFor(() => expect(callbackFetchMock).toHaveBeenCalledTimes(1));

      expect(createBidBoardMock).toHaveBeenCalledTimes(1);
      const createArgs = createBidBoardMock.mock.calls[0][0] as any;
      expect(createArgs.sourceSystem).toBe("trock_crm");
      expect(createArgs.sourceDealId).toBe("crm-deal-1");
      expect(createArgs.normalizedDealData.project_number).toBe("TR-1001");
      expect(createArgs.normalizedDealData.company_name).toBe("Acme");

      const [cbUrl, cbInit] = callbackFetchMock.mock.calls[0] as any[];
      expect(cbUrl).toBe("https://crm.example.com/api/internal/bid-board-created");
      const cbBody = JSON.parse(cbInit.body);
      expect(cbBody.status).toBe("created");
      expect(cbBody.sourceDealId).toBe("crm-deal-1");
      expect(cbBody.bidboardProjectId).toBe("999");
      expect(cbBody.procoreCompanyId).toBe("42");
      expect(cbBody.rfpApprovalRequestId).toBeUndefined();
      expect(cbInit.headers["x-rfp-request-signature"]).toBe(sign(cbInit.body));
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

      await vi.waitFor(() => expect(callbackFetchMock).toHaveBeenCalledTimes(1));
      const [, cbInit] = callbackFetchMock.mock.calls[0] as any[];
      const cbBody = JSON.parse(cbInit.body);
      expect(cbBody.status).toBe("failed");
      expect(cbBody.sourceDealId).toBe("crm-deal-1");
      expect(cbBody.projectNumber).toBe("TR-1001");
      expect(cbBody.error).toContain("playwright boom");
      expect(cbBody.bidboardProjectId).toBeUndefined();
      expect(cbInit.headers["x-rfp-request-signature"]).toBe(sign(cbInit.body));
    });
  });
});
