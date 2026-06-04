import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import crypto from "crypto";

// Endpoint behavior of POST /api/rfp-requests/:id/override-approve — HMAC auth + guards + 202.
// Mirrors the HMAC harness in tests/rfp-requests-endpoint.test.ts; mocks storage + rfp-approval.

const requestFixture = vi.hoisted(() => ({ current: undefined as any }));
const claimState = vi.hoisted(() => ({ claimed: false }));
const eligibility = vi.hoisted(() => ({ current: { eligible: true } as any }));
const processRfpApprovalMock = vi.hoisted(() => vi.fn(async () => ({ success: true, bidboardProjectId: "BB-1" })));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestById: vi.fn(async (_id: number) => requestFixture.current),
    // Atomic claim: succeeds exactly once for a claimable (declined, no project) request → status
    // override_approving; a concurrent caller gets undefined → 409 (mirrors the real conditional
    // UPDATE...RETURNING).
    claimDeclinedRfpForOverride: vi.fn(async (_id: number) => {
      const r = requestFixture.current;
      if (!claimState.claimed && r?.status === "declined" && !r?.bidboardProjectId) {
        claimState.claimed = true;
        return { ...r, status: "override_approving" };
      }
      return undefined;
    }),
  },
}));

vi.mock("../server/rfp-approval.ts", () => ({
  processRfpApproval: processRfpApprovalMock,
  createRfpApprovalRequestFromNormalizedInput: vi.fn(),
  checkRfpApprovalSourceEligibility: vi.fn(async () => eligibility.current),
}));

function sign(raw: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
}

async function withServer(fn: (baseUrl: string) => Promise<void>) {
  const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
  const app = express();
  registerRfpRequestRoutes(app);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as any).port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postOverride(
  baseUrl: string,
  id: number | string,
  body: any,
  signature?: string | null,
) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["x-rfp-request-signature"] = signature ?? sign(raw, process.env.RFP_REQUEST_SYNC_SECRET!);
  }
  const response = await fetch(`${baseUrl}/api/rfp-requests/${id}/override-approve`, {
    method: "POST",
    headers,
    body: raw,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function declinedRequest(overrides: Partial<any> = {}) {
  return {
    id: 77,
    token: "tok-77",
    status: "declined",
    sourceSystem: "trock_crm",
    bidboardProjectId: null,
    ...overrides,
  };
}

describe("POST /api/rfp-requests/:id/override-approve", () => {
  beforeEach(() => {
    vi.resetModules();
    processRfpApprovalMock.mockClear();
    processRfpApprovalMock.mockResolvedValue({ success: true, bidboardProjectId: "BB-1" });
    requestFixture.current = declinedRequest();
    claimState.claimed = false;
    eligibility.current = { eligible: true };
    process.env.RFP_REQUEST_SYNC_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
  });

  it("returns 202 and invokes processRfpApproval with force for a declined trock_crm request", async () => {
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalled());
      expect(processRfpApprovalMock).toHaveBeenCalledWith("tok-77", {}, "ashaw@trockgc.com", { force: true });
    });
  });

  it("guards double-create: 409 when the request already has a BidBoard project, and does NOT invoke approval", async () => {
    requestFixture.current = declinedRequest({ bidboardProjectId: "BB-OLD" });
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(409);
      await new Promise((r) => setImmediate(r));
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 409 when the request is not declined", async () => {
    requestFixture.current = declinedRequest({ status: "pending" });
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(409);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 409 when the request is not trock_crm", async () => {
    requestFixture.current = declinedRequest({ sourceSystem: "hubspot" });
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(409);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 404 when the request does not exist", async () => {
    requestFixture.current = undefined;
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 999, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(404);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 401 on a missing or wrong HMAC signature, and never invokes approval", async () => {
    await withServer(async (baseUrl) => {
      const missing = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" }, null);
      const wrong = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" }, "sha256=wrong");
      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 422 when approverEmail is missing or not a valid email", async () => {
    await withServer(async (baseUrl) => {
      const missing = await postOverride(baseUrl, 77, {});
      const notEmail = await postOverride(baseUrl, 77, { approverEmail: "not-an-email" });
      expect(missing.status).toBe(422);
      expect(notEmail.status).toBe(422);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 400 for a non-numeric :id", async () => {
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, "abc", { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(400);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("the atomic claim rejects a concurrent override with 409 (no double-create)", async () => {
    // Hold the winner's background approval open so its claim stays held across both requests
    // (in production the Playwright run takes minutes; the loser must see the claim still held).
    let release!: () => void;
    const gate = new Promise<{ success: boolean }>((resolve) => {
      release = () => resolve({ success: true });
    });
    processRfpApprovalMock.mockReturnValue(gate as any);

    await withServer(async (baseUrl) => {
      const [a, b] = await Promise.all([
        postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" }),
        postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" }),
      ]);
      // Exactly one wins the claim (202); the other loses it (409). Only one Playwright creation runs.
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      await vi.waitFor(() => expect(processRfpApprovalMock).toHaveBeenCalledTimes(1));
      release();
    });
  });

  it("a failed claim (lost race / no longer declined) returns 409 without invoking approval", async () => {
    claimState.claimed = true; // someone else already claimed it
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(409);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 202 (in-progress, not 409) for a duplicate override of a request already claimed", async () => {
    requestFixture.current = declinedRequest({ status: "override_approving" });
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(202);
      expect(res.body.message).toMatch(/already in progress/i);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });

  it("returns 409 synchronously when the source deal is no longer eligible (no silent background cancel)", async () => {
    eligibility.current = { eligible: false, reason: "Source CRM deal is no longer in Opportunity stage" };
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, { approverEmail: "ashaw@trockgc.com" });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain("Opportunity");
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });
});
