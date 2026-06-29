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

vi.mock("../server/rfp-approval.ts", async () => {
  // Use the REAL canonical-type resolver so the route's "created type" gate is exercised against the
  // exact derivation the processor uses. It only depends on the dependency-free constants module, so
  // we can build it here without pulling in the heavy real rfp-approval module.
  const { parseProjectTypeFromNumber } = await import("../server/constants.ts");
  const resolveEffectiveRfpProjectType = (dealData: any, editedFields?: any): string | null => {
    const currentProjectNumber = (dealData?.project_number ?? "") as string;
    const currentTypeDigit = parseProjectTypeFromNumber(currentProjectNumber) ?? dealData?.project_types ?? "";
    const submittedProjectType = editedFields?.project_types;
    let finalProjectTypeDigit = currentTypeDigit || submittedProjectType || dealData?.project_types || "2";
    if (submittedProjectType && submittedProjectType !== currentTypeDigit) {
      finalProjectTypeDigit = submittedProjectType;
    } else if (currentProjectNumber && !submittedProjectType && currentTypeDigit) {
      finalProjectTypeDigit = currentTypeDigit;
    }
    return finalProjectTypeDigit ? String(finalProjectTypeDigit) : null;
  };
  return {
    processRfpApproval: processRfpApprovalMock,
    processRfpDecline: processRfpDeclineMock,
    resolveRfpDescription: vi.fn(() => ""),
    isRfpApprovalRequestExpired: vi.fn(() => false),
    buildExpiredRfpMessage: vi.fn(() => "expired"),
    checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
    cancelIneligibleRfpApproval: vi.fn(),
    isAuthorizedRfpApprover: authorize,
    resolveEffectiveRfpProjectType,
  };
});

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
      // The 202 must actually DISPATCH the background processor (it runs in setImmediate after the
      // response), not just return the queued envelope — prove the authorized branch reached it.
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalledTimes(1));
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
      // The gate authorizes the CANONICAL created type: the edit re-classifies to service (4), so the
      // non-service approver is checked against — and rejected for — 4, the type they'd actually create.
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
    });
  });

  it("allows an edit within authority (approver authorized for the edited/created type)", async () => {
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

  it("rejects a non-service approver when the project NUMBER encodes a service type (canonical-type bypass, no edit)", async () => {
    // The bypass: dealData.project_types is the routed type '2' (non-service) but the project NUMBER
    // is 'DFW-4-...' (type 4 = service). processRfpApproval derives finalProjectTypeDigit '4' from the
    // number and would create a SERVICE project. The OLD gate (routed project_types only) missed this;
    // the canonical-created check catches it WITHOUT any edit.
    requestRow.current = makeRequest({
      projectNumber: "DFW-4-42001",
      dealData: { dealname: "Sneaky Service", project_number: "DFW-4-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockImplementation(async (_email: string, projectType?: string | null) => projectType === "2"); // non-service only
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "sgibson@trockgc.com");
      form.append("editedFields", JSON.stringify({})); // NO edit — the bypass needs none
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({ success: false, error: "unauthorized_approver" });
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
      // The gate authorizes the canonical created type (4 — parsed from the project number), which the
      // non-service approver lacks, so they're rejected even though they own the routed type (2).
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
    });
  });

  it("allows a service approver on a row whose project NUMBER encodes a service type (canonical match → 202)", async () => {
    requestRow.current = makeRequest({
      projectNumber: "DFW-4-42001",
      dealData: { dealname: "Service Job", project_number: "DFW-4-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    // Service approver authorized for the canonical created type (4) — they do NOT need the routed type (2).
    authorize.mockImplementation(async (_email: string, projectType?: string | null) => projectType === "4");
    await withApp(async (baseUrl) => {
      const form = new FormData();
      form.append("approverEmail", "jhelms@trockgc.com");
      form.append("editedFields", JSON.stringify({}));
      const response = await fetch(`${baseUrl}/api/rfp-approval/tok-authz/approve`, { method: "POST", body: form });
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toMatchObject({ success: true, queued: true });
      // The canonical created type (4) was authorized, not just the routed type (2).
      expect(authorize).toHaveBeenCalledWith("jhelms@trockgc.com", "4", "hubspot");
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

  it("rejects a non-service decliner when the project NUMBER encodes a service type (canonical-type bypass)", async () => {
    // Mirror of the approve canonical-bypass: dealData.project_types is the routed type '2'
    // (non-service) but the project NUMBER is 'DFW-4-...' (service). A non-service approver authorized
    // ONLY for '2' must NOT be able to DECLINE a row that would create a SERVICE project — the decline
    // gate now checks the canonical created type ('4') too.
    requestRow.current = makeRequest({
      projectNumber: "DFW-4-42001",
      dealData: { dealname: "Sneaky Service", project_number: "DFW-4-42001", project_types: "2", attachments: [], description: "Scope" },
    });
    authorize.mockImplementation(async (_email: string, projectType?: string | null) => projectType === "2"); // non-service only
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
      // The decline gate authorizes the canonical created type (4 — parsed from the project number),
      // which the non-service decliner lacks, so they're rejected despite owning the routed type (2).
      expect(authorize).toHaveBeenCalledWith("sgibson@trockgc.com", "4", "hubspot");
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
