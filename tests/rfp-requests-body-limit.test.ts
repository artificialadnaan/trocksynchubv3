import crypto from "crypto";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TRK-2607-H3X6. The 100 KB global-parser skip was added for /api/bid-board/create-from-rfp only
 * (32713d4, b71b172), but POST /api/rfp-requests carries the SAME normalized body with the SAME
 * per-file attachment list. It already mounts the scoped 10mb route parser — the global parser just
 * ran first and 413'd it, before the HMAC check, so a file-heavy deal's RFP trigger died with a
 * masked "Internal server error" and the deal never advanced to service_estimating.
 *
 * Verified against production 2026-07-28 with a 200 KB unsigned body:
 *   /api/bid-board/create-from-rfp -> 401 (parsed, reached the signature check)
 *   /api/rfp-requests             -> 413 (rejected at the parser)
 */

vi.mock("../server/sync/bidboard-create-worker.ts", () => ({
  enqueueBidboardCreateCommand: vi.fn(async () => {}),
}));
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

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const { registerRfpRequestRoutes } = await import("../server/routes/rfp-requests.ts");
  const { mountJsonBodyParsers } = await import("../server/json-body.ts");
  const app = express();
  // The REAL production parser config, so this test fails if the skip list regresses.
  mountJsonBodyParsers(app);
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

/** A body well past body-parser's 100 KB default — the shape a photo-heavy deal produced. */
function oversizedBody(): string {
  return JSON.stringify({
    sourceSystem: "trock_crm",
    sourceDealId: "crm-deal-1",
    sourceEventId: "crm:deal-stage:opportunity:evt-1",
    deal: {
      name: "Sunrise Medical Center", projectNumber: "25-1234", projectType: "9",
      amount: 482000, estimator: null, companyName: null, contactName: null,
      clientEmail: null, clientPhone: null, address: null, description: null,
      dueDate: null, workflowRoute: "service",
    },
    attachments: Array.from({ length: 300 }, (_, i) => ({
      name: `Drawing ${i}.pdf`,
      url: `https://r2.example.com/office_trock/deals/25-1234/documents/file-${i}.pdf?X-Amz-Signature=${"a".repeat(512)}`,
      contentType: "application/pdf",
    })),
  });
}

describe("POST /api/rfp-requests body limit", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RFP_REQUEST_SYNC_SECRET = SECRET;
  });

  it("parses a body far larger than the 100 KB global default instead of 413ing at the parser", async () => {
    const body = oversizedBody();
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);

    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/rfp-requests`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Deliberately WRONG signature: reaching the 401 proves the body was parsed and the
          // request got as far as the HMAC check, which is exactly what the 413 used to prevent.
          "x-rfp-request-signature": "sha256=deadbeef",
        },
        body,
      });
      return res.status;
    });

    expect(status).toBe(401);
    expect(status).not.toBe(413);
  });

  it("still verifies the HMAC over the exact bytes of a large body", async () => {
    const body = oversizedBody();
    const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;

    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/rfp-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": signature },
        body,
      });
      return res.status;
    });

    // Past the signature gate (the mocked approval layer decides what happens next) — the point is
    // that a correctly-signed large body is no longer rejected as unauthorized or oversized.
    expect(status).not.toBe(413);
    expect(status).not.toBe(401);
  });
});
