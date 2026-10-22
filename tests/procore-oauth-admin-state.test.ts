import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// H4 (security rotation, 2026-10-22): /api/oauth/procore/authorize and /callback need an ADMIN session and a one-shot `state`.
// Storage is mocked; the session is an in-memory object keyed by an `x-test-session` header.
const users = vi.hoisted(() => new Map<string, any>([["admin-1", { id: "admin-1", role: "admin" }], ["user-1", { id: "user-1", role: "viewer" }]]));
const tokenPostMock = vi.hoisted(() => vi.fn(async () => ({ data: { access_token: "a", refresh_token: "r", expires_in: 3600 } })));
const storeTokensMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getUser: vi.fn(async (id: string) => users.get(id)),
    getAutomationConfig: vi.fn(async () => ({ value: { clientId: "cid", clientSecret: "x", environment: "production" } })),
    createAuditLog: vi.fn(async () => undefined),
  },
}));
vi.mock("axios", () => ({ default: { post: tokenPostMock } }));
vi.mock("../server/procore.ts", () => ({ storeProcoreTokenPairUnderLock: storeTokensMock }));
vi.mock("../server/routes/settings.ts", async () => {
  // the real requireAdmin, against the mocked storage
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
  app.use((req: any, _res, next) => {
    const sid = req.header("x-test-session");
    req.session = sid ? (sessions[sid] ??= {}) : {};
    next();
  });
  registerOAuthRoutes(app, (_req: any, _res: any, next: any) => next());
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}
const get = (base: string, path: string, sid?: string) => fetch(`${base}${path}`, { redirect: "manual", headers: sid ? { "x-test-session": sid } : {} });
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("Procore OAuth routes: admin session + one-shot state", () => {
  beforeEach(() => {
    for (const k of Object.keys(sessions)) delete sessions[k];
    sessions.admin = { userId: "admin-1" };
    sessions.user = { userId: "user-1" };
    tokenPostMock.mockClear();
    storeTokensMock.mockClear();
  });

  it("authorize: no session → 401, non-admin → 403, admin → a URL carrying a 64-hex state that is also kept in that session", async () => {
    await withApp(async (base) => {
      expect((await get(base, "/api/oauth/procore/authorize")).status).toBe(401);
      expect((await get(base, "/api/oauth/procore/authorize", "user")).status).toBe(403);
      const r = await get(base, "/api/oauth/procore/authorize", "admin");
      expect(r.status).toBe(200);
      const { url } = await r.json();
      expect(stateOf(url)).toMatch(/^[0-9a-f]{64}$/);
      expect(sessions.admin.procoreOAuthState.state).toBe(stateOf(url));
    });
  });

  it("callback: no session → 401 and non-admin → 403, and neither reaches Procore", async () => {
    await withApp(async (base) => {
      expect((await get(base, "/api/oauth/procore/callback?code=c&state=s")).status).toBe(401);
      expect((await get(base, "/api/oauth/procore/callback?code=c&state=s", "user")).status).toBe(403);
      expect(tokenPostMock).not.toHaveBeenCalled();
      expect(storeTokensMock).not.toHaveBeenCalled();
    });
  });

  it("callback: a missing, wrong, or never-issued state is refused with 400 and exchanges nothing", async () => {
    await withApp(async (base) => {
      expect((await get(base, "/api/oauth/procore/callback?code=c", "admin")).status).toBe(400); // no state issued at all
      const { url } = await (await get(base, "/api/oauth/procore/authorize", "admin")).json();
      expect((await get(base, "/api/oauth/procore/callback?code=c", "admin")).status).toBe(400); // issued, but none sent (and now consumed)
      await get(base, "/api/oauth/procore/authorize", "admin");
      expect((await get(base, `/api/oauth/procore/callback?code=c&state=${"0".repeat(64)}`, "admin")).status).toBe(400); // wrong
      expect(stateOf(url)).toHaveLength(64);
      expect(tokenPostMock).not.toHaveBeenCalled();
      expect(storeTokensMock).not.toHaveBeenCalled();
    });
  });

  it("callback: the right state connects once; replaying it is refused; a stale state is refused", async () => {
    await withApp(async (base) => {
      const { url } = await (await get(base, "/api/oauth/procore/authorize", "admin")).json();
      const ok = await get(base, `/api/oauth/procore/callback?code=c&state=${stateOf(url)}`, "admin");
      expect(ok.status).toBe(302);
      expect(tokenPostMock).toHaveBeenCalledTimes(1);
      expect(storeTokensMock).toHaveBeenCalledTimes(1);
      expect((await get(base, `/api/oauth/procore/callback?code=c&state=${stateOf(url)}`, "admin")).status).toBe(400); // replay
      expect(tokenPostMock).toHaveBeenCalledTimes(1);

      const second = await (await get(base, "/api/oauth/procore/authorize", "admin")).json();
      sessions.admin.procoreOAuthState.at = Date.now() - 11 * 60 * 1000; // older than the 10-minute window
      expect((await get(base, `/api/oauth/procore/callback?code=c&state=${stateOf(second.url)}`, "admin")).status).toBe(400);
      expect(tokenPostMock).toHaveBeenCalledTimes(1);
    });
  });

  it("another admin's state does not work in this session (the state is bound to the session that asked)", async () => {
    await withApp(async (base) => {
      sessions.admin2 = { userId: "admin-1" };
      const { url } = await (await get(base, "/api/oauth/procore/authorize", "admin")).json();
      expect((await get(base, `/api/oauth/procore/callback?code=c&state=${stateOf(url)}`, "admin2")).status).toBe(400);
      expect(tokenPostMock).not.toHaveBeenCalled();
    });
  });
});
