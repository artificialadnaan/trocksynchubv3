import express from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// S0b-2a (runbook r5 §2; d9 rulings 5a / 5b): nobody re-opens a create in progress through a review link.
//   - decline of an `approving` request ⇒ 409 (today it answers 200 {success:false});
//   - reset of an `approving` or `held_cross_destination` request ⇒ 409, the row untouched;
//   - reset of an `override_approving` request STAYS ALLOWED (today's only recovery for a stuck override; I1) and raises
//     rfp_request_override_reset carrying the row id, the deal and whether a sync mapping / create command exists for it,
//     so a person can spot a reset whose override may already have created a project.
// Synthetic data only (I7).
const reqState = vi.hoisted(() => ({ current: null as any }));
const processRfpDecline = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({ success: false, error: "Request already approving" })));
const updateRequest = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({})));
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
const footprintMock = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({ syncMapping: true, createCommand: false })));
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async () => null),
    getRfpApprovalRequestByToken: vi.fn(async () => reqState.current),
    updateRfpApprovalRequest: updateRequest,
    createAuditLog: vi.fn(async () => ({})),
    getHubspotDealByHubspotId: vi.fn(),
  },
}));
vi.mock("../server/rfp-approval.ts", () => ({
  processRfpDecline,
  processRfpApproval: vi.fn(),
  resolveRfpDescription: vi.fn(() => ""),
  isRfpApprovalRequestExpired: vi.fn(() => false),
  buildExpiredRfpMessage: vi.fn(() => "expired"),
  checkRfpApprovalSourceEligibility: vi.fn(async () => ({ eligible: true })),
  cancelIneligibleRfpApproval: vi.fn(),
  isAuthorizedRfpApprover: vi.fn(async () => true),
  resolveEffectiveRfpProjectType: vi.fn(() => "2"),
}));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));
vi.mock("../server/sync/rfp-approving.ts", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  describeOverrideResetFootprint: footprintMock,
}));

const { registerRfpApprovalRoutes } = await import("../server/routes/rfp-approval.ts");

const DEAL = "00000000-0000-4000-8000-0000000000f5";
let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerRfpApprovalRoutes(app);
  server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  processRfpDecline.mockClear();
  updateRequest.mockClear();
  alertMock.mockClear();
  footprintMock.mockClear();
});

function request(status: string) {
  return {
    id: 7, token: "synthetic-token", status, sourceSystem: "trock_crm", sourceDealId: DEAL, hubspotDealId: null,
    projectNumber: "DFW-2-54321-cd", bidboardProjectId: null, tokenExpiresAt: new Date(Date.now() + 60_000),
    dealData: { dealname: "Synthetic Deal", project_number: "DFW-2-54321-cd", project_types: "2" },
  };
}
const post = (path: string, body: Record<string, unknown> = {}) =>
  fetch(`${base}/api/rfp-approval/synthetic-token/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("decline route vs a create in progress", () => {
  it("decline of an approving request ⇒ 409; nothing is declined", async () => {
    reqState.current = request("approving");
    const res = await post("decline", { declinerEmail: "approver@example.test" });
    expect(res.status).toBe(409);
    expect(processRfpDecline).not.toHaveBeenCalled();
  });
  it("decline of a pending request ⇒ today's decline (guard)", async () => {
    reqState.current = request("pending");
    processRfpDecline.mockResolvedValueOnce({ success: true } as any);
    const res = await post("decline", { declinerEmail: "approver@example.test" });
    expect(res.status).toBe(200);
    expect(processRfpDecline).toHaveBeenCalledTimes(1);
  });
});

describe("reset route vs a create in progress", () => {
  for (const status of ["approving", "held_cross_destination"]) {
    it(`reset of a ${status} request ⇒ 409; the row is untouched`, async () => {
      reqState.current = request(status);
      const res = await post("reset");
      expect(res.status).toBe(409);
      expect(updateRequest).not.toHaveBeenCalled();
    });
  }
  it("reset of an override_approving request stays allowed (today's only recovery) and raises rfp_request_override_reset with the deal's footprint", async () => {
    reqState.current = request("override_approving");
    const res = await post("reset");
    expect(res.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith(7, expect.objectContaining({ status: "pending" }));
    const call = alertMock.mock.calls.find((c) => c[0] === "rfp_request_override_reset");
    expect(call, "rfp_request_override_reset was raised").toBeDefined();
    expect(call?.[1]).toMatchObject({ requestId: 7, sourceSystem: "trock_crm", sourceDealId: DEAL, syncMapping: true, createCommand: false });
  });
  for (const status of ["approved", "declined", "pending"]) {
    it(`reset of a ${status} request is unchanged: reset to pending, no alert (guard)`, async () => {
      reqState.current = request(status);
      const res = await post("reset");
      expect(res.status).toBe(200);
      expect(updateRequest).toHaveBeenCalledWith(7, expect.objectContaining({ status: "pending" }));
      expect(alertMock).not.toHaveBeenCalled();
    });
  }
});
