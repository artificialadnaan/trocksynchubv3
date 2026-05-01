import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
  },
  runBidBoardPolling: vi.fn(),
  getAutomationStatus: vi.fn(),
  enableBidBoardAutomation: vi.fn(),
  manualSyncProject: vi.fn(),
  onBidBoardProjectCreated: vi.fn(),
  detectAndProcessNewProjects: vi.fn(),
  syncHubSpotClientToBidBoard: vi.fn(),
  runBidBoardStageSync: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/bidboard-automation.ts", () => ({
  runBidBoardPolling: mocks.runBidBoardPolling,
  getAutomationStatus: mocks.getAutomationStatus,
  enableBidBoardAutomation: mocks.enableBidBoardAutomation,
  manualSyncProject: mocks.manualSyncProject,
  onBidBoardProjectCreated: mocks.onBidBoardProjectCreated,
  detectAndProcessNewProjects: mocks.detectAndProcessNewProjects,
}));
vi.mock("../server/playwright/bidboard.ts", () => ({
  syncHubSpotClientToBidBoard: mocks.syncHubSpotClientToBidBoard,
}));
vi.mock("../server/sync", () => ({ runBidBoardStageSync: mocks.runBidBoardStageSync }));
vi.mock("../server/hubspot.ts", () => ({
  updateHubSpotDealStage: vi.fn(),
  runFullHubSpotSync: vi.fn(),
}));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: vi.fn(),
}));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ triggerPostSyncProcoreUpdates: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/playwright/auth", () => ({
  testLogin: vi.fn(),
  saveProcoreCredentials: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../server/playwright/portfolio", () => ({
  runPortfolioTransition: vi.fn(),
  runFullPortfolioWorkflow: vi.fn(),
}));
vi.mock("../server/playwright/documents", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn(),
  syncBidBoardDocumentsToPortfolio: vi.fn(),
}));
vi.mock("../server/playwright/browser", () => ({
  closeBrowser: vi.fn(),
  withBrowserLock: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

type FakeApp = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  routes: Record<string, any[]>;
};

function createFakeApp(): FakeApp {
  const routes: Record<string, any[]> = {};
  const app = {
    routes,
    get: vi.fn((path: string, ...handlers: any[]) => {
      routes[`GET ${path}`] = handlers;
    }),
    post: vi.fn((path: string, ...handlers: any[]) => {
      routes[`POST ${path}`] = handlers;
    }),
  };
  return app;
}

async function invokeRoute(handlers: any[], req: Record<string, unknown> = {}) {
  const res: any = {
    status: vi.fn(() => res),
    json: vi.fn(),
  };
  let index = 0;
  const next = vi.fn((err?: unknown) => {
    if (err) throw err;
    const handler = handlers[index++];
    if (handler) return handler(req, res, next);
  });

  next();
  await Promise.resolve();
  await Promise.resolve();
  return res;
}

describe("legacy BidBoard automation scheduler", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.storage.getAutomationConfig.mockResolvedValue(undefined);
    mocks.storage.upsertAutomationConfig.mockResolvedValue({});
    mocks.getAutomationStatus.mockResolvedValue({
      enabled: false,
      projectCount: 0,
      pendingPortfolioTransitions: 0,
    });
  });

  it("does not start the 60-minute scheduled poller when bidboard_automation is disabled", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "bidboard_automation") {
        return { key, value: { enabled: false, pollingIntervalMinutes: 60 } };
      }
      return undefined;
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      "[BidBoardPolling]",
      expect.objectContaining({
        action: "bidboard_automation:scheduler_disabled",
        enabled: false,
      })
    );

    infoSpy.mockRestore();
  });

  it("starts the scheduled poller when bidboard_automation is enabled", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "bidboard_automation") {
        return { key, value: { enabled: true, pollingIntervalMinutes: 60 } };
      }
      return undefined;
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(infoSpy).toHaveBeenCalledWith(
      "[BidBoardPolling]",
      expect.objectContaining({
        action: "bidboard_automation:scheduler_enabled",
        enabled: true,
        intervalMinutes: 60,
      })
    );

    infoSpy.mockRestore();
  });

  it("reports disabled state through /api/bidboard/status while remaining callable", async () => {
    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());
    mocks.getAutomationStatus.mockResolvedValue({
      enabled: false,
      projectCount: 12,
      pendingPortfolioTransitions: 0,
    });

    const res = await invokeRoute(app.routes["GET /api/bidboard/status"]);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        isPolling: false,
        currentlyPolling: false,
      })
    );
  });

  it("re-attaches the scheduler when config is flipped on through /api/bidboard/config", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["POST /api/bidboard/config"], {
      body: { enabled: true, pollingIntervalMinutes: 60 },
    });

    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "bidboard_automation",
        value: { enabled: true, pollingIntervalMinutes: 60 },
      })
    );
    expect(mocks.enableBidBoardAutomation).toHaveBeenCalledWith(true);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(infoSpy).toHaveBeenCalledWith(
      "[BidBoardPolling]",
      expect.objectContaining({
        action: "bidboard_automation:scheduler_enabled",
        enabled: true,
        intervalMinutes: 60,
      })
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, enabled: true, pollingIntervalMinutes: 60 });

    infoSpy.mockRestore();
  });

  it.each([false, true])("keeps manual helper endpoints callable when enabled=%s", async (enabled) => {
    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());
    mocks.storage.getAutomationConfig.mockResolvedValue({ key: "bidboard_automation", value: { enabled } });
    mocks.syncHubSpotClientToBidBoard.mockResolvedValue({ success: true, helper: "push" });
    mocks.onBidBoardProjectCreated.mockResolvedValue({ success: true, helper: "setup" });
    mocks.detectAndProcessNewProjects.mockResolvedValue({ success: true, helper: "detect" });

    const push = await invokeRoute(app.routes["POST /api/bidboard/push-client-data"], {
      body: { projectId: "bb-1", hubspotDealId: "deal-1" },
    });
    const setup = await invokeRoute(app.routes["POST /api/bidboard/setup-new-project"], {
      body: { projectId: "bb-1", hubspotDealId: "deal-1", syncClientData: true, syncAttachments: false },
    });
    const detect = await invokeRoute(app.routes["POST /api/bidboard/detect-new-projects"]);

    expect(mocks.syncHubSpotClientToBidBoard).toHaveBeenCalledWith("bb-1", "deal-1");
    expect(mocks.onBidBoardProjectCreated).toHaveBeenCalledWith("bb-1", "deal-1", {
      syncClientData: true,
      syncAttachments: false,
    });
    expect(mocks.detectAndProcessNewProjects).toHaveBeenCalled();
    expect(push.json).toHaveBeenCalledWith({ success: true, helper: "push" });
    expect(setup.json).toHaveBeenCalledWith({ success: true, helper: "setup" });
    expect(detect.json).toHaveBeenCalledWith({ success: true, helper: "detect" });
  });
});
