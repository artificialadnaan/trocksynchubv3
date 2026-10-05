import express from "express";
import { mountJsonBodyParsers } from "../server/json-body";
import { procoreAuthHeaders, TEST_PROCORE_WEBHOOK_SECRET } from "./helpers/webhook-signing";
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

// T-Rock no longer uses HubSpot (owner, 2026-10-04): /webhooks/hubspot is a hard-disabled 410 stub. Whatever is sent
// — signed or not, a real RFP stage event or garbage — nothing is read, logged, deduped or processed.
describe("the retired HubSpot webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["a real RFP stage event", JSON.stringify({ eventId: "event-1", subscriptionType: "deal.propertyChange", objectType: "deal", objectId: "hubspot-deal-1", propertyName: "dealstage", propertyValue: "rfp" })],
    ["an empty body", ""],
    ["garbage", "not json at all"],
  ])("answers 410 Gone to %s and touches nothing", async (_label, body) => {
    const { storage } = await import("../server/storage.ts");
    await withWebhookServer(async (base) => {
      const res = await fetch(`${base}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hubspot-signature-v3": "anything", "x-hubspot-request-timestamp": String(Date.now()) },
        body,
      });
      // "not json" is refused by the JSON parser before any route (400), which is equally inert.
      expect([410, 400]).toContain(res.status);
      if (body !== "not json at all") expect(res.status).toBe(410);
    });
    for (const fn of Object.values(storage) as any[]) expect(fn).not.toHaveBeenCalled();
    expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("needs no HubSpot secret: the route is 410 with HUBSPOT_CLIENT_SECRET unset (no 503)", async () => {
    delete process.env.HUBSPOT_CLIENT_SECRET;
    await withWebhookServer(async (base) => {
      expect((await fetch(`${base}/webhooks/hubspot`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(410);
    });
  });
});

describe("inbound Procore webhook authentication", () => {
  beforeEach(() => {
    process.env.PROCORE_WEBHOOK_SECRET = TEST_PROCORE_WEBHOOK_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PROCORE_WEBHOOK_SECRET;
  });
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

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
