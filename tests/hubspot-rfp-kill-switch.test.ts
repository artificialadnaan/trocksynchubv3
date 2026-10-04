import express from "express";
import { mountJsonBodyParsers } from "../server/json-body";
import { hubspotV3Headers, procoreAuthHeaders, TEST_HUBSPOT_CLIENT_SECRET, TEST_PROCORE_WEBHOOK_SECRET } from "./helpers/webhook-signing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createRfpApprovalRequestMock = vi.hoisted(() => vi.fn(async () => ({ success: true, token: "token-1" })));

vi.mock("../server/db.ts", () => ({
  db: {
    select: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    checkIdempotencyKey: vi.fn(async () => false),
    createWebhookLog: vi.fn(async () => ({ id: 1 })),
    createIdempotencyKey: vi.fn(async () => ({ id: 1 })),
    deleteIdempotencyKey: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async () => ({ id: 1 })),
    updateWebhookLog: vi.fn(async () => ({ id: 1 })),
    getAutomationConfig: vi.fn(async () => ({ value: { enabled: true } })),
    getHubspotDealByHubspotId: vi.fn(async () => null),
    getSyncMappingByHubspotDealId: vi.fn(async () => null),
    getHubspotPipelines: vi.fn(async () => []),
  },
}));

vi.mock("../server/rfp-approval.ts", () => ({
  createRfpApprovalRequest: createRfpApprovalRequestMock,
}));

vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
}));

vi.mock("../server/hubspot.ts", () => ({
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
  syncSingleHubSpotContact: vi.fn(),
  syncSingleHubSpotCompany: vi.fn(),
}));

vi.mock("../server/email-notifications.ts", () => ({
  sendStageChangeEmail: vi.fn(),
}));

vi.mock("../server/deal-project-number.ts", () => ({
  processNewDealWebhook: vi.fn(),
}));

vi.mock("../server/hubspot-procore-sync.ts", () => ({
  processHubspotWebhookForProcore: vi.fn(),
  mapProcoreStageToHubspot: vi.fn(),
  resolveHubspotStageId: vi.fn(async () => ({ stageName: "RFP", stageId: "rfp" })),
  findOrCreateMappingByProjectNumber: vi.fn(),
  getTerminalStageGuard: vi.fn(),
}));

vi.mock("../server/webhooks/procore-webhook.ts", () => ({
  handleProcoreProjectWebhook: vi.fn((_req, res) => res.status(200).json({ received: true })),
}));

vi.mock("../server/webhooks/migration-mode.ts", () => ({
  evaluateWebhookPortfolioPhase2Gate: vi.fn(),
  getWebhookMigrationModeConfig: vi.fn(async () => ({ enabled: false })),
  isMigrationMode: vi.fn(() => false),
  logWebhookSuppressedAction: vi.fn(),
}));

vi.mock("../server/routes/settings.ts", () => ({
  recordWebhookRoleEvent: vi.fn(),
}));

vi.mock("../server/procore-rate-limiter.ts", () => ({
  markProjectWebhookUpdated: vi.fn(),
}));

async function withWebhookServer<T>(fn: (baseUrl: string) => Promise<T>) {
  const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
  const app = express();
  mountJsonBodyParsers(app); // the production parser: it keeps req.rawBody for the signature check
  registerWebhookRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Webhook test server did not bind");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function hubspotRfpEvent() {
  return {
    eventId: "event-1",
    subscriptionType: "deal.propertyChange",
    eventType: "deal.propertyChange",
    objectType: "deal",
    objectId: "hubspot-deal-1",
    propertyName: "dealstage",
    propertyValue: "rfp",
    changeSource: "INTEGRATION",
  };
}

describe("HubSpot RFP trigger kill switch", () => {
  beforeEach(() => {
    vi.resetModules();
    createRfpApprovalRequestMock.mockClear();
    delete process.env.HUBSPOT_RFP_TRIGGER_ENABLED;
  });

  beforeEach(() => {
    process.env.HUBSPOT_CLIENT_SECRET = TEST_HUBSPOT_CLIENT_SECRET;
  });

  afterEach(() => {
    delete process.env.HUBSPOT_RFP_TRIGGER_ENABLED;
    delete process.env.HUBSPOT_CLIENT_SECRET;
  });

  it("defaults to enabled when HUBSPOT_RFP_TRIGGER_ENABLED is missing", async () => {
    await withWebhookServer(async (baseUrl) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const response = await fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hubspotV3Headers(baseUrl, "/webhooks/hubspot", body) },
        body,
      });

      expect(response.status).toBe(200);
      expect(createRfpApprovalRequestMock).toHaveBeenCalledWith("hubspot-deal-1");
    });
  });

  it("returns 200 and skips RFP creation when HUBSPOT_RFP_TRIGGER_ENABLED=false", async () => {
    process.env.HUBSPOT_RFP_TRIGGER_ENABLED = "false";

    await withWebhookServer(async (baseUrl) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const response = await fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hubspotV3Headers(baseUrl, "/webhooks/hubspot", body) },
        body,
      });

      expect(response.status).toBe(200);
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    });
  });
});

// Security audit P1 (2026-10-04): the webhooks verified only `if (secret)` and `if (signature)`, so a request with no
// header (or any request while the secret was unset) was accepted. They now fail closed.
describe("inbound webhook authentication", () => {
  beforeEach(() => {
    process.env.HUBSPOT_CLIENT_SECRET = TEST_HUBSPOT_CLIENT_SECRET;
    process.env.PROCORE_WEBHOOK_SECRET = TEST_PROCORE_WEBHOOK_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.HUBSPOT_CLIENT_SECRET;
    delete process.env.PROCORE_WEBHOOK_SECRET;
    delete process.env.APP_URL;
  });
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("HubSpot: no secret configured is 503, never accepted unverified", async () => {
    delete process.env.HUBSPOT_CLIENT_SECRET;
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const res = await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body));
      expect(res.status).toBe(503);
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    });
  });

  it("HubSpot: a request with NO signature, a wrong one, or a tampered body is 401 and does nothing", async () => {
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const signed = hubspotV3Headers(base, "/webhooks/hubspot", body);
      expect((await post(`${base}/webhooks/hubspot`, body)).status).toBe(401);
      expect((await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body, { secret: "wrong" }))).status).toBe(401);
      const tampered = body.replace("hubspot-deal-1", "hubspot-deal-2");
      expect((await post(`${base}/webhooks/hubspot`, tampered, signed)).status).toBe(401);
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    });
  });

  it("HubSpot: a timestamp more than 5 minutes off is refused (replay window)", async () => {
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      for (const ts of [Date.now() - 6 * 60_000, Date.now() + 6 * 60_000]) {
        const res = await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body, { timestamp: ts }));
        expect(res.status).toBe(401);
      }
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    });
  });

  it("HubSpot: the RAW bytes are verified (whitespace HubSpot sent is not re-serialised away)", async () => {
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent(), null, 2);
      const res = await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body));
      expect(res.status).toBe(200);
      expect(createRfpApprovalRequestMock).toHaveBeenCalledWith("hubspot-deal-1");
    });
  });

  it("HubSpot: behind a proxy the signed URI is APP_URL's origin plus the path", async () => {
    process.env.APP_URL = "https://synchub.example.test/";
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const ts = String(Date.now());
      const crypto = await import("node:crypto");
      const sig = crypto.createHmac("sha256", TEST_HUBSPOT_CLIENT_SECRET)
        .update("POST" + "https://synchub.example.test/webhooks/hubspot" + body + ts).digest("base64");
      const res = await post(`${base}/webhooks/hubspot`, body, { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts });
      expect(res.status).toBe(200);
    });
  });

  it("HubSpot: a redelivery of one event dedupes on its stable identity (no Date.now(), no attemptNumber in the key)", async () => {
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.checkIdempotencyKey).mockClear();
    const delivery = { ...hubspotRfpEvent(), portalId: 45644695, subscriptionId: 77, occurredAt: 1759600000000 };
    await withWebhookServer(async (base) => {
      for (const attemptNumber of [0, 1]) {
        const body = JSON.stringify({ ...delivery, attemptNumber });
        await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body));
      }
    });
    const keys = vi.mocked(storage.checkIdempotencyKey).mock.calls.map((c) => c[0]);
    expect(keys).toEqual([
      "hs_event-1_45644695_77_hubspot-deal-1_deal.propertyChange_1759600000000",
      "hs_event-1_45644695_77_hubspot-deal-1_deal.propertyChange_1759600000000",
    ]);
  });

  it("HubSpot: two different events that reuse an eventId get different keys (HubSpot does not guarantee it unique)", async () => {
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.checkIdempotencyKey).mockClear();
    const base0 = { ...hubspotRfpEvent(), portalId: 45644695, subscriptionId: 77, occurredAt: 1759600000000 };
    await withWebhookServer(async (base) => {
      const body = JSON.stringify([base0, { ...base0, objectId: "hubspot-deal-2" }, { ...base0, subscriptionId: 78 }]);
      await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body));
    });
    const keys = vi.mocked(storage.checkIdempotencyKey).mock.calls.map((c) => c[0]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("HubSpot: an uncaught processing failure answers 500 and releases the key, so HubSpot's retry runs the event", async () => {
    const { storage } = await import("../server/storage.ts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(storage.deleteIdempotencyKey).mockClear();
    createRfpApprovalRequestMock.mockClear();
    vi.mocked(storage.getAutomationConfig).mockRejectedValueOnce(new Error("connection reset"));
    const event = { ...hubspotRfpEvent(), portalId: 45644695, subscriptionId: 77, occurredAt: 1759600000000 };
    const key = "hs_event-1_45644695_77_hubspot-deal-1_deal.propertyChange_1759600000000";
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(event);
      const first = await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body));
      expect(first.status).toBe(500);
      expect(storage.createIdempotencyKey).toHaveBeenCalledWith(expect.objectContaining({ key }));
      expect(storage.deleteIdempotencyKey).toHaveBeenCalledWith(key);
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();

      // The retry (key released, so not found) runs the event.
      const retry = JSON.stringify({ ...event, attemptNumber: 1 });
      const second = await post(`${base}/webhooks/hubspot`, retry, hubspotV3Headers(base, "/webhooks/hubspot", retry));
      expect(second.status).toBe(200);
      expect(createRfpApprovalRequestMock).toHaveBeenCalledWith("hubspot-deal-1");
    });
  });

  it("HubSpot: a processed event keeps its key (only a failure releases it)", async () => {
    const { storage } = await import("../server/storage.ts");
    vi.mocked(storage.deleteIdempotencyKey).mockClear();
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      expect((await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body))).status).toBe(200);
    });
    expect(storage.deleteIdempotencyKey).not.toHaveBeenCalled();
  });

  it("HubSpot: the signed URI has HubSpot's v3 escapes decoded, and every other escape left encoded", async () => {
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      const sent = "/webhooks/hubspot?a=x%2Fy%3Az%28%29&b=one%20two%26three";
      const signedByHubSpot = "/webhooks/hubspot?a=x/y:z()&b=one%20two%26three";
      expect((await post(`${base}${sent}`, body, hubspotV3Headers(base, signedByHubSpot, body))).status).toBe(200);
      // Signing the raw (still-encoded) URI is NOT what HubSpot does, so it must not verify.
      expect((await post(`${base}${sent}`, body, hubspotV3Headers(base, sent, body))).status).toBe(401);
      // Fully decoding the query is not it either: %20 and %26 stay encoded.
      expect((await post(`${base}${sent}`, body, hubspotV3Headers(base, decodeURIComponent(sent), body))).status).toBe(401);
    });
  });

  it("decodeHubSpotV3Uri decodes exactly HubSpot's twelve characters, case-insensitively", async () => {
    const { decodeHubSpotV3Uri } = await import("../server/webhooks/signature.ts");
    expect(decodeHubSpotV3Uri("/p%3A%2F%3F%40%21%24%27%28%29%2A%2C%3B")).toBe("/p:/?@!$'()*,;");
    expect(decodeHubSpotV3Uri("/p%3a%2f")).toBe("/p:/");
    expect(decodeHubSpotV3Uri("/p%20%26%3D%2B%25%23")).toBe("/p%20%26%3D%2B%25%23");
  });

  it("the test signer uses APP_URL's origin when it is set, as the verifier does", async () => {
    process.env.APP_URL = "https://synchub.example.test/";
    await withWebhookServer(async (base) => {
      const body = JSON.stringify(hubspotRfpEvent());
      expect((await post(`${base}/webhooks/hubspot`, body, hubspotV3Headers(base, "/webhooks/hubspot", body))).status).toBe(200);
    });
  });

  it.each(["/webhooks/procore", "/webhooks/procore/project-events"])(
    "Procore %s: no secret is 503; no or wrong token is 401; the configured Bearer token passes",
    async (path) => {
      const { handleProcoreProjectWebhook } = await import("../server/webhooks/procore-webhook.ts");
      await withWebhookServer(async (base) => {
        const body = JSON.stringify({ resource_name: "Projects", resource_type: "Projects", resource_id: 1, event_type: "update", id: 1 });
        delete process.env.PROCORE_WEBHOOK_SECRET;
        expect((await post(`${base}${path}`, body, procoreAuthHeaders())).status).toBe(503);
        process.env.PROCORE_WEBHOOK_SECRET = TEST_PROCORE_WEBHOOK_SECRET;
        expect((await post(`${base}${path}`, body)).status).toBe(401);
        expect((await post(`${base}${path}`, body, procoreAuthHeaders("wrong-token"))).status).toBe(401);
        if (path.endsWith("project-events")) {
          expect(handleProcoreProjectWebhook).not.toHaveBeenCalled();
          expect((await post(`${base}${path}`, body, procoreAuthHeaders())).status).toBe(200);
          expect(handleProcoreProjectWebhook).toHaveBeenCalledTimes(1);
        } else {
          expect((await post(`${base}${path}`, body, procoreAuthHeaders())).status).not.toBe(401);
        }
      });
    },
  );
});
