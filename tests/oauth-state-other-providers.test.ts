import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// H4b (security rotation, 2026-10-22): HubSpot, Microsoft and Google (Gmail) authorize/callback get the same admin session + one-shot state as Procore.
const users = vi.hoisted(() => new Map<string, any>([["admin-1", { id: "admin-1", role: "admin" }], ["user-1", { id: "user-1", role: "viewer" }]]));
const exchange = vi.hoisted(() => ({
  hubspot: vi.fn(async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600 })),
  microsoft: vi.fn(async () => ({})),
  gmail: vi.fn(async () => ({})),
}));
const upsertToken = vi.hoisted(() => vi.fn(async () => undefined));

// The shared PostgreSQL claim is covered by oauth-state-cross-replica.pglite.test.ts; route suites use an in-memory stand-in.
vi.mock("../server/lib/oauth-state-store.ts", () => {
  const seen = new Set<string>();
  return { claimOAuthStateOnce: async (hash: string) => (seen.has(hash) ? false : (seen.add(hash), true)) };
});
vi.mock("../server/storage.ts", () => ({
  storage: {
    getUser: vi.fn(async (id: string) => users.get(id)),
    createAuditLog: vi.fn(async () => undefined),
    upsertOAuthToken: upsertToken,
  },
}));
vi.mock("../server/hubspot.ts", () => ({
  getHubSpotAuthUrl: () => "https://app.hubspot.com/oauth/authorize?client_id=cid&response_type=code",
  getHubSpotOAuthConfig: () => ({ clientId: "cid" }),
  exchangeHubSpotCode: exchange.hubspot,
}));
vi.mock("../server/microsoft.ts", () => ({
  getMicrosoftAuthUrl: async () => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=cid&response_type=code",
  exchangeMicrosoftCode: exchange.microsoft,
}));
vi.mock("../server/gmail.ts", () => ({
  getGmailAuthUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&response_type=code",
  exchangeGoogleCode: exchange.gmail,
}));
vi.mock("../server/procore.ts", () => ({ storeProcoreTokenPairUnderLock: vi.fn() }));
vi.mock("axios", () => ({ default: { post: vi.fn() } }));
vi.mock("../server/routes/settings.ts", async () => {
  const { storage } = await import("../server/storage.ts");
  return {
    requireAdmin: async (req: any, res: any, next: any) => {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const user = await (storage as any).getUser(userId);
      if (!user || user.role !== "admin") return res.status(403).json({ message: "Admin only" });
      return next();
    },
  };
});

const sessions: Record<string, any> = {};
async function withApp(fn: (base: string) => Promise<void>) {
  const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { const sid = req.header("x-test-session"); req.session = sid ? (sessions[sid] ??= {}) : {}; next(); });
  registerOAuthRoutes(app, (_req: any, _res: any, next: any) => next());
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server");
  try { await fn(`http://127.0.0.1:${addr.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))); }
}
const get = (base: string, path: string, sid?: string) => fetch(`${base}${path}`, { redirect: "manual", headers: sid ? { "x-test-session": sid } : {} });
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

const PROVIDERS = [
  { name: "hubspot", route: "hubspot", fn: exchange.hubspot, errorKey: "hubspot", ok: "/#/settings?hubspot=connected" },
  { name: "microsoft", route: "microsoft", fn: exchange.microsoft, errorKey: "microsoft", ok: "/#/settings?microsoft=connected" },
  { name: "google", route: "google", fn: exchange.gmail, errorKey: "gmail", ok: "/#/settings?gmail=connected" },
] as const;

describe.each(PROVIDERS)("$name OAuth routes: admin session + one-shot state", (p) => {
  beforeEach(() => {
    for (const k of Object.keys(sessions)) delete sessions[k];
    sessions.admin = { userId: "admin-1" };
    sessions.user = { userId: "user-1" };
    Object.values(exchange).forEach((f) => f.mockClear());
    upsertToken.mockClear();
  });

  it("authorize: no session → 401, non-admin → 403, admin → a URL carrying a 64-hex state kept in that session", async () => {
    await withApp(async (base) => {
      const a = `/api/oauth/${p.route}/authorize`;
      expect((await get(base, a)).status).toBe(401);
      expect((await get(base, a, "user")).status).toBe(403);
      const r = await get(base, a, "admin");
      expect(r.status).toBe(200);
      const { url } = await r.json();
      expect(stateOf(url)).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.values(sessions.admin).some((v: any) => v?.state === stateOf(url))).toBe(true);
    });
  });

  it("callback: no session → 401 and non-admin → 403, exchanging nothing", async () => {
    await withApp(async (base) => {
      const c = `/api/oauth/${p.route}/callback?code=c&state=s`;
      expect((await get(base, c)).status).toBe(401);
      expect((await get(base, c, "user")).status).toBe(403);
      expect(p.fn).not.toHaveBeenCalled();
    });
  });

  it("callback: a missing, wrong or never-issued state redirects to Settings with an error and exchanges nothing", async () => {
    await withApp(async (base) => {
      const c = (q: string) => `/api/oauth/${p.route}/callback?code=c${q}`;
      const never = await get(base, c(""), "admin");
      expect(never.status).toBe(302);
      expect(never.headers.get("location")).toContain(`${p.errorKey}=error`);
      await get(base, `/api/oauth/${p.route}/authorize`, "admin");
      expect((await get(base, c(`&state=${"0".repeat(64)}`), "admin")).status).toBe(302);
      expect(p.fn).not.toHaveBeenCalled();
      expect(upsertToken).not.toHaveBeenCalled();
    });
  });

  it("callback: the right state connects once; replay and a stale state are refused; another session's state does not work", async () => {
    await withApp(async (base) => {
      const { url } = await (await get(base, `/api/oauth/${p.route}/authorize`, "admin")).json();
      const ok = await get(base, `/api/oauth/${p.route}/callback?code=c&state=${stateOf(url)}`, "admin");
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe(p.ok);
      expect(p.fn).toHaveBeenCalledTimes(1);
      const replay = await get(base, `/api/oauth/${p.route}/callback?code=c&state=${stateOf(url)}`, "admin");
      expect(replay.headers.get("location")).toContain("error");
      expect(p.fn).toHaveBeenCalledTimes(1);

      const second = await (await get(base, `/api/oauth/${p.route}/authorize`, "admin")).json();
      const key = Object.keys(sessions.admin).find((k) => k.endsWith("OAuthState"))!;
      sessions.admin[key].at = Date.now() - 11 * 60 * 1000;
      expect((await get(base, `/api/oauth/${p.route}/callback?code=c&state=${stateOf(second.url)}`, "admin")).headers.get("location")).toContain("error");

      sessions.admin2 = { userId: "admin-1" };
      const third = await (await get(base, `/api/oauth/${p.route}/authorize`, "admin")).json();
      expect((await get(base, `/api/oauth/${p.route}/callback?code=c&state=${stateOf(third.url)}`, "admin2")).headers.get("location")).toContain("error");
      expect(p.fn).toHaveBeenCalledTimes(1);
    });
  });
});
