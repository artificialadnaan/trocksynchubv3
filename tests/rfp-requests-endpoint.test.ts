import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rfpRows = vi.hoisted(() => [] as any[]);
const emailLogs = vi.hoisted(() => [] as any[]);
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const raceBypassPendingLookups = vi.hoisted(() => ({ count: 0 }));
const makeRow = vi.hoisted(() => (overrides: Partial<any>) => {
  return {
    id: rfpRows.length + 1,
    sourceSystem: "trock_crm",
    sourceDealId: `deal-${rfpRows.length + 1}`,
    sourceEventId: `event-${rfpRows.length + 1}`,
    projectNumber: `PN-${rfpRows.length + 1}`,
    hubspotDealId: null,
    token: `token-${rfpRows.length + 1}`,
    tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    status: "pending",
    dealData: {},
    bidboardProjectId: null,
    createdAt: new Date(),
    ...overrides,
  };
});

vi.mock("../server/storage.ts", () => ({
  isUniqueViolation: (error: any, indexName: string) => (
    error?.code === "23505" &&
    (error?.constraint === indexName || String(error?.message || "").includes(indexName))
  ),
  storage: {
    getRfpApprovalRequestBySourceEventId: vi.fn(async (sourceSystem: string, sourceEventId: string) =>
      rfpRows.find((row) => row.sourceSystem === sourceSystem && row.sourceEventId === sourceEventId)
    ),
    getRfpApprovalRequestBySourceDealId: vi.fn(async (sourceSystem: string, sourceDealId: string) =>
      rfpRows.find((row) => row.sourceSystem === sourceSystem && row.sourceDealId === sourceDealId)
    ),
    getRfpApprovalRequestByProjectNumberAndStatus: vi.fn(async (projectNumber: string, status: string) => {
      if (projectNumber === "RACE-1" && status === "pending" && raceBypassPendingLookups.count > 0) {
        raceBypassPendingLookups.count -= 1;
        return undefined;
      }
      return rfpRows.find((row) => row.projectNumber === projectNumber && row.status === status);
    }),
    createRfpApprovalRequest: vi.fn(async (row: any) => {
      const duplicatePending = rfpRows.find((existing) =>
        existing.status === "pending" &&
        existing.projectNumber === row.projectNumber
      );
      if (duplicatePending) {
        const error: any = new Error("duplicate key value violates unique constraint idx_rfp_approval_pending_project_number");
        error.code = "23505";
        error.constraint = "idx_rfp_approval_pending_project_number";
        throw error;
      }
      const duplicateSourceDeal = rfpRows.find((existing) =>
        existing.status === "pending" &&
        existing.sourceSystem === row.sourceSystem &&
        existing.sourceDealId === row.sourceDealId
      );
      if (duplicateSourceDeal) {
        const error: any = new Error("duplicate key value violates unique constraint idx_rfp_approval_pending_source_deal");
        error.code = "23505";
        error.constraint = "idx_rfp_approval_pending_source_deal";
        throw error;
      }
      const inserted = makeRow(row);
      rfpRows.push(inserted);
      return inserted;
    }),
    getRfpApproverConfigs: vi.fn(async () => [
      {
        projectType: "*",
        sourceSystem: null,
        approverEmails: ["reviewer@trockgc.com"],
        isActive: true,
      },
    ]),
    getEmailTemplate: vi.fn(async () => ({ key: "rfp_review", enabled: true })),
    createEmailSendLog: vi.fn(async (row: any) => {
      emailLogs.push(row);
      return { id: emailLogs.length, ...row };
    }),
    createAuditLog: vi.fn(async (row: any) => ({ id: 1, ...row })),
    getAutomationConfig: vi.fn(async () => null),
  },
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(),
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn(),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(),
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

function requestBody(overrides: Partial<any> = {}) {
  return {
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    sourceEventId: "crm-event-1",
    deal: {
      name: "CRM Deal",
      projectNumber: "DFW-2-12345",
      projectType: "2",
      amount: 150000,
      estimator: "Estimator",
      companyName: "Client Co",
      contactName: "Client Contact",
      clientEmail: "client@example.com",
      clientPhone: "555-0100",
      address: {
        street: "100 Main St",
        city: "Flower Mound",
        state: "TX",
        zip: "75022",
        country: "US",
      },
      description: "Project description",
      dueDate: "2026-05-10T12:00:00.000Z",
      workflowRoute: null,
    },
    attachments: [{ name: "RFP.pdf", url: "https://example.com/rfp.pdf", contentType: "application/pdf" }],
    ...overrides,
  };
}

async function withServer<T>(fn: (baseUrl: string, signPayload: (body: string) => string) => Promise<T>) {
  const { registerRfpRequestRoutes, signRfpRequestPayload } = await import("../server/routes/rfp-requests.ts");
  const app = express();
  registerRfpRequestRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    return await fn(`http://127.0.0.1:${address.port}`, (body) => signRfpRequestPayload(body, process.env.RFP_REQUEST_SYNC_SECRET!));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function postRfpRequest(baseUrl: string, body: any, signature?: string | null) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["x-rfp-request-signature"] = signature ?? (await import("../server/routes/rfp-requests.ts")).signRfpRequestPayload(raw, process.env.RFP_REQUEST_SYNC_SECRET!);
  }
  const response = await fetch(`${baseUrl}/api/rfp-requests`, {
    method: "POST",
    headers,
    body: raw,
  });
  return { status: response.status, body: await response.json() };
}

describe("POST /api/rfp-requests", () => {
  beforeEach(() => {
    vi.resetModules();
    rfpRows.length = 0;
    emailLogs.length = 0;
    sendEmailMock.mockClear();
    raceBypassPendingLookups.count = 0;
    process.env.RFP_REQUEST_SYNC_SECRET = "test-secret";
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
  });

  afterEach(() => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    delete process.env.TROCK_CRM_BASE_URL;
  });

  it("creates a pending approval request and sends one review email for a valid request", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody());

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        success: true,
        status: "pending",
        sourceSystem: "trock_crm",
        sourceDealId: "crm-deal-1",
        projectNumber: "DFW-2-12345",
      });
      expect(rfpRows).toHaveLength(1);
      expect(rfpRows[0]).toMatchObject({
        sourceSystem: "trock_crm",
        sourceDealId: "crm-deal-1",
        sourceEventId: "crm-event-1",
        projectNumber: "DFW-2-12345",
        hubspotDealId: null,
        status: "pending",
      });
      expect(rfpRows[0].tokenExpiresAt).toBeInstanceOf(Date);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(emailLogs).toHaveLength(1);
    });
  });

  it("returns 200 for idempotent replay without inserting or sending email again", async () => {
    await withServer(async (baseUrl) => {
      const first = await postRfpRequest(baseUrl, requestBody());
      const second = await postRfpRequest(baseUrl, requestBody());

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ success: true, idempotent: true, status: "pending" });
      expect(rfpRows).toHaveLength(1);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a pending cross-source project_number collision", async () => {
    rfpRows.push(makeRow({
      sourceSystem: "hubspot",
      sourceDealId: "hs-deal-1",
      sourceEventId: "hs-event-1",
      projectNumber: "COLLIDE-1",
      status: "pending",
    }));

    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody({ deal: { ...requestBody().deal, projectNumber: "COLLIDE-1" } }));

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        success: false,
        error: "pending_collision",
        projectNumber: "COLLIDE-1",
        conflict: { sourceSystem: "hubspot", sourceDealId: "hs-deal-1", status: "pending" },
      });
      expect(rfpRows).toHaveLength(1);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  it("rejects an approved project_number collision with bidboardProjectId", async () => {
    rfpRows.push(makeRow({
      sourceSystem: "hubspot",
      sourceDealId: "hs-deal-2",
      sourceEventId: "hs-event-2",
      projectNumber: "APPROVED-1",
      status: "approved",
      bidboardProjectId: "bb-123",
    }));

    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody({ deal: { ...requestBody().deal, projectNumber: "APPROVED-1" } }));

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        success: false,
        error: "approved_collision",
        conflict: { status: "approved", bidboardProjectId: "bb-123" },
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  it("allows a declined project_number to be re-bid", async () => {
    rfpRows.push(makeRow({
      sourceSystem: "hubspot",
      sourceDealId: "hs-deal-3",
      sourceEventId: "hs-event-3",
      projectNumber: "REBID-1",
      status: "declined",
    }));

    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody({
        sourceEventId: "crm-event-rebid",
        deal: { ...requestBody().deal, projectNumber: "REBID-1" },
      }));

      expect(response.status).toBe(201);
      expect(rfpRows).toHaveLength(2);
      expect(rfpRows[1]).toMatchObject({ projectNumber: "REBID-1", status: "pending" });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
  });

  it("allows a cancelled_source_ineligible project_number to be re-bid", async () => {
    rfpRows.push(makeRow({
      sourceSystem: "hubspot",
      sourceDealId: "hs-deal-cancelled",
      sourceEventId: "hs-event-cancelled",
      projectNumber: "CANCELLED-1",
      status: "cancelled_source_ineligible",
    }));

    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody({
        sourceEventId: "crm-event-cancelled-rebid",
        deal: { ...requestBody().deal, projectNumber: "CANCELLED-1" },
      }));

      expect(response.status).toBe(201);
      expect(rfpRows).toHaveLength(2);
      expect(rfpRows[1]).toMatchObject({ projectNumber: "CANCELLED-1", status: "pending" });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
  });

  it("converts a pending project_number unique violation during concurrent inserts into a 409", async () => {
    raceBypassPendingLookups.count = 2;

    await withServer(async (baseUrl) => {
      const bodyA = requestBody({ sourceDealId: "crm-race-a", sourceEventId: "crm-race-a", deal: { ...requestBody().deal, projectNumber: "RACE-1" } });
      const bodyB = requestBody({ sourceDealId: "crm-race-b", sourceEventId: "crm-race-b", deal: { ...requestBody().deal, projectNumber: "RACE-1" } });
      const responses = await Promise.all([
        postRfpRequest(baseUrl, bodyA),
        postRfpRequest(baseUrl, bodyB),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(rfpRows.filter((row) => row.projectNumber === "RACE-1")).toHaveLength(1);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(responses.find((r) => r.status === 409)?.body).toMatchObject({
        success: false,
        error: "pending_collision",
        projectNumber: "RACE-1",
      });
    });
  });

  it("converts a pending source_deal unique violation into a 409", async () => {
    const existing = makeRow({
      sourceSystem: "trock_crm",
      sourceDealId: "abc",
      sourceEventId: "crm-event-existing",
      projectNumber: "SOURCE-1",
      status: "pending",
    });
    rfpRows.push(existing);

    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(baseUrl, requestBody({
        sourceSystem: "trock_crm",
        sourceDealId: "abc",
        sourceEventId: "crm-event-second",
        deal: { ...requestBody().deal, projectNumber: "SOURCE-2" },
      }));

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        success: false,
        error: "RFP already in flight",
        message: "Pending RFP already exists for trock_crm deal abc",
        conflict: {
          requestId: existing.id,
          sourceSystem: "trock_crm",
          sourceDealId: "abc",
          status: "pending",
        },
      });
      expect(rfpRows).toHaveLength(1);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  it("converts a pending source_deal unique violation during concurrent inserts into a 409", async () => {
    await withServer(async (baseUrl) => {
      const bodyA = requestBody({
        sourceDealId: "crm-source-race",
        sourceEventId: "crm-source-race-a",
        deal: { ...requestBody().deal, projectNumber: "SOURCE-RACE-A" },
      });
      const bodyB = requestBody({
        sourceDealId: "crm-source-race",
        sourceEventId: "crm-source-race-b",
        deal: { ...requestBody().deal, projectNumber: "SOURCE-RACE-B" },
      });
      const responses = await Promise.all([
        postRfpRequest(baseUrl, bodyA),
        postRfpRequest(baseUrl, bodyB),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(rfpRows.filter((row) => row.sourceDealId === "crm-source-race")).toHaveLength(1);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(responses.find((r) => r.status === 409)?.body).toMatchObject({
        success: false,
        error: "RFP already in flight",
        conflict: {
          sourceSystem: "trock_crm",
          sourceDealId: "crm-source-race",
          status: "pending",
        },
      });
    });
  });

  it("returns 422 when projectNumber is missing", async () => {
    await withServer(async (baseUrl) => {
      const body = requestBody({ deal: { ...requestBody().deal } });
      delete (body.deal as any).projectNumber;
      const response = await postRfpRequest(baseUrl, body);

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ success: false, error: "Unprocessable Entity" });
      expect(rfpRows).toHaveLength(0);
    });
  });

  it("returns 401 when the HMAC header is missing or wrong", async () => {
    await withServer(async (baseUrl) => {
      const missing = await postRfpRequest(baseUrl, requestBody(), null);
      const wrong = await postRfpRequest(baseUrl, requestBody(), "sha256=wrong");

      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(rfpRows).toHaveLength(0);
    });
  });

  it("returns 500 when RFP_REQUEST_SYNC_SECRET is missing at request time", async () => {
    await withServer(async (baseUrl) => {
      delete process.env.RFP_REQUEST_SYNC_SECRET;
      const response = await postRfpRequest(baseUrl, requestBody(), "sha256=anything");

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        success: false,
        error: "Internal Server Error",
      });
      expect(response.body.message).toContain("RFP_REQUEST_SYNC_SECRET not configured");
    });
  });
});
