import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/settings/polling/:job/enable — the explicit, audited way back after a poller auto-disabled
// for auth expiry. Admin-only; clears disabledReason; restarts the timer; writes an audit row.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    patchAutomationConfig: vi.fn(),
    createAuditLog: vi.fn(),
    getUser: vi.fn(),
  },
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn() }));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: vi.fn(),
}));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn(), runFullHubSpotSync: vi.fn() }));
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
    vi.fn((path: string, ...handlers: any[]) => {
      routes[`${verb} ${path}`] = handlers;
    });
  return { routes, get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE") };
}

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

/** The real session gate from server/routes/index.ts. */
function requireAuth(req: any, res: any, next: any) {
  if (req.session?.userId) return next();
  res.status(401).json({ message: "Unauthorized" });
}

const DISABLED_ROW = { enabled: false, intervalMinutes: 20, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" };
const ENABLE = "POST /api/settings/polling/:job/enable";

function backedStore(initial: Record<string, any>) {
  const rows: Record<string, any> = { ...initial };
  mocks.storage.getAutomationConfig.mockImplementation(async (key: string) => (key in rows ? { key, value: rows[key] } : undefined));
  mocks.storage.getAutomationConfigs.mockImplementation(async () => Object.entries(rows).map(([key, value]) => ({ key, value })));
  mocks.storage.upsertAutomationConfig.mockImplementation(async (data: any) => {
    rows[data.key] = data.value;
    return data;
  });
  return rows;
}

async function setup(rows: Record<string, any>) {
  // Present so registerSettingsRoutes' estimator seed does not write; every upsert below is the endpoint's.
  const store = backedStore({ estimator_list: { estimators: [] }, ...rows });
  const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
  const app = createFakeApp();
  registerSettingsRoutes(app as any, requireAuth);
  const status = async () =>
    (await invokeRoute(app.routes["GET /api/automation/status"], { session: { userId: "admin-1" } })).json.mock.calls[0][0].automations;
  return { app, store, status };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.storage.createAuditLog.mockResolvedValue({});
  mocks.storage.getUser.mockImplementation(async (id: string) =>
    id === "admin-1" ? { id, username: "boss", role: "admin" } : id === "viewer-1" ? { id, username: "v", role: "viewer" } : undefined,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/settings/polling/:job/enable", () => {
  it("is admin-only: 401 without a session, 403 for a non-admin or unknown user, and nothing changes", async () => {
    const { app, store } = await setup({ procore_polling: { ...DISABLED_ROW } });
    const handlers = app.routes[ENABLE];

    const anon = await invokeRoute(handlers, { params: { job: "procore" }, session: {} });
    expect(anon.status).toHaveBeenCalledWith(401);

    const viewer = await invokeRoute(handlers, { params: { job: "procore" }, session: { userId: "viewer-1" } });
    expect(viewer.status).toHaveBeenCalledWith(403);

    const ghost = await invokeRoute(handlers, { params: { job: "procore" }, session: { userId: "deleted-user" } });
    expect(ghost.status).toHaveBeenCalledWith(403);

    expect(store.procore_polling).toEqual(DISABLED_ROW);
    expect(mocks.storage.upsertAutomationConfig).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();
  });

  it("only an admin may write data_retention through the generic config route; other keys keep the signed-in rule", async () => {
    const { app, store } = await setup({});
    const put = app.routes["PUT /api/automation-config"];

    for (const key of ["data_retention", " Data_Retention "]) {
      const viewer = await invokeRoute(put, { body: { key, value: { enabled: true } }, session: { userId: "viewer-1" } });
      expect(viewer.status).toHaveBeenCalledWith(403);
    }
    expect(Object.keys(store).filter((k) => /retention/i.test(k))).toEqual([]);

    const admin = await invokeRoute(put, { body: { key: "data_retention", value: { enabled: true } }, session: { userId: "admin-1" } });
    expect(admin.status).not.toHaveBeenCalledWith(403);
    expect(store.data_retention).toEqual({ enabled: true });

    const other = await invokeRoute(put, { body: { key: "portfolio_auto_trigger", value: { enabled: true } }, session: { userId: "viewer-1" } });
    expect(other.status).not.toHaveBeenCalledWith(403);
    expect(store.portfolio_auto_trigger).toEqual({ enabled: true });
  });

  it("every other door that re-enables an auth-disabled job needs an admin too; ordinary writes do not", async () => {
    const { app, store } = await setup({ procore_polling: { ...DISABLED_ROW }, hubspot_polling: { ...DISABLED_ROW } });
    const viewer = { session: { userId: "viewer-1" } };

    const toggle = await invokeRoute(app.routes["POST /api/automation/procore-polling/config"], { ...viewer, body: { enabled: true, intervalMinutes: 20 } });
    expect(toggle.status).toHaveBeenCalledWith(403);
    const hub = await invokeRoute(app.routes["POST /api/automation/polling/config"], { ...viewer, body: { enabled: true } });
    expect(hub.status).toHaveBeenCalledWith(403);
    const put = await invokeRoute(app.routes["PUT /api/automation-config"], { ...viewer, body: { key: "hubspot_polling", value: { enabled: true, intervalMinutes: 11 } } });
    expect(put.status).toHaveBeenCalledWith(403);
    expect(store.procore_polling).toEqual(DISABLED_ROW);
    expect(store.hubspot_polling).toEqual(DISABLED_ROW);

    // Turning it OFF is not a re-enable, and a job that was not auth-disabled keeps the signed-in rule.
    const off = await invokeRoute(app.routes["POST /api/automation/procore-polling/config"], { ...viewer, body: { enabled: false, intervalMinutes: 20 } });
    expect(off.status).not.toHaveBeenCalledWith(403);
    const plain = await invokeRoute(app.routes["POST /api/automation/procore-polling/config"], { ...viewer, body: { enabled: true, intervalMinutes: 20 } });
    expect(plain.status).not.toHaveBeenCalledWith(403);
    expect(store.procore_polling).toMatchObject({ enabled: true });

    const admin = await invokeRoute(app.routes["POST /api/automation/polling/config"], { session: { userId: "admin-1" }, body: { enabled: true } });
    expect(admin.status).not.toHaveBeenCalledWith(403);
    expect(store.hubspot_polling).toMatchObject({ enabled: true });
  });

  it("for an admin: clears disabledReason, keeps the interval, restarts the timer and audits", async () => {
    const { app, store, status } = await setup({ procore_polling: { ...DISABLED_ROW } });
    expect((await status()).procore_polling.active).toBe(false);

    const res = await invokeRoute(app.routes[ENABLE], { params: { job: "procore" }, session: { userId: "admin-1" } });

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, job: "procore_polling", enabled: true, intervalMinutes: 20 }),
    );
    expect(store.procore_polling).toEqual({ enabled: true, intervalMinutes: 20 });
    expect((await status()).procore_polling).toMatchObject({ enabled: true, active: true });

    expect(mocks.storage.createAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.storage.createAuditLog.mock.calls[0][0]).toMatchObject({
      action: "polling_reenabled",
      entityType: "procore_polling",
      source: "admin",
      status: "success",
      category: "system",
      userId: "admin-1",
      details: { previous: { enabled: false, disabledReason: "auth_expired", disabledAt: "2026-06-10T08:00:00.000Z" } },
    });
  });

  it("re-enables HubSpot polling the same way", async () => {
    const { app, store, status } = await setup({ hubspot_polling: { ...DISABLED_ROW, intervalMinutes: 10 } });
    await invokeRoute(app.routes[ENABLE], { params: { job: "hubspot" }, session: { userId: "admin-1" } });
    expect(store.hubspot_polling).toEqual({ enabled: true, intervalMinutes: 10 });
    expect((await status()).hubspot_polling).toMatchObject({ enabled: true, active: true });
    expect(mocks.storage.createAuditLog.mock.calls[0][0]).toMatchObject({ action: "polling_reenabled", entityType: "hubspot_polling" });
  });

  it("rejects an unknown job (including prototype keys) without writing", async () => {
    const { app } = await setup({});
    for (const job of ["role", "constructor", "__proto__"]) {
      const res = await invokeRoute(app.routes[ENABLE], { params: { job }, session: { userId: "admin-1" } });
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(mocks.storage.upsertAutomationConfig).not.toHaveBeenCalled();
    expect(mocks.storage.createAuditLog).not.toHaveBeenCalled();
  });

  it("falls back to the boot default interval when the stored one is unusable", async () => {
    const { app, store } = await setup({ procore_polling: { ...DISABLED_ROW, intervalMinutes: -5 } });
    await invokeRoute(app.routes[ENABLE], { params: { job: "procore" }, session: { userId: "admin-1" } });
    expect(store.procore_polling).toEqual({ enabled: true, intervalMinutes: 17 });
  });
});
