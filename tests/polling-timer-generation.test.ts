import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A failing cycle's auth-expiry disable stops the polling timer (onDisabled) only AFTER its compare-and-set resolves.
// If an admin re-enable commits and starts a NEW interval inside that window, the stop must leave the new interval
// alone: it belongs to the re-enable, and the stored row is enabled. The cycle may only stop the timer it ran under.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    getAutomationConfigVersion: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    patchAutomationConfig: vi.fn(),
    createAuditLog: vi.fn(),
  },
  runFullHubSpotSync: vi.fn(),
  runFullProcoreSync: vi.fn(),
  recordPollingAuthExpiry: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/polling-auth-alert", async () => ({
  ...(await vi.importActual<any>("../server/polling-auth-alert")),
  recordPollingAuthExpiry: mocks.recordPollingAuthExpiry,
}));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: mocks.runFullProcoreSync,
}));
vi.mock("../server/bidboard-automation.ts", () => ({
  runBidBoardPolling: vi.fn(),
  getAutomationStatus: vi.fn(async () => ({ enabled: false, projectCount: 0, pendingPortfolioTransitions: 0 })),
  enableBidBoardAutomation: vi.fn(),
  manualSyncProject: vi.fn(),
  onBidBoardProjectCreated: vi.fn(),
  detectAndProcessNewProjects: vi.fn(),
}));
vi.mock("../server/playwright/bidboard.ts", () => ({ syncHubSpotClientToBidBoard: vi.fn() }));
vi.mock("../server/sync", () => ({ runBidBoardStageSync: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn(), runFullHubSpotSync: mocks.runFullHubSpotSync }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ triggerPostSyncProcoreUpdates: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/playwright/auth", () => ({ testLogin: vi.fn(), saveProcoreCredentials: vi.fn(), logout: vi.fn() }));
vi.mock("../server/playwright/portfolio", () => ({ runPortfolioTransition: vi.fn(), runFullPortfolioWorkflow: vi.fn() }));
vi.mock("../server/playwright/documents", () => ({
  syncHubSpotAttachmentsToBidBoard: vi.fn(),
  syncBidBoardDocumentsToPortfolio: vi.fn(),
}));
vi.mock("../server/playwright/browser", () => ({
  closeBrowser: vi.fn(),
  withBrowserLock: vi.fn((_name: string, fn: () => unknown) => fn()),
}));

type Job = "hubspot_polling" | "procore_polling";
const SYNC = { hubspot_polling: mocks.runFullHubSpotSync, procore_polling: mocks.runFullProcoreSync };
// startPolling / startProcorePolling: the first cycle runs after this stagger, then every interval.
const FIRST_RUN_MS = { hubspot_polling: 30_000, procore_polling: 90_000 };
const INTERVAL_MIN = 15;

describe.each<Job>(["hubspot_polling", "procore_polling"])("%s — a disable never stops a re-enable's timer", (job) => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) =>
      key === job ? { key, value: { enabled: true, intervalMinutes: INTERVAL_MIN } } : undefined,
    );
    mocks.storage.getAutomationConfigVersion.mockResolvedValue("v1");
    mocks.storage.createAuditLog.mockResolvedValue({});
    SYNC[job].mockRejectedValue(new Error("401 Unauthorized"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a re-enable that starts a new interval during the disable keeps polling", async () => {
    let finishDisable!: () => void;
    let captured: any;
    mocks.recordPollingAuthExpiry.mockImplementation(async (args: any) => {
      captured = args;
      await new Promise<void>((r) => (finishDisable = r));
      return { newEvent: true, persisted: true, alert: "sent" };
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS[job]);
    expect(captured?.job).toBe(job);

    // The CAS has committed; before its promise resolves, a re-enable starts a NEW interval (startPolling via boot
    // config, the same call the enable route makes).
    await initPolling();
    captured.onDisabled();
    finishDisable();
    await vi.advanceTimersByTimeAsync(0);

    // The token works again (that is why it was re-enabled). Run past the re-enable's one-off staggered first
    // cycle, then count only what the INTERVAL runs: a cleared interval runs nothing more.
    SYNC[job].mockResolvedValue(job === "hubspot_polling"
      ? { companies: {}, contacts: {}, deals: {}, duration: 1 }
      : { projects: {}, vendors: {}, users: {}, roleAssignments: { synced: 0, newAssignments: [] } });
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS[job]);
    const before = SYNC[job].mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MIN * 60_000);
    expect(SYNC[job].mock.calls.length - before).toBeGreaterThanOrEqual(1);
  });

  it("with no re-enable, the disable stops the cycle's own timer", async () => {
    let captured: any;
    mocks.recordPollingAuthExpiry.mockImplementation(async (args: any) => {
      captured = args;
      args.onDisabled();
      return { newEvent: true, persisted: true, alert: "sent" };
    });
    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS[job]);
    expect(captured?.job).toBe(job);

    const before = SYNC[job].mock.calls.length;
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MIN * 60_000);
    // (Every later cycle would fail the same way; none runs because the interval is gone.)
    expect(SYNC[job].mock.calls.length).toBe(before);
  });
});
