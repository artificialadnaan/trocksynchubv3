import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

const mockStorage = {
  checkIdempotencyKey: vi.fn(),
  createIdempotencyKey: vi.fn(),
  createWebhookLog: vi.fn(),
  updateWebhookLog: vi.fn(),
  createAuditLog: vi.fn(),
  createBidboardAutomationLog: vi.fn(),
  getAutomationConfig: vi.fn(),
  getProcoreProjectByProcoreId: vi.fn(),
  upsertProcoreProject: vi.fn(),
  getSyncMappingByProcoreProjectId: vi.fn(),
  getSyncMappingByHubspotDealId: vi.fn(),
  getHubspotDealByHubspotId: vi.fn(),
};

vi.mock("../server/storage.ts", () => ({ storage: mockStorage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

vi.mock("../server/procore-rate-limiter.ts", () => ({
  markProjectWebhookUpdated: vi.fn(),
}));

vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn().mockResolvedValue({ synced: 0, newAssignments: [] }),
  fetchProcoreProjectDetail: vi.fn(),
}));

vi.mock("../server/hubspot.ts", () => ({
  updateHubSpotDealStage: vi.fn(),
  syncSingleHubSpotDeal: vi.fn(),
}));

vi.mock("../server/email-notifications.ts", () => ({
  sendStageChangeEmail: vi.fn(),
  sendRoleAssignmentEmails: vi.fn().mockResolvedValue({ sent: 0, skipped: 0, failed: 0 }),
  triggerKickoffForNewPmOnPortfolio: vi.fn().mockResolvedValue({ triggered: 0, failed: 0 }),
}));

vi.mock("../server/stage-notifications.ts", () => ({
  processStageNotification: vi.fn(),
}));

vi.mock("../server/procore-hubspot-sync.ts", () => ({
  mapProcoreStageToHubspot: vi.fn(),
  resolveHubspotStageId: vi.fn(),
  findOrCreateMappingByProjectNumber: vi.fn(),
  getTerminalStageGuard: vi.fn(),
}));

vi.mock("../server/orchestrator/portfolio-orchestrator.ts", () => ({
  takeNextPendingPhase2: vi.fn().mockResolvedValue(null),
  markPhase2Complete: vi.fn(),
  markPhase2Failed: vi.fn(),
}));

vi.mock("../server/project-archive.ts", () => ({
  handleProjectStageChange: vi.fn().mockResolvedValue({ triggered: false }),
}));

vi.mock("../server/closeout-automation.ts", () => ({
  isProcoreClosedStage: vi.fn().mockReturnValue(false),
  triggerCloseoutSurvey: vi.fn(),
}));

vi.mock("../server/hubspot-procore-sync.ts", () => ({
  processHubspotWebhookForProcore: vi.fn(),
}));

vi.mock("../server/deal-project-number.ts", () => ({
  processNewDealWebhook: vi.fn(),
}));

vi.mock("../server/hubspot-bidboard-trigger.ts", () => ({
  processDealStageChange: vi.fn(),
}));

async function postProcoreWebhook(body: Record<string, unknown>): Promise<Response> {
  const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/procore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await vi.waitFor(() => {
      expect(mockStorage.updateWebhookLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "processed" }),
      );
    });
    return response;
  } finally {
    server.close();
  }
}

describe("Procore project-stage webhook migration-mode suppression", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();

    const { fetchProcoreProjectDetail } = await import("../server/procore.ts");
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");
    const { processStageNotification } = await import("../server/stage-notifications.ts");
    const { mapProcoreStageToHubspot, resolveHubspotStageId, getTerminalStageGuard } = await import("../server/procore-hubspot-sync.ts");

    mockStorage.checkIdempotencyKey.mockResolvedValue(false);
    mockStorage.createWebhookLog.mockResolvedValue({ id: 101 });
    mockStorage.updateWebhookLog.mockResolvedValue({});
    mockStorage.createIdempotencyKey.mockResolvedValue({});
    mockStorage.createAuditLog.mockResolvedValue({});
    mockStorage.createBidboardAutomationLog.mockResolvedValue({});
    mockStorage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "procore_webhook_processing") return { key, value: { enabled: true } };
      if (key === "procore_hubspot_stage_sync") return { key, value: { enabled: true } };
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-webhook-test",
          },
        };
      }
      return undefined;
    });
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({
      procoreId: "598134326587649",
      companyId: "598134325683880",
      name: "Canary Project",
      projectNumber: "DFW-1-12126-ad",
      stage: "Bidding",
      projectStageName: "Bidding",
      properties: {},
      active: true,
    });
    mockStorage.upsertProcoreProject.mockResolvedValue({});
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      id: 501,
      procoreProjectId: "598134326587649",
      procoreProjectName: "Canary Project",
      hubspotDealId: "323528245957",
      hubspotDealName: "Canary Deal",
    });
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({ dealName: "Canary Deal" });

    vi.mocked(fetchProcoreProjectDetail).mockResolvedValue({
      project_stage: { name: "Buy Out" },
      name: "Canary Project",
      project_number: "DFW-1-12126-ad",
    } as any);
    vi.mocked(updateHubSpotDealStage).mockResolvedValue({ success: true, message: "updated" } as any);
    vi.mocked(sendStageChangeEmail).mockResolvedValue({ sent: true, ownerEmail: "owner@example.com" });
    vi.mocked(processStageNotification).mockResolvedValue({ sent: 1, skipped: false, route: "portfolio_buyout" });
    vi.mocked(mapProcoreStageToHubspot).mockReturnValue("Closed Won");
    vi.mocked(resolveHubspotStageId).mockResolvedValue({ stageId: "closedwon", stageName: "Closed Won" });
    vi.mocked(getTerminalStageGuard).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses HubSpot writes and stage notifications under Bid Board migration mode", async () => {
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");
    const { processStageNotification } = await import("../server/stage-notifications.ts");

    const response = await postProcoreWebhook({
      id: "evt-migration",
      resource_name: "projects",
      event_type: "update",
      resource_id: "598134326587649",
      project_id: "598134326587649",
      company_id: "598134325683880",
    });

    expect(response.status).toBe(200);
    expect(mockStorage.upsertProcoreProject).toHaveBeenCalledWith(expect.objectContaining({
      stage: "Buy Out",
      projectStageName: "Buy Out",
    }));
    expect(vi.mocked(updateHubSpotDealStage)).not.toHaveBeenCalled();
    expect(vi.mocked(sendStageChangeEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(processStageNotification)).not.toHaveBeenCalled();
    expect(mockStorage.createBidboardAutomationLog).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "598134326587649",
      projectName: "Canary Project",
      action: "procore_webhook:suppressed_hubspot_write",
      status: "suppressed",
      details: expect.objectContaining({
        cycleId: "cycle-webhook-test",
        previousStage: "Bidding",
        newStage: "Buy Out",
        wouldHaveAction: "hubspot_stage_update",
        targetValue: "Closed Won",
        hubspotDealId: "323528245957",
        mappingSource: "sync_mappings",
        mode: "migration",
        projectNumber: "DFW-1-12126-ad",
      }),
    }));
    expect(mockStorage.createBidboardAutomationLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "procore_webhook:suppressed_stage_notification",
      status: "suppressed",
      details: expect.objectContaining({
        wouldHaveAction: "send_stage_change_email",
        targetValue: "Closed Won",
      }),
    }));
    expect(mockStorage.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "webhook_stage_change_processed",
      details: expect.objectContaining({
        hubspotUpdateSuppressed: true,
        emailSuppressed: true,
      }),
    }));
  });

  it("fires HubSpot writes and stage notifications normally outside migration suppression", async () => {
    const { updateHubSpotDealStage } = await import("../server/hubspot.ts");
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");
    const { processStageNotification } = await import("../server/stage-notifications.ts");

    mockStorage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "procore_webhook_processing") return { key, value: { enabled: true } };
      if (key === "procore_hubspot_stage_sync") return { key, value: { enabled: true } };
      if (key === "bidboard_stage_sync") return { key, value: { mode: "live", suppressHubSpotWrites: false, suppressStageNotifications: false } };
      return undefined;
    });

    const response = await postProcoreWebhook({
      id: "evt-live",
      resource_name: "projects",
      event_type: "update",
      resource_id: "598134326587649",
      project_id: "598134326587649",
      company_id: "598134325683880",
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(updateHubSpotDealStage)).toHaveBeenCalledWith("323528245957", "closedwon");
    expect(vi.mocked(sendStageChangeEmail)).toHaveBeenCalledWith(expect.objectContaining({
      hubspotDealId: "323528245957",
      oldStage: "Bidding",
      newStage: "Buy Out",
      hubspotStageName: "Closed Won",
    }));
    expect(vi.mocked(processStageNotification)).toHaveBeenCalledWith(expect.objectContaining({
      stage: "Buy Out",
      source: "portfolio",
      oldStage: "Bidding",
      procoreProjectId: "598134326587649",
      hubspotDealId: "323528245957",
    }));
    expect(mockStorage.createBidboardAutomationLog).not.toHaveBeenCalledWith(expect.objectContaining({
      action: expect.stringContaining("suppressed"),
    }));
  });

  it("suppresses HubSpot webhook stage-change emails under Bid Board migration mode", async () => {
    const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");
    const { processDealStageChange } = await import("../server/hubspot-bidboard-trigger.ts");

    mockStorage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "hubspot_webhook_processing") return { key, value: { enabled: true } };
      if (key === "bidboard_stage_sync") {
        return {
          key,
          value: {
            mode: "migration",
            suppressHubSpotWrites: true,
            suppressStageNotifications: true,
            logSuppressedActions: true,
            cycleId: "cycle-hubspot-webhook-test",
          },
        };
      }
      return undefined;
    });
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({
      dealName: "HubSpot Canary Deal",
      dealStageName: "Proposal Sent",
    });
    mockStorage.getSyncMappingByHubspotDealId.mockResolvedValue({
      hubspotDealId: "323528245957",
      procoreProjectId: "598134326587649",
      procoreProjectName: "Canary Project",
    });

    const app = express();
    app.use(express.json());
    registerWebhookRoutes(app);
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "hs-event-1",
          subscriptionType: "deal.propertyChange",
          objectType: "deal",
          objectId: "323528245957",
          propertyName: "dealstage",
          propertyValue: "closedwon",
          changeSource: "CRM_UI",
        }),
      });
      await vi.waitFor(() => {
        expect(mockStorage.updateWebhookLog).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ status: "processed" }),
        );
      });

      expect(response.status).toBe(200);
      expect(vi.mocked(processDealStageChange)).toHaveBeenCalledWith("323528245957", "closedwon");
      expect(vi.mocked(sendStageChangeEmail)).not.toHaveBeenCalled();
      expect(mockStorage.createBidboardAutomationLog).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "598134326587649",
        projectName: "Canary Project",
        action: "hubspot_webhook:suppressed_stage_notification",
        status: "suppressed",
        details: expect.objectContaining({
          cycleId: "cycle-hubspot-webhook-test",
          previousStage: "Proposal Sent",
          newStage: "Closed Won",
          wouldHaveAction: "send_stage_change_email",
          targetValue: "Closed Won",
          hubspotDealId: "323528245957",
          mappingSource: "sync_mappings",
          mode: "migration",
        }),
      }));
    } finally {
      server.close();
    }
  });
});
