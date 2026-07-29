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
    patchAutomationConfig: vi.fn(),
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

/**
 * Back the storage mock with a real store whose patch merges right-biased per key, like Postgres `||`.
 * The route now derives enabled/interval from the row the patch RETURNS, so a stubbed return would test
 * nothing about that.
 */
function backedStore(initial: Record<string, any> = {}) {
  const rows: Record<string, any> = { ...initial };
  mocks.storage.getAutomationConfig.mockImplementation(async (key: string) =>
    key in rows ? { key, value: rows[key] } : undefined,
  );
  mocks.storage.patchAutomationConfig.mockImplementation(
    async (key: string, patch: Record<string, unknown>) => {
      const prev = rows[key];
      rows[key] = prev != null && typeof prev === "object" && !Array.isArray(prev)
        ? { ...prev, ...patch }
        : { ...patch };
      return { key, value: rows[key] };
    },
  );
  mocks.storage.upsertAutomationConfig.mockImplementation(async (data: any) => {
    rows[data.key] = data.value;
    return data;
  });
  return rows;
}

describe("role polling — the enabled-key clobber", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.storage.getAutomationConfig.mockResolvedValue(undefined);
    mocks.storage.upsertAutomationConfig.mockResolvedValue({});
    mocks.storage.patchAutomationConfig.mockImplementation(async (key: string, patch: any) => ({ key, value: patch }));
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
    // A field-level patch: it sets `enabled` and cannot resurrect the rest of the snapshot it read.
    expect(mocks.storage.patchAutomationConfig).toHaveBeenCalledWith(
      "role_assignment_polling",
      { enabled: true },
      expect.any(String),
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
    expect(mocks.storage.patchAutomationConfig).not.toHaveBeenCalled();
  });

  it("a batchSize-only config update PRESERVES enabled and keeps the poller running", async () => {
    // The exact call that caused the outage. It must no longer erase `enabled` nor stop the timer.
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 50 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const handlers = app.routes["POST /api/automation/role-polling/config"];
    expect(handlers).toBeTruthy();
    await invokeRoute(handlers, { body: { batchSize: 150 } });

    // Only batchSize is patched; `enabled` and `intervalMinutes` are never mentioned, so the merge keeps them.
    const call = mocks.storage.patchAutomationConfig.mock.calls.at(-1);
    expect(call?.[0]).toBe("role_assignment_polling");
    expect(call?.[1]).toEqual({ batchSize: 150 });
    expect(rows["role_assignment_polling"]).toMatchObject({
      enabled: true, batchSize: 150, intervalMinutes: 15,
    });
  });

  it("an explicit enabled:false through the same route still disables", async () => {
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 150 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { enabled: false },
    });

    expect(rows["role_assignment_polling"].enabled).toBe(false);
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
    expect(mocks.storage.patchAutomationConfig).toHaveBeenCalledWith(
      "role_assignment_polling_cursor",
      { batchCursor: 150 },
      expect.any(String),
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

    const policyWrites = mocks.storage.patchAutomationConfig.mock.calls
      .filter((c: any[]) => c[0] === "role_assignment_polling");
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
    mocks.storage.patchAutomationConfig.mockRejectedValue(new Error("db unavailable"));

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

  it("does NOT recover `enabled: null` — that is an explicit value, not a missing key", async () => {
    // The recovery is for the clobber's fingerprint: NO `enabled` property. `enabled ?? true` also caught
    // null, which the generic automation-config PUT can persist and which used to read as disabled — so
    // upgrading would have quietly started polling and emailing for a row somebody had turned off.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: null }),
    );

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(mocks.storage.patchAutomationConfig).not.toHaveBeenCalled();
  });

  it("does NOT recover a non-boolean `enabled` either", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    mocks.storage.getAutomationConfig.mockImplementation(
      configReturning({ ...CLOBBERED_ROW, enabled: "yes" }),
    );

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("a partial update on a FRESH install (no row at all) does not create an enabled policy", async () => {
    // An absent ROW is not a key-less row. Coercing it to `{}` made the recovery rule fire on first install,
    // so an interval-only request would have created an enabled policy and started polling — while boot
    // defines a missing row as disabled. The two must agree.
    const rows = backedStore({});
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { intervalMinutes: 20 },
    });

    // Nothing enables it: the request never mentioned `enabled`, so the patch does not set it, and a row
    // without it reads as disabled everywhere.
    expect(rows["role_assignment_polling"].enabled).toBeUndefined();
    expect(rows["role_assignment_polling"].intervalMinutes).toBe(20);
  });

  it("does NOT recover a non-OBJECT stored value", async () => {
    // The generic automation-config PUT accepts arbitrary JSON. `false`, a string, or an array all lack an
    // `enabled` property, so a hasOwnProperty check alone read them as the clobbered object and would have
    // repaired them into an enabled, email-sending poller. They were disabled before this branch existed.
    for (const value of [false, "disabled", [1, 2], 0] as unknown[]) {
      vi.clearAllMocks();
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      mocks.storage.getAutomationConfig.mockImplementation(configReturning(value));
      mocks.storage.patchAutomationConfig.mockResolvedValue({} as any);
      vi.resetModules();

      const { initPolling } = await import("../server/routes/settings.ts");
      await initPolling();

      expect(setIntervalSpy, `value ${JSON.stringify(value)} must not start polling`).not.toHaveBeenCalled();
      expect(mocks.storage.patchAutomationConfig).not.toHaveBeenCalled();
      vi.useRealTimers();
    }
  });

  it("an explicit `enabled: null` through the POST DISABLES rather than being discarded", async () => {
    // `reqEnabled ?? existing` treated a supplied null as "not supplied", so the poller kept running. null is
    // a value: it read as disabled before this branch, and the startup rule treats any present non-boolean
    // `enabled` as disabled. The route has to normalise it the same way.
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 150 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { enabled: null },
    });

    expect(rows["role_assignment_polling"].enabled).toBe(false);
  });

  it("an enabled-only request PRESERVES the stored batchSize, not this replica's stale copy", async () => {
    // ROLE_POLLING_BATCH_SIZE is module state and can be stale — another replica, or the generic config PUT,
    // may have changed the stored value. Writing it back on a request that never mentioned batchSize breaks
    // the very partial-update guarantee this endpoint is supposed to provide.
    const rows = backedStore({ role_assignment_polling: { enabled: false, intervalMinutes: 15, batchSize: 175 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { enabled: true },
    });

    const call = mocks.storage.patchAutomationConfig.mock.calls.at(-1);
    expect(call?.[1]).toEqual({ enabled: true });
    expect(rows["role_assignment_polling"].batchSize).toBe(175);
  });

  it("a concurrent explicit disable during startup WINS over the repair", async () => {
    // Multiple replicas. This one reads a key-less row; an admin disables polling through another replica
    // while this one is still reading the cursor. Repairing unconditionally would write `enabled: true` over
    // that newer `false` and start polling locally — recovery undoing operator intent. The row is re-read
    // immediately before acting, so the disable is honoured.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    let policyReads = 0;
    mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => {
      if (key === "role_assignment_polling") {
        policyReads += 1;
        // First read: the legacy key-less row. Second (the pre-repair re-read): an admin has disabled it.
        return policyReads === 1
          ? { key, value: CLOBBERED_ROW }
          : { key, value: { ...CLOBBERED_ROW, enabled: false } };
      }
      return undefined;
    });

    const { initPolling } = await import("../server/routes/settings.ts");
    await initPolling();

    expect(policyReads).toBeGreaterThanOrEqual(2);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // ...and crucially it did not stamp `enabled: true` over the disable.
    const policyWrites = mocks.storage.patchAutomationConfig.mock.calls
      .filter((c: any[]) => c[0] === "role_assignment_polling");
    expect(policyWrites).toHaveLength(0);
  });

  it("a partial update on a still-clobbered row keeps it ENABLED rather than persisting a false", async () => {
    // The boot repair is async and can fail. Until it lands, the row still has no `enabled` — and a
    // batchSize-only request that defaulted to false would persist an explicit disable and stop the timer,
    // turning a recoverable state into one that looks deliberate. Boot and this route share one rule.
    backedStore({ role_assignment_polling: { ...CLOBBERED_ROW } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { batchSize: 150 },
    });

    // The request never mentioned `enabled`, so the patch leaves it absent — which the shared rule still
    // reads as enabled for an existing row. Nothing writes a false over a recoverable state.
    const call = mocks.storage.patchAutomationConfig.mock.calls.at(-1);
    expect(call?.[1]).toEqual({ batchSize: 150 });
    expect(call?.[1]).not.toHaveProperty("enabled");
  });
});
