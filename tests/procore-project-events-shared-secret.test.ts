import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSharedSecretHeader, projectEventsAuthGuard, projectEventsMode } from "../server/webhooks/shared-secret.ts";

// H6 (security rotation, 2026-10-22): POST /webhooks/procore/project-events had NO verification. A shared secret in the Authorization header, in two
// modes: OBSERVE (allow + log, so Procore events keep flowing while the header is rolled out) and ENFORCE (fails closed).
const SECRET = "project-events-secret-not-real-0123";

describe("projectEventsMode: only unset or \"log\" leaves the route open; everything else enforces", () => {
  it("log / unset → log; enforce → enforce; a typo or any other value → enforce (never fail open)", () => {
    expect(projectEventsMode({} as any)).toEqual({ enforce: false, recognised: true });
    expect(projectEventsMode({ WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: "log" } as any)).toEqual({ enforce: false, recognised: true });
    expect(projectEventsMode({ WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: " LOG " } as any)).toEqual({ enforce: false, recognised: true });
    expect(projectEventsMode({ WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: "enforce" } as any)).toEqual({ enforce: true, recognised: true });
    for (const typo of ["Enforced", "on", "true", "1", "strict", "banana"]) {
      expect(projectEventsMode({ WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: typo } as any), typo).toEqual({ enforce: true, recognised: false });
    }
  });
});

describe("checkSharedSecretHeader", () => {
  it("OBSERVE: always allows, and reports what it saw (valid / missing / invalid / unconfigured)", () => {
    const base = { enforce: false };
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: SECRET })).toMatchObject({ allow: true, auth: "valid", enforced: false });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: undefined })).toMatchObject({ allow: true, auth: "missing" });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: "wrong" })).toMatchObject({ allow: true, auth: "invalid" });
    expect(checkSharedSecretHeader({ ...base, secret: undefined, header: SECRET })).toMatchObject({ allow: true, auth: "unconfigured" });
  });
  it("ENFORCE fails closed: unconfigured → 503, missing or wrong → 401, only the exact secret (or 'Bearer <secret>') is allowed", () => {
    const base = { enforce: true };
    expect(checkSharedSecretHeader({ ...base, secret: "", header: SECRET })).toEqual({ allow: false, status: 503, auth: "unconfigured", enforced: true });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: undefined })).toMatchObject({ allow: false, status: 401, auth: "missing" });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: SECRET + "x" })).toMatchObject({ allow: false, status: 401, auth: "invalid" });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: SECRET })).toMatchObject({ allow: true, auth: "valid" });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: `Bearer ${SECRET}` })).toMatchObject({ allow: true, auth: "valid" });
    expect(checkSharedSecretHeader({ ...base, secret: SECRET, header: ["wrong", SECRET] })).toMatchObject({ allow: false }); // only the first header value counts
  });
  it("never logs the header or the secret", () => {
    const lines: string[] = [];
    const guard = projectEventsAuthGuard({ PROCORE_PROJECT_EVENTS_SECRET: SECRET, WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: "enforce" } as any, (l) => lines.push(l));
    guard({ headers: { authorization: "attacker-guess-123" } }, { status: () => ({ json: () => undefined }) }, () => undefined);
    guard({ headers: { authorization: SECRET } }, { status: () => ({ json: () => undefined }) }, () => undefined);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain("attacker-guess-123");
    expect(lines[0]).toContain("auth=invalid");
    expect(lines[1]).toContain("auth=valid");
  });
});

// ---- the real route wiring ----------------------------------------------------------------------------------------------------------
const handlerMock = vi.hoisted(() => vi.fn((_req: any, res: any) => { res.status(200).json({ received: true }); }));
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/procore.ts", () => ({ syncProcoreRoleAssignments: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn() }));
vi.mock("../server/email-notifications.ts", () => ({ sendStageChangeEmail: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ processHubspotWebhookForProcore: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ mapProcoreStageToHubspot: vi.fn(), resolveHubspotStageId: vi.fn(), findOrCreateMappingByProjectNumber: vi.fn(), getTerminalStageGuard: vi.fn() }));
vi.mock("../server/webhooks/procore-webhook.ts", () => ({ handleProcoreProjectWebhook: handlerMock }));
vi.mock("../server/webhooks/migration-mode.ts", () => ({ evaluateWebhookPortfolioPhase2Gate: vi.fn(), getWebhookMigrationModeConfig: vi.fn(), isMigrationMode: vi.fn(), logWebhookSuppressedAction: vi.fn() }));
vi.mock("../server/routes/settings.ts", () => ({ recordWebhookRoleEvent: vi.fn() }));
vi.mock("../server/procore-rate-limiter.ts", () => ({ markProjectWebhookUpdated: vi.fn() }));
vi.mock("../server/lib/async-handler.ts", () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock("../server/db.ts", () => ({ db: {} }));

async function withApp(fn: (base: string) => Promise<void>) {
  const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
  const app = express();
  app.use(express.json());
  registerWebhookRoutes(app);
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server");
  try { await fn(`http://127.0.0.1:${addr.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))); }
}
const post = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/webhooks/procore/project-events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ resource_type: "Projects", resource_id: "1" }) });

describe("POST /webhooks/procore/project-events", () => {
  const prior = { s: process.env.PROCORE_PROJECT_EVENTS_SECRET, e: process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE };
  beforeEach(() => { handlerMock.mockClear(); delete process.env.PROCORE_PROJECT_EVENTS_SECRET; delete process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE; vi.spyOn(console, "log").mockImplementation(() => undefined); vi.spyOn(console, "error").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => {
    if (prior.s === undefined) delete process.env.PROCORE_PROJECT_EVENTS_SECRET; else process.env.PROCORE_PROJECT_EVENTS_SECRET = prior.s;
    if (prior.e === undefined) delete process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE; else process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE = prior.e;
    vi.restoreAllMocks();
  });

  it("OBSERVE (the default): unsigned and mis-signed events still reach the handler, so Procore keeps flowing", async () => {
    await withApp(async (base) => {
      expect((await post(base)).status).toBe(200);
      process.env.PROCORE_PROJECT_EVENTS_SECRET = SECRET;
      expect((await post(base, { authorization: "wrong" })).status).toBe(200);
      expect(handlerMock).toHaveBeenCalledTimes(2);
    });
  });
  it("a mistyped mode (\"Enforced\") enforces: the route never silently stays open", async () => {
    await withApp(async (base) => {
      process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE = "Enforced";
      process.env.PROCORE_PROJECT_EVENTS_SECRET = SECRET;
      expect((await post(base)).status).toBe(401);
      expect(handlerMock).not.toHaveBeenCalled();
    });
  });
  it("ENFORCE: no secret → 503; no / wrong header → 401 and the handler is never reached; the right header reaches it", async () => {
    await withApp(async (base) => {
      process.env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE = "enforce";
      expect((await post(base, { authorization: SECRET })).status).toBe(503); // enforcing with nothing configured never fails open
      process.env.PROCORE_PROJECT_EVENTS_SECRET = SECRET;
      expect((await post(base)).status).toBe(401);
      expect((await post(base, { authorization: "wrong" })).status).toBe(401);
      expect(handlerMock).not.toHaveBeenCalled();
      expect((await post(base, { authorization: SECRET })).status).toBe(200);
      expect(handlerMock).toHaveBeenCalledTimes(1);
    });
  });
});
