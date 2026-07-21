import crypto from "crypto";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// After the V1–V4 rebuild the endpoint is thin: verify sig -> parse -> sourceSystem guard -> PERSIST a durable
// create command (before the 202) -> 202. The actual create/callback runs in the serial bidboard-create worker
// (tested in bidboard-create-worker.test.ts). This test covers the endpoint's own responsibilities.
const enqueueCommandMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../server/sync/bidboard-create-worker.ts", () => ({
  enqueueBidboardCreateCommand: enqueueCommandMock,
}));
// rfp-requests still imports these for its OTHER routes; cut the chain to db.ts (throws without DATABASE_URL).
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/rfp-approval.ts", () => ({
  createRfpApprovalRequestFromNormalizedInput: vi.fn(),
  processRfpApproval: vi.fn(),
  checkRfpApprovalSourceEligibility: vi.fn(),
}));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotClient: vi.fn(), getAccessToken: vi.fn(),
  getDealOwnerInfo: vi.fn(async () => ({ ownerName: "", ownerEmail: "" })),
  updateHubSpotDeal: vi.fn(), updateHubSpotDealStage: vi.fn(), syncSingleHubSpotDeal: vi.fn(),
}));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })), renderTemplate: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ resolveHubspotStageId: vi.fn() }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const SECRET = "rfp-secret";

function requestBody(overrides: Partial<any> = {}) {
  return {
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    sourceEventId: "crm:rfp-vote:approved:round-1",
    decision: "approved",
    deal: {
      name: "jasonn ranches", projectNumber: "TR-1001", projectType: "9", amount: 100000, estimator: null,
      companyName: "Acme", contactName: "Jane", clientEmail: "jane@acme.com", clientPhone: null,
      address: { street: "1 Main", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: null, dueDate: null, workflowRoute: "normal",
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

describe("POST /api/bid-board/create-from-rfp (endpoint)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RFP_REQUEST_SYNC_SECRET = SECRET;
    process.env.TROCK_CRM_BASE_URL = "https://crm.example.com";
    enqueueCommandMock.mockReset();
    enqueueCommandMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.RFP_REQUEST_SYNC_SECRET;
    delete process.env.TROCK_CRM_BASE_URL;
  });

  it("401 on a bad signature (no command enqueued)", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": "sha256=deadbeef" }, body: raw,
      });
      expect(res.status).toBe(401);
      expect(enqueueCommandMock).not.toHaveBeenCalled();
    });
  });

  it("422 (no command) when sourceSystem is not trock_crm (contract-safe, not 409)", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody({ sourceSystem: "hubspot" }));
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      // finding: the CRM delivery job's contract is 401/500/422/202 — an unsupported sourceSystem is a validation
      // failure (422), not a 409 the caller would treat as an unhandled conflict.
      expect(res.status).toBe(422);
      expect(enqueueCommandMock).not.toHaveBeenCalled();
    });
  });

  it("422 (no command) on an invalid body", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody({ decision: "rejected" }));
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      expect(res.status).toBe(422);
      expect(enqueueCommandMock).not.toHaveBeenCalled();
    });
  });

  it("persists the create command BEFORE the 202 (finding V3), keyed by the validated input", async () => {
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      expect(res.status).toBe(202);
      expect(enqueueCommandMock).toHaveBeenCalledTimes(1);
      const cmd = enqueueCommandMock.mock.calls[0][0] as any;
      expect(cmd.sourceSystem).toBe("trock_crm");
      expect(cmd.sourceDealId).toBe("crm-deal-1");
      expect(cmd.sourceEventId).toBe("crm:rfp-vote:approved:round-1");
      expect(cmd.deal.projectNumber).toBe("TR-1001");
    });
  });

  it("accepts a LARGE attachments body (raised limit) instead of 413ing the Bid Board create", async () => {
    await withServer(async (baseUrl) => {
      // A project with hundreds of files: the inline attachments list pushes the body well past
      // body-parser's 100 KB default. Before the raised limit this 413'd BEFORE the handler ran, permanently
      // stranding the create (the real incident on a 637-file deal).
      const attachments = Array.from({ length: 400 }, (_, i) => ({
        name: `document-${i}.pdf`,
        url: `https://r2.example.com/office_dallas/deal-1/file-${i}.pdf?X-Amz-Signature=${"a".repeat(400)}`,
        contentType: "application/pdf",
      }));
      const raw = JSON.stringify(requestBody({ attachments }));
      expect(raw.length).toBeGreaterThan(150_000); // comfortably past the old 100 KB cap
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      expect(res.status).toBe(202); // NOT 413
      expect(enqueueCommandMock).toHaveBeenCalledTimes(1);
    });
  });

  it("500 (not 202) when the command can't be persisted — so the CRM retries instead of losing the vote", async () => {
    enqueueCommandMock.mockRejectedValueOnce(new Error("db down"));
    await withServer(async (baseUrl) => {
      const raw = JSON.stringify(requestBody());
      const res = await fetch(`${baseUrl}/api/bid-board/create-from-rfp`, {
        method: "POST", headers: { "content-type": "application/json", "x-rfp-request-signature": sign(raw) }, body: raw,
      });
      expect(res.status).toBe(500);
    });
  });
});
