import { beforeEach, describe, expect, it, vi } from "vitest";

// Role polling was OFF in production for weeks and nothing said so. `POST /api/automation/role-polling/config`
// rebuilt the stored row from the request body, so a call that only changed batchSize persisted
// `{ enabled: undefined, ... }` — JSON drops the key — and then fell through to stopRolePolling(). Every boot
// after that read the key-less row as disabled. Measured: 262 of 374 active projects went 30+ days without a
// role check, and 67 of 142 PM assignments never raised a project-kickoff email, because kickoff only fires
// for assignments a sync run reports as NEW.
//
// The fix is that partial updates MERGE (atomically, in Postgres) instead of rebuilding. An earlier revision
// also recovered the damaged row automatically — treating a missing `enabled` as ON — and review found eleven
// ways that could fire when it should not, every one of them starting a poller that emails PMs. It is gone:
// the row is repaired by one explicit enable, and boot only REPORTS the signature.
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

/**
 * AWAIT the handler, rather than draining a fixed number of microtasks.
 *
 * This used to call `next()` synchronously, discard the returned promise and `await Promise.resolve()` twice.
 * Correctness then depended on the route having at most two awaits before `res.json` — so adding one (the
 * atomic patch call did exactly that) made every assertion vacuous instead of failing loudly. That is how a
 * Critical regression got through a green suite in this file.
 */
async function invokeRoute(handlers: any[], req: Record<string, unknown> = {}) {
  const res: any = { status: vi.fn(() => res), json: vi.fn() };
  let index = 0;
  const next: any = vi.fn(async (err?: unknown) => {
    if (err) throw err;
    const handler = handlers[index++];
    if (handler) return await handler(req, res, next);
  });
  await next();
  return res;
}

/** The row as production actually holds it: batchSize + interval, and NO `enabled`. */
const CLOBBERED_ROW = { batchSize: 150, intervalMinutes: 15 };

function configReturning(row: unknown, cursorRow?: unknown) {
  return async (key: string) => {
    if (key === "role_assignment_polling") return { key, value: row };
    if (key === "role_assignment_polling_cursor" && cursorRow !== undefined) return { key, value: cursorRow };
    return undefined;
  };
}

/**
 * Back the storage mock with a real store whose patch merges right-biased per key, like Postgres `||`, and
 * whose insertDefaults apply to the INSERT path only. The route derives its answer from the row the patch
 * RETURNS, so a stubbed return would test nothing about that.
 */
function backedStore(initial: Record<string, any> = {}) {
  const rows: Record<string, any> = { ...initial };
  mocks.storage.getAutomationConfig.mockImplementation(async (key: string) =>
    key in rows ? { key, value: rows[key] } : undefined,
  );
  mocks.storage.patchAutomationConfig.mockImplementation(
    async (key: string, patch: Record<string, unknown>, _d?: string, insertDefaults?: Record<string, unknown>) => {
      const prev = rows[key];
      const existed = prev != null && typeof prev === "object" && !Array.isArray(prev);
      rows[key] = existed ? { ...prev, ...patch } : { ...(insertDefaults ?? {}), ...patch };
      return { key, value: rows[key] };
    },
  );
  mocks.storage.upsertAutomationConfig.mockImplementation(async (data: any) => {
    rows[data.key] = data.value;
    return data;
  });
  return rows;
}

async function bootWith(row: unknown, cursorRow?: unknown) {
  mocks.storage.getAutomationConfig.mockImplementation(configReturning(row, cursorRow));
  const { initPolling } = await import("../server/routes/settings.ts");
  await initPolling();
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

  // ── The clobbered row is REPORTED, never acted on ────────────────────────────────────────────────
  it("leaves a key-less row OFF and says so loudly", async () => {
    // Being silent is what let this run for weeks: `if (val?.enabled)` had no else branch. It stays off — an
    // automatic recovery here fails by sending mail nobody asked for — but it is now diagnosable, and the
    // warning names the exact call that fixes it.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await bootWith(CLOBBERED_ROW);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("NO `enabled` key"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('{"enabled":true}'));
    // Boot must not write to the policy row at all.
    expect(
      mocks.storage.patchAutomationConfig.mock.calls.filter((c: any[]) => c[0] === "role_assignment_polling"),
    ).toHaveLength(0);
  });

  it("starts on an explicit enabled:true", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    await bootWith({ ...CLOBBERED_ROW, enabled: true });
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
  });

  it("stays off for enabled:false, null, a non-boolean, and a non-object value", async () => {
    // Only `enabled === true` on a plain object starts it. The generic automation-config PUT accepts arbitrary
    // JSON, so `false`, `"disabled"` and arrays are all reachable and were all disabled before this branch.
    for (const value of [
      { ...CLOBBERED_ROW, enabled: false },
      { ...CLOBBERED_ROW, enabled: null },
      { ...CLOBBERED_ROW, enabled: "yes" },
      false,
      "disabled",
      [1, 2],
    ] as unknown[]) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await bootWith(value);
      expect(setIntervalSpy, `${JSON.stringify(value)} must not start polling`).not.toHaveBeenCalled();
      vi.useRealTimers();
    }
  });

  // ── Every reader agrees ──────────────────────────────────────────────────────────────────────────
  it("GET status and the automations LIST both report a key-less row as disabled", async () => {
    // Three derivations of this rule disagreed at one point. They share one function now, so the dashboard
    // cannot contradict the running process.
    mocks.storage.getAutomationConfig.mockImplementation(configReturning(CLOBBERED_ROW));
    mocks.storage.getAutomationConfigs.mockResolvedValue([
      { key: "role_assignment_polling", value: CLOBBERED_ROW },
      { key: "hubspot_polling", value: { enabled: true, intervalMinutes: 11 } },
    ]);
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const status = await invokeRoute(app.routes["GET /api/automation/role-polling/config"]);
    expect(status.json).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));

    const list = await invokeRoute(app.routes["GET /api/automation/status"]);
    const payload = list.json.mock.calls.at(-1)?.[0];
    expect(payload.automations.role_assignment_polling.enabled).toBe(false);
    expect(payload.automations.hubspot_polling.enabled).toBe(true);
  });

  // ── The actual fix: partial updates merge ────────────────────────────────────────────────────────
  it("a batchSize-only update PRESERVES enabled and the stored interval", async () => {
    // The exact call that caused the outage. It patches one field and mentions nothing else.
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 50 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], { body: { batchSize: 150 } });

    const call = mocks.storage.patchAutomationConfig.mock.calls.at(-1);
    expect(call?.[1]).toEqual({ batchSize: 150 });
    expect(rows["role_assignment_polling"]).toMatchObject({ enabled: true, batchSize: 150, intervalMinutes: 15 });
  });

  it("an enabled-only update PRESERVES the stored batchSize, not this replica's copy", async () => {
    // ROLE_POLLING_BATCH_SIZE is module state and can be stale — another replica, or the generic config PUT,
    // may have changed the stored value. Writing it back on a request that never mentioned it breaks the very
    // partial-update guarantee this endpoint exists to provide.
    const rows = backedStore({ role_assignment_polling: { enabled: false, intervalMinutes: 15, batchSize: 175 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], { body: { enabled: true } });

    expect(mocks.storage.patchAutomationConfig.mock.calls.at(-1)?.[1]).toEqual({ enabled: true });
    expect(rows["role_assignment_polling"].batchSize).toBe(175);
  });

  it("an explicit enabled:null DISABLES rather than being discarded", async () => {
    // `reqEnabled ?? existing` treated a supplied null as "not supplied" and left the poller running. null is
    // a value: it read as disabled before this branch, and the startup rule agrees.
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 150 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], { body: { enabled: null } });

    expect(rows["role_assignment_polling"].enabled).toBe(false);
  });

  it("a FRESH install does not self-enable — asserted on the OUTCOME, not the stored field", async () => {
    // patchAutomationConfig upserts, so an interval-only request on a fresh install creates
    // `{ intervalMinutes: 20 }` — an object with no `enabled`. Under the old recovery rule that read as ON and
    // started emailing. The previous version of this test checked only that the field was absent, which was
    // true and meaningless; it passed while the behaviour regressed. insertDefaults gives a NEW row
    // `enabled: false` without ever writing that over an existing one.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const rows = backedStore({});
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { intervalMinutes: 20 },
    });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(rows["role_assignment_polling"].enabled).toBe(false);
    expect(rows["role_assignment_polling"].intervalMinutes).toBe(20);
  });

  // ── The rotation cursor ──────────────────────────────────────────────────────────────────────────
  it("RESUMES from the persisted cursor instead of restarting at project #1", async () => {
    // The cursor lived only in memory, so every deploy reset it to 0. The list is sorted by ascending
    // procoreId, so restarting always re-walked the OLDEST projects and starved the newest — exactly the ones
    // whose fresh PM assignment should raise a kickoff.
    vi.useFakeTimers();
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });

    await bootWith({ ...CLOBBERED_ROW, enabled: true }, { batchCursor: 300 });
    await vi.advanceTimersByTimeAsync(150_000);

    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(150, 300);
  });

  it("PERSISTS the advanced cursor to its own row, never the policy row", async () => {
    // Read-modify-writing the policy row to save a cursor replays whatever the cycle read: a disable landing
    // in between would be undone by a progress write.
    vi.useFakeTimers();
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 1, newAssignments: [], nextCursor: 150, totalProjects: 374, batchProcessed: 150,
    });

    await bootWith({ ...CLOBBERED_ROW, enabled: true }, { batchCursor: 0 });
    await vi.advanceTimersByTimeAsync(150_000);

    expect(mocks.storage.patchAutomationConfig).toHaveBeenCalledWith(
      "role_assignment_polling_cursor", { batchCursor: 150 }, expect.any(String),
    );
    expect(
      mocks.storage.patchAutomationConfig.mock.calls.filter((c: any[]) => c[0] === "role_assignment_polling"),
    ).toHaveLength(0);
  });

  it("STARTS the poller even when reading the saved cursor fails", async () => {
    // The cursor read sits between the policy read and startRolePolling. Letting it reach the outer catch
    // meant one transient DB failure left the poller down for the life of the process, with no retry.
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

  it("ignores a non-numeric stored cursor rather than coercing it to 0", async () => {
    // `Number("")` and `Number(false)` are 0, so a junk value silently restarted the rotation at project #1 —
    // the starvation this restore exists to prevent, reintroduced by a coercion.
    vi.useFakeTimers();
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });

    await bootWith({ ...CLOBBERED_ROW, enabled: true, batchCursor: 275 }, { batchCursor: "" });
    await vi.advanceTimersByTimeAsync(150_000);

    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(150, 275);
  });

  it("the CONFIG ROUTE validates the interval too, not just boot", async () => {
    // `Number(x) || 30` rejects 0 and NaN but passes -5 through, and a negative delay makes setInterval fire
    // continuously — a runaway against the Procore API, i.e. the rate-limit event the batching exists to
    // prevent. I fixed the boot path and left this one raw; both share one resolver now.
    // 23, not 30: boot and this route share one fallback now, so a row without an interval keeps its
    // schedule across a restart instead of silently changing.
    for (const [stored, expectedMs] of [
      [-5, 23 * 60 * 1000],
      [0, 23 * 60 * 1000],
      ["soon", 23 * 60 * 1000],
      [99999, 1440 * 60 * 1000],
      [20, 20 * 60 * 1000],
    ] as Array<[unknown, number]>) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 150 } });
      const app = createFakeApp();
      const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
      registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

      await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
        body: { intervalMinutes: stored },
      });

      expect(setIntervalSpy, `stored ${JSON.stringify(stored)}`).toHaveBeenCalledWith(
        expect.any(Function), expectedMs,
      );
      vi.useRealTimers();
    }
  });

  it("PERSISTS the resolved interval, so storage, response, timer and restart all agree", async () => {
    // Storing the raw value and resolving only for the timer gave three different answers to one question:
    // the row said -5, the response said 30, GET echoed -5, and the next boot resolved it against a different
    // 23-minute fallback. Normalising into the patch is what makes them one answer.
    const rows = backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15, batchSize: 150 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const res = await invokeRoute(app.routes["POST /api/automation/role-polling/config"], {
      body: { intervalMinutes: -5 },
    });

    // 23 — the single shared default, so the persisted row, the response and a later restart all agree.
    expect(rows["role_assignment_polling"].intervalMinutes).toBe(23);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ intervalMinutes: 23 }));
  });

  it("ignores a COERCIBLE non-number cursor (false, []) in favour of a valid fallback", async () => {
    // `Number.isFinite(Number(c))` accepts `false` and `[]` — both 0 — so a junk cursor row was SELECTED over
    // a valid legacy one and then floored to 0, restarting the sweep at the oldest projects.
    vi.useFakeTimers();
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });

    await bootWith({ ...CLOBBERED_ROW, enabled: true, batchCursor: 275 }, { batchCursor: false });
    await vi.advanceTimersByTimeAsync(150_000);

    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(150, 275);
  });

  it("enable-all ADOPTS the stored batch size rather than this replica's stale copy", async () => {
    // The merge preserved batchSize in the database but the returned row was discarded, so a stopped poller
    // restarted on this process's old size while the DB held a newer one — and a later restart switched
    // silently. Module state has to come from the row that was just written.
    vi.useFakeTimers();
    backedStore({ role_assignment_polling: { enabled: false, intervalMinutes: 30, batchSize: 175 } });
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    const enableAll = app.routes["POST /api/internal/enable-all-automations"];
    expect(enableAll, "enable-all route must exist").toBeTruthy();
    // The route is secret-gated; the default is the same literal the handler falls back to.
    await invokeRoute(enableAll, {
      body: { secret: process.env.INTERNAL_API_SECRET || "synchub-test-2026" },
      headers: {},
    });
    await vi.advanceTimersByTimeAsync(150_000);

    // 175 from the database, not the 50 default this process booted with.
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(175, expect.any(Number));
  });

  it("uses ONE interval fallback, so a row without one keeps its schedule across a restart", async () => {
    // Boot fell back to 23 and the config route to 30. A row with no `intervalMinutes` therefore ran on a
    // different schedule depending on whether it had just been saved or just been restarted — a silent
    // change with no configuration event behind it.
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    backedStore({ role_assignment_polling: { enabled: false } }); // no intervalMinutes at all
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());

    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], { body: { enabled: true } });
    const viaRoute = setIntervalSpy.mock.calls.at(-1)?.[1];

    // ...and the same row through boot.
    vi.resetModules();
    vi.clearAllMocks();
    const bootSpy = vi.spyOn(global, "setInterval");
    await bootWith({ enabled: true });
    const viaBoot = bootSpy.mock.calls.at(-1)?.[1];

    expect(viaRoute).toBe(viaBoot);
    expect(viaRoute).toBe(23 * 60 * 1000);
  });

  it("RESETS the batch size when the authoritative row omits it", async () => {
    // A row with no batchSize is the database saying "the default", not "keep whatever this process had".
    // Leaving stale module state meant the replica polled at its old size while the DB implied 50 — and the
    // next restart changed it silently.
    vi.useFakeTimers();
    // Boot with 175, so the module state is non-default...
    await bootWith({ enabled: true, intervalMinutes: 15, batchSize: 175 });
    mocks.syncProcoreRoleAssignmentsBatch.mockResolvedValue({
      synced: 0, newAssignments: [], nextCursor: 0, totalProjects: 374, batchProcessed: 0,
    });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(175, expect.any(Number));

    // ...then the policy is replaced by a row with no batchSize, and a config request returns it.
    mocks.syncProcoreRoleAssignmentsBatch.mockClear();
    backedStore({ role_assignment_polling: { enabled: true, intervalMinutes: 15 } });
    const app = createFakeApp();
    const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
    registerSettingsRoutes(app as any, (_req: any, _res: any, next: any) => next());
    await invokeRoute(app.routes["POST /api/automation/role-polling/config"], { body: { enabled: true } });

    await vi.advanceTimersByTimeAsync(150_000);
    expect(mocks.syncProcoreRoleAssignmentsBatch).toHaveBeenCalledWith(50, expect.any(Number));
  });

  // ── Timer inputs ─────────────────────────────────────────────────────────────────────────────────
  it("refuses an unusable stored interval instead of handing it to setInterval", async () => {
    // The poller hits the Procore API. A stored 0 or NaN would become a runaway or never-firing timer, and a
    // runaway here is a rate-limit event — the thing the batching exists to avoid.
    for (const [stored, expectedMs] of [
      [0, 23 * 60 * 1000],
      [-5, 23 * 60 * 1000],
      ["fifteen", 23 * 60 * 1000],
      [15, 15 * 60 * 1000],
    ] as Array<[unknown, number]>) {
      vi.resetModules();
      vi.clearAllMocks();
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, "setInterval");
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await bootWith({ ...CLOBBERED_ROW, enabled: true, intervalMinutes: stored });
      expect(setIntervalSpy, `stored ${JSON.stringify(stored)}`).toHaveBeenCalledWith(
        expect.any(Function), expectedMs,
      );
      vi.useRealTimers();
    }
  });
});
