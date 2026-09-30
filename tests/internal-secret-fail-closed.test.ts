import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

// Six /api/internal/* endpoints have no session auth; they are gated only by the x-internal-secret header.
// They used to compare it against `process.env.INTERNAL_API_SECRET || <a literal committed to the repo>`,
// and production does not set the variable, so the committed literal was the live secret. They now share
// one guard (server/internal-auth.ts) that fails CLOSED: unset/blank env -> 503, missing/wrong header -> 401,
// constant-time compare, and no fallback value anywhere.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    getAutomationConfigs: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    patchAutomationConfig: vi.fn(),
    getSyncMappings: vi.fn(),
    getSyncMappingByBidboardProjectId: vi.fn(),
    getWebhookLogs: vi.fn(),
  },
  sendEmail: vi.fn(),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("../server/procore.ts", () => ({
  syncProcoreRoleAssignments: vi.fn(),
  syncProcoreRoleAssignmentsBatch: vi.fn(),
  runFullProcoreSync: vi.fn(),
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
  withBrowserLock: vi.fn(),
}));
vi.mock("../server/email-service", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../server/stage-notifications", () => ({ buildStageNotificationEmail: vi.fn(() => "<p>test</p>") }));

const { requireInternalSecret, internalSecretMatches, getConfiguredInternalSecret } = await import(
  "../server/internal-auth.ts"
);

function createFakeApp() {
  const routes: Record<string, any[]> = {};
  const record = (verb: string) =>
    vi.fn((p: string, ...handlers: any[]) => {
      routes[`${verb} ${p}`] = handlers;
    });
  return { routes, get: record("GET"), post: record("POST"), put: record("PUT"), patch: record("PATCH"), delete: record("DELETE") };
}

/**
 * Run the handler chain and wait for EVERY handler to settle. Express middleware calls next() without
 * returning it, so awaiting only the first handler would not wait for the route handler behind the gate.
 */
async function invokeRoute(handlers: any[], req: Record<string, unknown> = {}) {
  const res: any = { status: vi.fn(() => res), json: vi.fn(), locals: {} };
  const pending: Promise<unknown>[] = [];
  let index = 0;
  const next: any = vi.fn((err?: unknown) => {
    if (err) throw err;
    const handler = handlers[index++];
    if (!handler) return undefined;
    const p = Promise.resolve(handler(req, res, next));
    pending.push(p);
    return p;
  });
  next();
  for (let i = 0; i < pending.length; i++) await pending[i];
  return res;
}

const INTERNAL_ROUTES = [
  "POST /api/internal/enable-all-automations",
  "POST /api/internal/test-stage-notification",
  "POST /api/internal/sync-change-orders",
  "POST /api/internal/debug-deal",
  "POST /api/internal/portfolio-trigger",
  "POST /api/internal/portfolio-phase2",
] as const;

/** Each route with a body that, once past the gate, ends in a cheap, side-effect-free response. */
const PASS_THROUGH: Record<string, { body: Record<string, unknown>; expect: (res: any) => void }> = {
  "POST /api/internal/test-stage-notification": {
    body: { to: "ops@example.test", stage: "Estimating" },
    expect: (res) => {
      expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    },
  },
  "POST /api/internal/sync-change-orders": {
    body: {},
    expect: (res) => expect(res.json).toHaveBeenCalledWith({ error: "Provide portfolioProjectId or projectNumber" }),
  },
  "POST /api/internal/debug-deal": {
    body: {},
    expect: (res) => expect(res.json).toHaveBeenCalledWith({ error: "Provide dealId" }),
  },
  "POST /api/internal/portfolio-trigger": {
    body: {},
    expect: (res) => expect(res.json).toHaveBeenCalledWith({ error: "bidboardProjectId required" }),
  },
  "POST /api/internal/portfolio-phase2": {
    body: {},
    expect: (res) => expect(res.json).toHaveBeenCalledWith({ error: "companyId and portfolioProjectId required" }),
  },
};

async function registerAll() {
  const app = createFakeApp();
  const { registerSettingsRoutes } = await import("../server/routes/settings.ts");
  const { registerPortfolioRoutes } = await import("../server/routes/portfolio.ts");
  const passAuth = (_req: any, _res: any, next: any) => next();
  registerSettingsRoutes(app as any, passAuth);
  registerPortfolioRoutes(app as any, passAuth);
  // Registration kicks off async boot work that writes config; let it settle so that only calls made by a
  // request count below.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  for (const fn of Object.values(mocks.storage)) fn.mockClear();
  mocks.sendEmail.mockClear();
  return app.routes;
}

function storageTouched(): boolean {
  return Object.values(mocks.storage).some((fn) => fn.mock.calls.length > 0) || mocks.sendEmail.mock.calls.length > 0;
}

const SECRET = "a-configured-internal-secret-for-tests";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("INTERNAL_API_SECRET", "");
  mocks.storage.getAutomationConfig.mockResolvedValue(undefined);
  mocks.storage.upsertAutomationConfig.mockResolvedValue({});
  mocks.storage.patchAutomationConfig.mockImplementation(async (key: string, patch: any) => ({ key, value: patch }));
  mocks.sendEmail.mockResolvedValue({ success: true, provider: "test" });
});

describe("requireInternalSecret (unit)", () => {
  const run = async (headers: Record<string, unknown>, body: Record<string, unknown> = {}) => {
    const res: any = { status: vi.fn(() => res), json: vi.fn() };
    const next = vi.fn();
    await requireInternalSecret({ headers, body } as any, res, next);
    return { res, next };
  };

  it("fails CLOSED with 503 when INTERNAL_API_SECRET is unset or blank, even with a header", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.unstubAllEnvs();
      if (value === undefined) delete process.env.INTERNAL_API_SECRET;
      else vi.stubEnv("INTERNAL_API_SECRET", value);
      expect(getConfiguredInternalSecret()).toBeNull();
      const { res, next } = await run({ "x-internal-secret": "anything" });
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: "internal_secret_not_configured" });
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("401 on a missing, empty, wrong, prefix, or array-valued header", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    for (const headers of [{}, { "x-internal-secret": "" }, { "x-internal-secret": "wrong" }, { "x-internal-secret": SECRET.slice(0, -1) }, { "x-internal-secret": `${SECRET}x` }, { "x-internal-secret": [SECRET] }]) {
      const { res, next } = await run(headers);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("does not accept the secret in the body (header only)", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    const { res, next } = await run({}, { secret: SECRET });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("the right header passes through to next()", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    const { res, next } = await run({ "x-internal-secret": SECRET });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("compares in constant time via crypto.timingSafeEqual on equal-length buffers", async () => {
    const crypto = await import("crypto");
    const spy = vi.spyOn(crypto.default, "timingSafeEqual");
    expect(internalSecretMatches("short", "a-much-longer-expected-value")).toBe(false);
    expect(internalSecretMatches(SECRET, SECRET)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
    spy.mockRestore();
  });
});

describe("the six /api/internal endpoints", () => {
  it("are all registered with requireInternalSecret as their FIRST handler", async () => {
    const routes = await registerAll();
    for (const r of INTERNAL_ROUTES) {
      expect(routes[r], `${r} must exist`).toBeTruthy();
      expect(routes[r][0], `${r} must be gated first`).toBe(requireInternalSecret);
    }
  });

  it.each(INTERNAL_ROUTES)("%s: unset secret -> 503 and the handler never runs", async (route) => {
    delete process.env.INTERNAL_API_SECRET;
    const routes = await registerAll();
    const res = await invokeRoute(routes[route], { headers: { "x-internal-secret": "anything" }, body: { secret: "anything", dealId: "1", bidboardProjectId: "1" } });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ error: "internal_secret_not_configured" });
    expect(storageTouched()).toBe(false);
  });

  it.each(INTERNAL_ROUTES)("%s: wrong or missing header -> 401 and the handler never runs", async (route) => {
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    const routes = await registerAll();
    for (const headers of [{}, { "x-internal-secret": "wrong" }]) {
      vi.clearAllMocks();
      const res = await invokeRoute(routes[route], { headers, body: { secret: SECRET, dealId: "1", bidboardProjectId: "1" } });
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(storageTouched()).toBe(false);
    }
  });

  it.each(Object.keys(PASS_THROUGH))("%s: the right header reaches the handler", async (route) => {
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    const routes = await registerAll();
    const res = await invokeRoute(routes[route], { headers: { "x-internal-secret": SECRET }, body: PASS_THROUGH[route].body });
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(503);
    PASS_THROUGH[route].expect(res);
  });

  it("enable-all-automations: the right header reaches the handler (its registered gate calls next)", async () => {
    // Running the full enable-all handler starts pollers; tests/role-polling-enabled-clobber.test.ts runs it
    // end to end with the env var set. Here the registered gate is shown to hand off to the handler.
    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    const routes = await registerAll();
    const handler = vi.fn();
    const [gate] = routes["POST /api/internal/enable-all-automations"];
    const res = await invokeRoute([gate, handler], { headers: { "x-internal-secret": SECRET }, body: {} });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("no hard-coded fallback", () => {
  const serverDir = path.resolve(__dirname, "../server");
  const tsFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? tsFiles(p) : e.name.endsWith(".ts") ? [p] : [];
    });

  it("no server source defaults INTERNAL_API_SECRET, and only internal-auth.ts reads it or the header", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(serverDir)) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(serverDir, file);
      if (/INTERNAL_API_SECRET\s*(\|\||\?\?)/.test(src)) offenders.push(`${rel}: defaults INTERNAL_API_SECRET`);
      if (rel !== "internal-auth.ts" && /INTERNAL_API_SECRET|x-internal-secret/.test(src)) offenders.push(`${rel}: reads the secret outside the guard`);
    }
    expect(offenders).toEqual([]);
  });

  // The literal is recovered from git history at test time so it is never written into this repository again.
  // 732302c6661fb5e59892ee16872562b6d85f425c is the main commit this fix branched from; it still had the fallback.
  const OLD_COMMIT = "732302c6661fb5e59892ee16872562b6d85f425c";
  let oldFallback: string | null = null;
  try {
    const old = execFileSync("git", ["show", `${OLD_COMMIT}:server/routes/settings.ts`], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    oldFallback = /INTERNAL_API_SECRET \|\| (['"])([^'"\n]+)\1/.exec(old)?.[2] ?? null;
  } catch {
    oldFallback = null;
  }

  it.skipIf(oldFallback === null)("the old fallback value is refused: 503 when unset, 401 when another secret is set", async () => {
    const routes = await registerAll();
    const headers = { "x-internal-secret": oldFallback as string };

    delete process.env.INTERNAL_API_SECRET;
    for (const r of INTERNAL_ROUTES) {
      const res = await invokeRoute(routes[r], { headers, body: {} });
      expect(res.status.mock.calls.map((c: unknown[]) => c[0]), r).toEqual([503]);
    }

    vi.stubEnv("INTERNAL_API_SECRET", SECRET);
    for (const r of INTERNAL_ROUTES) {
      const res = await invokeRoute(routes[r], { headers, body: {} });
      expect(res.status.mock.calls.map((c: unknown[]) => c[0]), r).toEqual([401]);
    }
    expect(storageTouched()).toBe(false);
  });

  it.skipIf(oldFallback === null)("the old fallback literal no longer appears anywhere under server/ or tests/", () => {
    const roots = [serverDir, path.resolve(__dirname)];
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        if (fs.readFileSync(file, "utf8").includes(oldFallback as string)) hits.push(path.relative(path.resolve(__dirname, ".."), file));
      }
    }
    expect(hits).toEqual([]);
  });
});
