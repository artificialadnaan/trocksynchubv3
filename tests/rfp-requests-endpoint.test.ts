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
    getRfpApprovalRequestBySourceDealAndStatus: vi.fn(async (sourceSystem: string, sourceDealId: string, status: string) =>
      rfpRows.find((row) => row.sourceSystem === sourceSystem && row.sourceDealId === sourceDealId && row.status === status)
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

describe("GET /api/rfp/estimators", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RFP_REQUEST_SYNC_SECRET = "test-secret";
  });
  afterEach(() => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
  });

  it("401s a request with no signature or a wrong signature", async () => {
    await withServer(async (baseUrl) => {
      const noSig = await fetch(`${baseUrl}/api/rfp/estimators`);
      expect(noSig.status).toBe(401);
      const badSig = await fetch(`${baseUrl}/api/rfp/estimators`, {
        headers: { "x-rfp-request-signature": "sha256=deadbeef" },
      });
      expect(badSig.status).toBe(401);
    });
  });

  it("returns the SANITIZED estimator list (trimmed name, lowercased email) for a valid empty-body signature", async () => {
    const { storage } = await import("../server/storage.ts");
    (storage.getAutomationConfig as any).mockResolvedValueOnce({
      value: {
        estimators: [
          { name: "  Colby Burling  ", email: "CBurling@TROCKGC.com" },
          { name: "Tim Mitchell", email: "tmitchell@trockgc.com" },
        ],
      },
    });
    await withServer(async (baseUrl, sign) => {
      const res = await fetch(`${baseUrl}/api/rfp/estimators`, {
        headers: { "x-rfp-request-signature": sign("") },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.estimators).toEqual([
        { name: "Colby Burling", email: "cburling@trockgc.com" },
        { name: "Tim Mitchell", email: "tmitchell@trockgc.com" },
      ]);
    });
  });

  it("500s when RFP_REQUEST_SYNC_SECRET is missing", async () => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/rfp/estimators`, {
        headers: { "x-rfp-request-signature": "sha256=x" },
      });
      expect(res.status).toBe(500);
    });
  });
});

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

  it("stores the CRM-sent deal owner in deal_data independently of requester identity", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "OWNER-1",
            ownerName: "Maria Gonzalez",
            ownerEmail: "maria@trockgc.com",
          },
        })
      );
      expect(response.status).toBe(201);
      expect(rfpRows).toHaveLength(1);
      // normalizedDealData writes ownerName/ownerEmail from the payload for trock_crm RFPs.
      expect(rfpRows[0].dealData).toMatchObject({
        ownerName: "Maria Gonzalez",
        ownerEmail: "maria@trockgc.com",
      });
    });
  });

  it("stores and renders the actual type-4 requester separately from the deal owner without changing routing", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "DFW-4-12345-aa",
            projectType: "4",
            ownerName: "Olivia Owner",
            ownerEmail: "owner@trockgc.com",
            requestedByName: "Rita <Ops> & Co",
            requestedByEmail: "requester@trockgc.com",
          },
        })
      );

      expect(response.status).toBe(201);
      expect(rfpRows[0].dealData).toMatchObject({
        ownerName: "Olivia Owner",
        ownerEmail: "owner@trockgc.com",
        requestedByName: "Rita <Ops> & Co",
        requestedByEmail: "requester@trockgc.com",
      });

      const email = sendEmailMock.mock.calls[0]?.[0] as any;
      expect(email.to).toBe("reviewer@trockgc.com");
      const html = email.htmlBody ?? "";
      expect(html).toContain("Requested by");
      expect(html).toContain("Rita &lt;Ops&gt; &amp; Co");
      expect(html).not.toContain("Rita <Ops> & Co");
      expect(html).toContain('href="mailto:requester@trockgc.com"');
      expect(html).toContain("Deal Owner");
      expect(html).toContain("Olivia Owner");
      expect(html).toContain('href="mailto:owner@trockgc.com"');
    });
  });

  it("renders a partial requester name without borrowing the deal owner's email", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "REQUESTER-NAME-ONLY",
            ownerName: "Olivia Owner",
            ownerEmail: "owner@trockgc.com",
            requestedByName: "Rita Requester",
          },
        })
      );

      expect(response.status).toBe(201);
      const html = (sendEmailMock.mock.calls[0]?.[0] as any)?.htmlBody ?? "";
      const requestedByStart = html.indexOf("Requested by");
      const ownerStart = html.indexOf("Deal Owner");
      const requestedByRow = html.slice(requestedByStart, ownerStart);
      expect(requestedByRow).toContain("Rita Requester");
      expect(requestedByRow).not.toContain("owner@trockgc.com");
    });
  });

  it("renders an email-only requester as a validated mailto link", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "REQUESTER-EMAIL-ONLY",
            requestedByEmail: "requester-only@trockgc.com",
          },
        })
      );

      expect(response.status).toBe(201);
      const html = (sendEmailMock.mock.calls[0]?.[0] as any)?.htmlBody ?? "";
      expect(html).toContain('href="mailto:requester-only@trockgc.com"');
    });
  });

  it("accepts a legacy request with no requester or owner fields and renders N/A", async () => {
    await withServer(async (baseUrl) => {
      const body = requestBody({ deal: { ...requestBody().deal, projectNumber: "NOOWNER-1" } });
      // Ensure the payload genuinely omits both generations of identity fields.
      expect((body.deal as any).ownerName).toBeUndefined();
      expect((body.deal as any).requestedByName).toBeUndefined();
      const response = await postRfpRequest(baseUrl, body);
      expect(response.status).toBe(201);
      expect(rfpRows[0].dealData).toMatchObject({
        ownerName: "",
        ownerEmail: "",
        requestedByName: "",
        requestedByEmail: "",
      });
      const html = (sendEmailMock.mock.calls[0]?.[0] as any)?.htmlBody ?? "";
      const requestedByStart = html.indexOf("Requested by");
      const ownerStart = html.indexOf("Deal Owner");
      const descriptionStart = html.indexOf("Description", ownerStart);
      expect(html.slice(requestedByStart, ownerStart)).toContain("N/A");
      expect(html.slice(ownerStart, descriptionStart)).toContain("N/A");
    });
  });

  it("drops malformed or oversized requester fields and falls back to the legacy owner", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "BAD-REQUESTER-1",
            ownerName: "Legacy Owner",
            ownerEmail: "legacy-owner@trockgc.com",
            requestedByName: "x".repeat(201),
            requestedByEmail: "javascript:alert(1)",
          },
        })
      );

      expect(response.status).toBe(201);
      expect(rfpRows[0].dealData).toMatchObject({ requestedByName: "", requestedByEmail: "" });
      const html = (sendEmailMock.mock.calls[0]?.[0] as any)?.htmlBody ?? "";
      expect(html).not.toContain("javascript:alert(1)");
      const requestedByStart = html.indexOf("Requested by");
      const ownerStart = html.indexOf("Deal Owner");
      const requestedByRow = html.slice(requestedByStart, ownerStart);
      expect(requestedByRow).toContain("Legacy Owner");
      expect(requestedByRow).toContain('href="mailto:legacy-owner@trockgc.com"');
    });
  });

  it("drops non-string requester fields instead of rejecting an otherwise-valid RFP", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: {
            ...requestBody().deal,
            projectNumber: "NONSTRING-REQUESTER-1",
            requestedByName: { id: "user-1" } as any,
            requestedByEmail: 12345 as any,
          },
        })
      );

      expect(response.status).toBe(201);
      expect(rfpRows[0].dealData).toMatchObject({ requestedByName: "", requestedByEmail: "" });
    });
  });

  it("drops a malformed owner value instead of rejecting the RFP (no 422)", async () => {
    await withServer(async (baseUrl) => {
      // Mid-rollout the CRM might send an object/number; a soft display field must not 422 the RFP.
      const body = requestBody({
        deal: {
          ...requestBody().deal,
          projectNumber: "BADOWNER-1",
          ownerName: { id: 1, name: "Rep" } as any,
          ownerEmail: 12345 as any,
        },
      });
      const response = await postRfpRequest(baseUrl, body);
      expect(response.status).toBe(201); // dropped via .catch(undefined), not 422
      expect(rfpRows[0].dealData).toMatchObject({ ownerName: "", ownerEmail: "" });
    });
  });

  it("legacy owner-only payload populates both Requested by fallback and Deal Owner", async () => {
    await withServer(async (baseUrl) => {
      const response = await postRfpRequest(
        baseUrl,
        requestBody({
          deal: { ...requestBody().deal, projectNumber: "EMAILONLY-1", ownerEmail: "owner@trockgc.com" },
        })
      );
      expect(response.status).toBe(201);
      const html = (sendEmailMock.mock.calls[0]?.[0] as any)?.htmlBody ?? "";
      expect(html).toContain("Requested by");
      expect(html).toContain("Deal Owner");
      expect(html.match(/href="mailto:owner@trockgc\.com"/g)).toHaveLength(2);
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
