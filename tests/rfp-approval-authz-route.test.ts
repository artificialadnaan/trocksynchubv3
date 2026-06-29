import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level coverage of the approve/decline authorization wiring. Mirrors
// tests/rfp-approval-route.test.ts: fully mock ../server/rfp-approval and drive the route's
// 403/202/audit behavior off a controllable isAuthorizedRfpApprover stub. (The real authz logic
// is covered in tests/rfp-approver-authz.test.ts.)

const requestRow = vi.hoisted(() => ({ current: undefined as any }));
const auditRows = vi.hoisted(() => [] as any[]);
const authorize = vi.hoisted(() => vi.fn(async () => true));
const processRfpApprovalMock = vi.hoisted(() => vi.fn(async () => ({ success: true, bidboardProjectId: "BB-1" })));
const processRfpDeclineMock = vi.hoisted(() => vi.fn(async () => ({ success: true })));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestByToken: vi.fn(async () => requestRow.current),
    updateRfpApprovalRequest: vi.fn(async (_id: number, data: any) => ({ ...requestRow.current, ...data })),
    createRfpApprovalEdit: vi.fn(async (row: any) => row),
    getHubspotDealByHubspotId: vi.fn(async () => undefined),
    getAutomationConfig: vi.fn(async () => null),
    createAuditLog: vi.fn(async (row: any) => {
      auditRows.push(row);
      return { id: auditRows.length, ...row };
    }),
  },
}));

vi.mock("../server/rfp-approval.ts", () => ({
  processRfpApproval: processRfpApprovalMock,
  processRfpDecline: processRfpDeclineMock,
  resolveRfpDescription: vi.fn(() => ""),
  isRfpApprovalRequestExpired: vi.fn(() => false),
  buildExpiredRfpMessage: vi.fn(() => "expired"),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  cancelIneligibleRfpApproval: vi.fn(),
  isAuthorizedRfpApprover: authorize,
}));

function makeRequest(overrides: Partial<any> = {}) {
  return {
    id: 42,
    token: "tok-authz",
    status: "pending",
    sourceSystem: "hubspot",
    sourceDealId: "hs-42",
    hubspotDealId: "hs-42",
    projectNumber: "DFW-4-42001",
    tokenExpiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 60_000),
    dealData: { dealname: "Service Job", project_number: "DFW-4-42001", project_types: "4", attachments: [], description: "Scope" },
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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe("RFP approve/decline route authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    auditRows.length = 0;
    authorize.mockReset();
    authorize.mockResolvedValue(true);
    processRfpApprovalMock.mockClear();
    processRfpDeclineMock.mockClear();
    requestRow.current = makeRequest();
  });

  it("rejects an unauthorized approver with 403 and audits the attempt", async () => {
    authorize.mockResolvedValue(false);
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "sgibson@trockgc.com");
      form.append("editedFields", JSON.stringify({}));
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "unauthorized_approver" });
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
      // Authorized against the original project type from the stored row.
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
      expect(auditRows.at(-1)).toMatchObject({
        action: "rfp_approval_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "unauthorized_approver", approverEmail: "sgibson@trockgc.com" }),
      });
    });
  });

  it("allows an authorized approver through to background processing (202 regression)", async () => {
    authorize.mockResolvedValue(true);
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "cburling@trockgc.com");
      form.append("editedFields", JSON.stringify({}));
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({ success: true, queued: true });
    });
  });

  it("rejects an approver who edits project_types into a routing group they're NOT authorized for", async () => {
    // Non-service approver received a type-2 RFP, then edits it to type 4 (service) and approves.
    requestRow.current = makeRequest({
      projectNumber: "DFW-2-42001",
      dealData: { dealname: "Reno Job", project_number: "DFW-2-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockImplementation(async (_email: string, projectType?: string | null) => projectType === "2"); // non-service only
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "sgibson@trockgc.com");
      form.append("editedFields", JSON.stringify({ project_types: "4" })); // re-classify to service
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "unauthorized_approver" });
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
      // Authorized for the received type (2) but checked AND rejected against the edited type (4).
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "2", "hubspot");
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
    });
  });

  it("allows an edit within authority (approver authorized for both the received and edited type)", async () => {
    requestRow.current = makeRequest({
      dealData: { dealname: "Reno Job", project_number: "DFW-2-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockResolvedValue(true); // e.g. James — in both the non-service and service sets
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "jhelms@trockgc.com");
      form.append("editedFields", JSON.stringify({ project_types: "4" }));
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({ success: true, queued: true });
    });
  });

  it("rejects an unauthorized decliner with 403 and audits the attempt", async () => {
    authorize.mockResolvedValue(false);
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ declinerEmail: "sgibson@trockgc.com" }),
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "unauthorized_approver" });
      expect(processRfpDeclineMock).not.toHaveBeenCalled();
      expect(auditRows.at(-1)).toMatchObject({
        action: "rfp_decline_attempt",
        status: "failed",
        details: expect.objectContaining({ outcome: "unauthorized_approver" }),
      });
    });
  });

  it("allows an authorized decliner through to processRfpDecline", async () => {
    authorize.mockResolvedValue(true);
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/decline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ declinerEmail: "jhelms@trockgc.com" }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ success: true });
      expect(processRfpDeclineMock).toHaveBeenCalledWith("tok-authz", "jhelms@trockgc.com");
    });
  });
});
