import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import crypto from "crypto";

// Endpoint behavior of POST /api/rfp-requests/:id/override-approve — HMAC auth + guards + 202.
// Mirrors the HMAC harness in tests/rfp-requests-endpoint.test.ts; mocks storage + rfp-approval.

const requestFixture = vi.hoisted(() => ({ current: undefined as any }));
const processRfpApprovalMock = vi.hoisted(() => vi.fn(async () => ({ success: true, bidboardProjectId: "BB-1" })));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getRfpApprovalRequestById: vi.fn(async (_id: number) => requestFixture.current),
  },
}));

vi.mock("../server/rfp-approval.ts", () => ({
  processRfpApproval: processRfpApprovalMock,
  createRfpApprovalRequestFromNormalizedInput: vi.fn(),
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

  it("returns 422 when approverEmail is missing", async () => {
    await withServer(async (baseUrl) => {
      const res = await postOverride(baseUrl, 77, {});
      expect(res.status).toBe(422);
      expect(processRfpApprovalMock).not.toHaveBeenCalled();
    });
  });
});
