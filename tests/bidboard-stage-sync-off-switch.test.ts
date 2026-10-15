import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    createBidboardStageSyncRun: vi.fn(),
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

// 2026-10-15: the stale Bid Board export kept reaching the CRM (and the owner kept getting the hourly
// 401 email) after the stage sync was switched OFF. The boot timer is started by routes/settings.ts
// initPolling, but the Settings switch POSTs to routes/bidboard.ts's route (registered first, so it is
// the one Express runs), which can only clear ITS OWN timer variable. Each cycle must therefore read
// the saved switch itself, so OFF stops the next run whichever module started the timer.
describe("BidBoard stage sync OFF switch", () => {
  let stageSync: { enabled: boolean; intervalMinutes: number; dryRun: boolean };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    stageSync = { enabled: true, intervalMinutes: 19, dryRun: true };
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) =>
      key === "bidboard_stage_sync" ? { key, value: { ...stageSync } } : undefined
    );
    mocks.storage.upsertAutomationConfig.mockImplementation(async (row: any) => {
      if (row.key === "bidboard_stage_sync") stageSync = { ...row.value };
      return {};
    });
    mocks.storage.createBidboardStageSyncRun.mockResolvedValue({});
    mocks.runBidBoardStageSync.mockResolvedValue({ total: 0, changed: 0, failed: 0, changes: [], errors: [] });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("keeps running on the boot timer while the switch stays ON (the control)", async () => {
    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(60_000 + 2 * 19 * 60_000);
    expect(mocks.runBidBoardStageSync).toHaveBeenCalledTimes(3);
  });

  it("stops the boot timer's runs once the Settings switch (bidboard.ts's route) saves OFF, with no restart", async () => {
    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.runBidBoardStageSync).toHaveBeenCalledTimes(1);

    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());
    await invokeRoute(app.routes["POST /api/bidboard/stage-sync/config"], {
      body: { enabled: false, intervalMinutes: 19, dryRun: true },
    });
    expect(stageSync.enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(3 * 19 * 60_000);
    expect(mocks.runBidBoardStageSync).toHaveBeenCalledTimes(1);
  });

  it("an explicit Sync Now still runs while the schedule is OFF (only the timer obeys the switch; Codex on #112)", async () => {
    stageSync = { enabled: false, intervalMinutes: 19, dryRun: true };
    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());
    const res = await invokeRoute(app.routes["POST /api/bidboard/stage-sync/trigger"], {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Stage sync triggered" }));
    expect(mocks.runBidBoardStageSync).toHaveBeenCalledTimes(1);
  });

  it("an export-only run is recorded as 'export_only', never as a 'success' baseline (Codex P1 on #112)", async () => {
    stageSync = { enabled: false, intervalMinutes: 19, dryRun: false };
    mocks.runBidBoardStageSync.mockResolvedValue({ total: 0, changed: 0, failed: 0, changes: [], errors: [], exportOnly: true });
    const app = createFakeApp();
    const { registerBidboardRoutes } = await import("../server/routes/bidboard.ts");
    registerBidboardRoutes(app as any, (_req: any, _res: any, next: any) => next());
    await invokeRoute(app.routes["POST /api/bidboard/stage-sync/trigger"], {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.storage.createBidboardStageSyncRun).toHaveBeenCalledWith(expect.objectContaining({ status: "export_only" }));
  });
});

describe("stageSyncRunStatus — the one status every run-recording path writes", () => {
  it("export-only is never a baseline status; the others are unchanged", async () => {
    const { stageSyncRunStatus } = await import("../server/sync/run-status.ts");
    const base = { total: 0, changed: 0, failed: 0, changes: [], errors: [] };
    expect(stageSyncRunStatus({ ...base, exportOnly: true }, false)).toBe("export_only");
    expect(stageSyncRunStatus({ ...base, exportOnly: true, initialized: true }, true)).toBe("export_only");
    expect(stageSyncRunStatus({ ...base, initialized: true }, false)).toBe("initialized");
    expect(stageSyncRunStatus(base, true)).toBe("dry_run");
    expect(stageSyncRunStatus({ ...base, failed: 1, changed: 1 }, false)).toBe("partial");
    expect(stageSyncRunStatus({ ...base, failed: 1 }, false)).toBe("failed");
    expect(stageSyncRunStatus(base, false)).toBe("success");
  });
});
