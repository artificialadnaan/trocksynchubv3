import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestRow = vi.hoisted(() => ({ current: undefined as any }));
const auditRows = vi.hoisted(() => [] as any[]);
const processRfpApprovalMock = vi.hoisted(() => vi.fn(async () => ({ success: true, bidboardProjectId: "BB-1" })));
const processRfpDeclineMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => requestRow.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => ({ ...requestRow.current, ...data })),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
    getHubspotDealByHubspotId: vi.fn(async () => undefined),
    createRfpApprovalEdit: vi.fn(async (row: any) => row),
    getAutomationConfig: vi.fn(async () => null),
    // No config rows → real isAuthorizedRfpApprover falls through to the hardcoded safety net
    // (type "2" → sgibson + jhelms).
    getRfpApproverConfigs: vi.fn(async () => []),
  },
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  resolveHubspotStageId: vi.fn(async () => ({ stageId: "stage-1", stageName: "Estimating" })),
}));

vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(),
  getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(),
  updateHubSpotDeal: vi.fn(async () => ({ success: true })),
  updateHubSpotDealStage: vi.fn(async () => ({ success: true })),
  syncSingleHubSpotDeal: vi.fn(async () => undefined),
}));

vi.mock("../server/email-service.ts", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  renderTemplate: vi.fn(),
  GLOBAL_CC_RECIPIENTS: ["adnaan.iqbal@gmail.com", "bbell@trockgc.com"],
}));

vi.mock("../server/index.ts", () => ({
  log: vi.fn(),
}));

vi.mock("../server/rfp-approval.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/rfp-approval.ts")>();
  return {
    ...actual,
    processRfpApproval: processRfpApprovalMock,
    processRfpDecline: processRfpDeclineMock,
  };
});

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
    createdAt: new Date(Date.now() - 60_000),
    dealData: {
      dealname: "Review Me",
      project_number: "DFW-2-10001",
      project_types: "2",
      attachments: [],
      description: "Scope",
    },
    ...overrides,
  };
}

async function withApp(fn: (baseUrl: string) => Promise<void>) {
  const { registerRfpApprovalRoutes } = await import("../server/routes/rfp-approval.ts");
  const app = express();
  app.use(express.json());
  registerRfpApprovalRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

describe("RFP token expiry enforcement", () => {
  beforeEach(() => {
    vi.resetModules();
    auditRows.length = 0;
    processRfpApprovalMock.mockClear();
    processRfpDeclineMock.mockClear();
    requestRow.current = makeRequest();
  });

  it("renders an expiry error page for expired review links", async () => {
    requestRow.current = makeRequest({ tokenExpiresAt: new Date(Date.now() - 1000) });

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/rfp-review/token-1`);
      const html = await response.text();

      expect(response.status).toBe(410);
      expect(html).toContain("This RFP review link has expired.");
      expect(html).toContain("Contact the sender if you still need to review this request.");
    });
  });

  it("returns 410 for expired approve attempts and writes an audit log", async () => {
    requestRow.current = makeRequest({ tokenExpiresAt: new Date(Date.now() - 1000) });

    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "approver@trockgc.com");
      form.append("editedFields", JSON.stringify({}));
      const response = await fetch(`${baseUrl}/api/rfp-approval/token-1/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body).toMatchObject({ success: false, error: "expired" });
      expect(body.expiredAt).toBeTruthy();
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
      expect(auditRows[0]).toMatchObject({
        action: "rfp_approval_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "expired", approverEmail: "approver@trockgc.com" }),
      });
    });
  });

  it("returns 410 for expired decline attempts and writes an audit log", async () => {
    requestRow.current = makeRequest({ tokenExpiresAt: new Date(Date.now() - 1000) });

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rfp-approval/token-1/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ declinerEmail: "decliner@trockgc.com" }),
      });
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body).toMatchObject({ success: false, error: "expired" });
      expect(processRfpDeclineMock).not.toHaveBeenCalled();
      expect(auditRows[0]).toMatchObject({
        action: "rfp_decline_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "expired", approverEmail: "decliner@trockgc.com" }),
      });
    });
  });

  it("does not treat legacy NULL tokenExpiresAt rows as expired", async () => {
    requestRow.current = makeRequest({ tokenExpiresAt: null });

    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/rfp-review/token-1`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("RFP Review &amp; Approval");
    });
  });

  it("keeps valid non-expired approve flow unchanged", async () => {
    await withApp(async (baseUrl) => {
      const form = new FormData();
      // Authorized approver for project type "2" (safety-net routing → sgibson + jhelms).
      form.append("approverEmail", "sgibson@trockgc.com");
      form.append("editedFields", JSON.stringify({}));
      const response = await fetch(`${baseUrl}/api/rfp-approval/token-1/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({ success: true, queued: true });
    });
  });
});
