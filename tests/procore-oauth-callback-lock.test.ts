import { beforeEach, describe, expect, it, vi } from "vitest";

// v9 P3: the Procore OAuth callback stored the new token pair through the pool, outside the refresh lock, so a
// reconnect could interleave with a refresh (the refresh re-reads, spends, writes). The callback's write now goes
// through storeProcoreTokenPairUnderLock, which holds pg_advisory_xact_lock(hashtext('procore-oauth-refresh')).
// The authorization-code exchange itself spends no refresh token and is unchanged. Everything is mocked.

const h = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(),
    upsertOAuthToken: vi.fn(),
    createAuditLog: vi.fn(),
  },
  storeProcoreTokenPairUnderLock: vi.fn(),
  axiosPost: vi.fn(),
}));

// The shared PostgreSQL claim is covered by oauth-state-cross-replica.pglite.test.ts; route suites use an in-memory stand-in.
vi.mock("../server/lib/oauth-state-store.ts", () => {
  const seen = new Set<string>();
  return { claimOAuthStateOnce: async (hash: string) => (seen.has(hash) ? false : (seen.add(hash), true)) };
});
vi.mock("../server/storage.ts", () => ({ storage: h.storage }));
vi.mock("../server/procore.ts", () => ({ storeProcoreTokenPairUnderLock: h.storeProcoreTokenPairUnderLock }));
vi.mock("axios", () => ({ default: { post: h.axiosPost } }));
// oauth.ts imports requireAdmin from routes/settings.ts, whose import has startup side effects (DB migrations, SESSION_SECRET): this suite drives the
// handler behind it, so the gate is a stub here (the real gate is exercised in procore-oauth-admin-state.test.ts).
vi.mock("../server/routes/settings.ts", () => ({ requireAdmin: (_q: any, _s: any, n: any) => n() }));

const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");

function routes() {
  const r: Record<string, any[]> = {};
  const app: any = {
    get: vi.fn((p: string, ...hs: any[]) => (r[`GET ${p}`] = hs)),
    post: vi.fn((p: string, ...hs: any[]) => (r[`POST ${p}`] = hs)),
  };
  registerOAuthRoutes(app, (_q: any, _s: any, n: any) => n());
  return r;
}

// The route is now [requireAdmin, handler] (H4): this suite is about what the handler does once admitted, so it takes the handler (the last
// function in the chain) and gives it a request whose session holds the issued one-shot state. The admin/state gating is tested in
// procore-oauth-admin-state.test.ts.
const finalHandler = () => routes()["GET /api/oauth/procore/callback"].at(-1)!;
// A fresh state per request, as production issues them: a consumed state is remembered in the process, so a fixed value cannot be reused across cases.
const callbackReq = () => {
  const state = `issued-state-${Math.random().toString(36).slice(2)}`;
  return { query: { code: "auth-code", state }, session: { procoreOAuthState: { state, at: Date.now() } } };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.storage.getAutomationConfig.mockResolvedValue({ value: { clientId: "cid", clientSecret: "csecret", environment: "production" } });
  h.storage.createAuditLog.mockResolvedValue({});
  h.storeProcoreTokenPairUnderLock.mockResolvedValue(undefined);
  h.axiosPost.mockResolvedValue({ data: { access_token: "AT-CB", refresh_token: "RT-CB", expires_in: 7200 } });
});

describe("GET /api/oauth/procore/callback", () => {
  it("stores the new pair under the refresh lock, never through storage.upsertOAuthToken", async () => {
    const handler = finalHandler();
    const res: any = { status: vi.fn(() => res), json: vi.fn(), redirect: vi.fn() };
    const next = vi.fn();
    handler(callbackReq(), res, next);
    await vi.waitFor(() => expect(res.redirect).toHaveBeenCalledWith("/#/settings?procore=connected"));
    expect(next).not.toHaveBeenCalled();
    expect(h.storeProcoreTokenPairUnderLock).toHaveBeenCalledTimes(1);
    const [pair] = h.storeProcoreTokenPairUnderLock.mock.calls[0];
    expect(pair).toEqual({ accessToken: "AT-CB", refreshToken: "RT-CB", expiresAt: expect.any(Date) });
    expect(h.storage.upsertOAuthToken).not.toHaveBeenCalled();
  });

  it("a failed locked write surfaces as an error and is not reported as connected", async () => {
    h.storeProcoreTokenPairUnderLock.mockRejectedValueOnce(new Error("lock timeout"));
    const handler = finalHandler();
    const res: any = { status: vi.fn(() => res), json: vi.fn(), redirect: vi.fn() };
    const next = vi.fn();
    handler(callbackReq(), res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(expect.any(Error)));
    expect(res.redirect).not.toHaveBeenCalled();
    expect(h.storage.createAuditLog).not.toHaveBeenCalled();
  });
});
