import express from "express";
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
  app.use(express.json());
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

  afterEach(() => {
    delete process.env.HUBSPOT_RFP_TRIGGER_ENABLED;
  });

  it("defaults to enabled when HUBSPOT_RFP_TRIGGER_ENABLED is missing", async () => {
    await withWebhookServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hubspotRfpEvent()),
      });

      expect(response.status).toBe(200);
      expect(createRfpApprovalRequestMock).toHaveBeenCalledWith("hubspot-deal-1");
    });
  });

  it("returns 200 and skips RFP creation when HUBSPOT_RFP_TRIGGER_ENABLED=false", async () => {
    process.env.HUBSPOT_RFP_TRIGGER_ENABLED = "false";

    await withWebhookServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hubspotRfpEvent()),
      });

      expect(response.status).toBe(200);
      expect(createRfpApprovalRequestMock).not.toHaveBeenCalled();
    });
  });
});
