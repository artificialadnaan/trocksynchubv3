import { beforeEach, describe, expect, it, vi } from "vitest";

// Role polling was OFF in production for weeks and nothing said so. `POST /api/automation/role-polling/config`
// rebuilt the stored row from the request body, so a call that only changed batchSize persisted
// `{ enabled: undefined, ... }` — JSON drops the key — and then fell through to stopRolePolling(). Every boot
// after that read the key-less row as disabled. Measured consequence: 262 of 374 active projects went 30+ days
// without a role check, and roughly half of all PM assignments never raised a project-kickoff email, because
// kickoff only fires for assignments a sync run reports as NEW.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
  },
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: mocks.syncProcoreRoleAssignments,
  syncProcoreRoleAssignmentsBatch: mocks.syncProcoreRoleAssignmentsBatch,
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
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn(), runFullHubSpotSync: vi.fn() }));
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

function createFakeApp() {
  const routes: Record<string, any[]> = {};
  // registerSettingsRoutes also registers put/delete/patch handlers; collect them all so route
  // registration does not blow up before it reaches the one under test.
  const record = (verb: string) =>
    vi.fn((path: string, ...handlers: any[]) => { routes[`${verb} ${path}`] = handlers; });
  return {
    routes,
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  };
}

async function invokeRoute(handlers: any[], req: Record<string, unknown> = {}) {
  const res: any = { status: vi.fn(() => res), json: vi.fn() };
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

/** The row as production actually held it: batchSize + interval, and NO `enabled`. */
const CLOBBERED_ROW = { batchSize: 150, intervalMinutes: 15 };

function configReturning(row: unknown, cursorRow?: unknown) {
  return async (key: string) => {
    if (key === "role_assignment_polling") return { key, value: row };
    if (key === "role_assignment_polling_cursor" && cursorRow !== undefined) return { key, value: cursorRow };
    return undefined;
  };
}

describe("role polling — the enabled-key clobber", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.storage.getAutomationConfig.mockResolvedValue(undefined);
    mocks.storage.upsertAutomationConfig.mockResolvedValue({});
  });

  it("STARTS on boot when the row exists but has no `enabled` key, and repairs the row", async () => {
    // Only the clobber can produce a row with no `enabled`, so the honest reading is "this was on".
    // Treating it as off is what silently stopped the kickoff emails.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.storage.getAutomationConfig.mockImplementation(configReturning(CLOBBERED_ROW));

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no `enabled` key"));
    // ...and it heals the row so the next boot needs no special case.
    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "role_assignment_polling",
        value: expect.objectContaining({ enabled: true, batchSize: 150, intervalMinutes: 15 }),
      }),
    );
  });

  it("still honours an EXPLICIT enabled:false — only the missing key defaults on", async () => {
    // Someone deliberately turning polling off must stay off. The default is a repair for a known bug,
    // not a policy that polling is always on.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: false }),
    );

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(mocks.storage.upsertAutomationConfig).not.toHaveBeenCalled();
  });

  it("a batchSize-only config update PRESERVES enabled and keeps the poller running", async () => {
    // The exact call that caused the outage. It must no longer erase `enabled` nor stop the timer.
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ enabled: true, intervalMinutes: 15, batchSize: 50 }),
    );
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const handlers = app.routes["POST /api/automation/role-polling/config"];
    expect(handlers).toBeTruthy();
    await invokeRoute(handlers, { body: { batchSize: 150 } });

    const stored = mocks.storage.upsertAutomationConfig.mock.calls.at(-1)?.[0];
    expect(stored.key).toBe("role_assignment_polling");
    expect(stored.value.enabled).toBe(true);
    expect(stored.value.batchSize).toBe(150);
    // The interval it was already running on, not the 30 default.
    expect(stored.value.intervalMinutes).toBe(15);
  });

  it("an explicit enabled:false through the same route still disables", async () => {
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ enabled: true, intervalMinutes: 15, batchSize: 150 }),
    );
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { enabled: false },
    });

    expect(mocks.storage.upsertAutomationConfig.mock.calls.at(-1)?.[0].value.enabled).toBe(false);
  });

  it("RESUMES the rotation from the persisted cursor instead of restarting at project #1", async () => {
    // The cursor lived only in memory, so every deploy and crash reset it to 0. The project list is sorted
    // by ascending procoreId, so restarting always re-walked the OLDEST projects and starved the newest —
    // exactly the ones whose fresh PM assignment should raise a kickoff.
    vi.useFakeTimers();
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: true }, { batchCursor: 300 }),
    );
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    // The staggered first cycle fires 150s after startup.
    await vi.advanceTimersByTimeAsync(150_000);

    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(150, 300);
  });

  it("PERSISTS the advanced cursor after a cycle, so the next boot continues the rotation", async () => {
    vi.useFakeTimers();
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: true }, { batchCursor: 0 }),
    );
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 10, newAssignments: [], nextCursor: 150, totalProjects: 374, batchProcessed: 150,
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(150_000);

    // Its OWN key, carrying nothing else — so this write cannot replay policy fields.
    expect(mocks.storage.upsertAutomationConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "role_assignment_polling_cursor",
        value: { batchCursor: 150 },
      }),
    );
  });

  it("cursor persistence NEVER rewrites the policy row, so a concurrent disable cannot be replayed", async () => {
    // Read-modify-writing the policy row to save a cursor replays whatever the cycle happened to read. An
    // admin disabling polling between that read and this write would have `enabled: true` restored, and the
    // next restart would quietly poll again — the operator's decision undone by a progress write.
    vi.useFakeTimers();
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: true }, { batchCursor: 0 }),
    );
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 1, newAssignments: [], nextCursor: 150, totalProjects: 374, batchProcessed: 150,
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();
    await vi.advanceTimersByTimeAsync(150_000);

    const policyWrites = mocks.storage.upsertAutomationConfig.mock.calls
      .map((c: any[]) => c[0])
      .filter((w: any) => w.key === "role_assignment_polling");
    expect(policyWrites).toHaveLength(0);
  });

  it("STARTS the poller even when repairing the clobbered row fails", async () => {
    // There is no startup retry. If the repair write throws and takes startRolePolling down with it, one
    // transient failure keeps the poller off for the life of the process — perpetuating the outage this
    // branch exists to end.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.storage.getAutomationConfig.mockImplementation(configReturning(CLOBBERED_ROW));
    mocks.storage.upsertAutomationConfig.mockRejectedValue(new Error("db unavailable"));

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("starting anyway"),
      expect.anything(),
    );
  });

  it("STARTS the poller even when reading the saved cursor fails", async () => {
    // The cursor read sits between the policy read and startRolePolling. Letting it reach the outer catch
    // meant one transient DB failure left the poller down for the life of the process — the same failure
    // mode the isolated repair write already fixed, reintroduced two lines above it. Losing the cursor
    // costs a rotation's progress; losing the START costs every kickoff email.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "role_assignment_polling") {
        return { key, value: { ...CLOBBERED_ROW, enabled: true, batchCursor: 42 } };
      }
      if (key === "role_assignment_polling_cursor") throw new Error("db unavailable");
      return undefined;
    });
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not read the saved rotation cursor"),
      expect.anything(),
    );
    // ...and it fell back to the legacy policy-row cursor rather than restarting at 0.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(150, 42);
  });

  it("GET status reports a clobbered row as ENABLED, matching what boot actually did", async () => {
    // Boot starts the poller for a row with no `enabled`; this endpoint used `val.enabled || false` and told
    // the UI it was off. A recovery rule only some observers know is a rule that gets argued with.
    mocks.storage.getAutomationConfig.mockImplementation(configReturning(CLOBBERED_ROW));
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["GET /api/automation/role-polling/config"]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("GET status still reports an explicit enabled:false as disabled", async () => {
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: false }),
    );
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["GET /api/automation/role-polling/config"]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("the automations LIST agrees too — the third derivation of the same rule", async () => {
    // Codex named the status endpoint; enumerating the readers turned up this one as well, deriving
    // enabled-ness a third way via `?.enabled === true`. Other automations keep that strict rule; only
    // role polling has the clobber history that makes a missing key mean "on".
    mocks.storage.getAutomationConfigs.mockResolvedValue([
      { key: "role_assignment_polling", value: CLOBBERED_ROW },
      { key: "hubspot_polling", value: { intervalMinutes: 11 } },
    ]);
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["GET /api/automation/status"]);
    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload.automations.role_assignment_polling.enabled).toBe(true);
    // A key-less row for any OTHER automation still reads as disabled — no clobber history, no exception.
    expect(payload.automations.hubspot_polling.enabled).toBe(false);
  });

  it("a partial update on a still-clobbered row keeps it ENABLED rather than persisting a false", async () => {
    // The boot repair is async and can fail. Until it lands, the row still has no `enabled` — and a
    // batchSize-only request that defaulted to false would persist an explicit disable and stop the timer,
    // turning a recoverable state into one that looks deliberate. Boot and this route share one rule.
    mocks.storage.getAutomationConfig.mockImplementation(configReturning(CLOBBERED_ROW));
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { batchSize: 150 },
    });

    const stored = mocks.storage.upsertAutomationConfig.mock.calls
      .map((c: any[]) => c[0])
      .find((w: any) => w.key === "role_assignment_polling");
    expect(stored.value.enabled).toBe(true);
  });
});
