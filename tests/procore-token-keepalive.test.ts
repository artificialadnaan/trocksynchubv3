import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Procore token keep-alive (owner 2026-11-11: the Procore pollers go off, the shared token must stay fresh). Every
// 10 minutes it asks getAccessToken() for a token with 30 minutes left: a token with less is renewed through the existing
// advisory-locked refresh (ONE POST to /oauth/token), a token with more is left alone, and nothing else is ever called.
// The real procore.ts runs here; its database, storage and network are mocked (as in procore-refresh-single-flight).

type Row = { access_token: string; refresh_token: string | null; expires_at: Date | null };

const h = vi.hoisted(() => {
  const state: { row: Row | null } = { row: null };
  function makeClient() {
    return {
      query: vi.fn(async (sqlOrConfig: string | { text: string; values?: unknown[] }, maybeParams: unknown[] = []) => {
        const sql = typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text;
        const params = typeof sqlOrConfig === "string" ? maybeParams : (sqlOrConfig.values ?? maybeParams);
        const s = sql.trim().toUpperCase();
        if (s.startsWith("BEGIN") || s.startsWith("SET LOCAL") || s.startsWith("COMMIT") || s.startsWith("ROLLBACK")) {
          return { rows: [] };
        }
        if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [{}] };
        if (/^INSERT\s+INTO\s+oauth_tokens/i.test(sql.trim())) {
          const [, accessToken, refreshToken, , expiresAt] = params as [string, string, string, string, string | Date];
          state.row = { access_token: accessToken, refresh_token: refreshToken, expires_at: new Date(expiresAt) };
          return { rows: [] };
        }
        if (/from\s+oauth_tokens/i.test(sql)) {
          const r = state.row;
          const text = r?.expires_at ? r.expires_at.toISOString().replace("T", " ").replace("Z", "") : null;
          return { rows: r ? [{ ...r, expires_at: text }] : [] };
        }
        throw new Error(`unexpected SQL in test: ${sql}`);
      }),
      release: vi.fn(),
    };
  }
  const storage = {
    getOAuthToken: vi.fn(async (_p: string) => {
      const r = state.row;
      return r ? { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at } : undefined;
    }),
    upsertOAuthToken: vi.fn(),
    getAutomationConfig: vi.fn(async (_key: string) => ({
      value: { clientId: "client-id", clientSecret: "client-secret", companyId: "4280", environment: "production" },
    })),
  };
  const fetchWithTimeout = vi.fn();
  const pool = { connect: vi.fn(async () => makeClient()), query: vi.fn(async () => ({ rows: [] })) };
  return { state, storage, fetchWithTimeout, pool };
});

vi.mock("../server/storage.ts", () => ({ storage: h.storage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: h.pool }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: h.fetchWithTimeout }));

const keepalive = await import("../server/procore-token-keepalive.ts");

const MIN = 60_000;
const REFRESH_TOKEN = "RT-STORED-NEVER-LOGGED";
const withLeft = (minutes: number): Row => ({
  access_token: "AT-OLD",
  refresh_token: REFRESH_TOKEN,
  expires_at: new Date(Date.now() + minutes * MIN),
});
const fetchedUrls = () => h.fetchWithTimeout.mock.calls.map((c: any[]) => String(c[0]));

beforeEach(() => {
  h.state.row = null;
  h.fetchWithTimeout.mockReset();
  h.storage.getOAuthToken.mockClear();
  h.fetchWithTimeout.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 5400 }),
    text: async () => "",
  }));
});

afterEach(() => {
  keepalive.stopProcoreTokenKeepAlive();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("procore token keep-alive", () => {
  it("runs every 10 minutes and asks for 30 minutes of validity", () => {
    expect(keepalive.PROCORE_TOKEN_KEEPALIVE_INTERVAL_MS).toBe(10 * MIN);
    expect(keepalive.PROCORE_TOKEN_KEEPALIVE_MIN_VALIDITY_MS).toBe(30 * MIN);
  });

  it("asks getAccessToken for a token with 30 minutes left", async () => {
    const getAccessToken = vi.fn(async () => "AT");
    const outcome = await keepalive.runProcoreTokenKeepAliveTick({ getAccessToken });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledWith({ minValidityMs: 30 * MIN });
    expect(outcome).toBe("ok");
  });

  it("renews a token with less than 30 minutes left: one POST, to /oauth/token, and the new token is stored", async () => {
    h.state.row = withLeft(20);
    const outcome = await keepalive.runProcoreTokenKeepAliveTick();
    expect(outcome).toBe("ok");
    expect(fetchedUrls()).toHaveLength(1);
    expect(fetchedUrls()[0]).toMatch(/\/oauth\/token$/);
    expect(h.state.row?.access_token).toBe("AT-NEW");
    expect(h.state.row!.expires_at!.getTime()).toBeGreaterThan(Date.now() + 80 * MIN);
  });

  it("leaves a token with more than 30 minutes left alone: no network call at all", async () => {
    h.state.row = withLeft(40);
    const outcome = await keepalive.runProcoreTokenKeepAliveTick();
    expect(outcome).toBe("ok");
    expect(fetchedUrls()).toHaveLength(0);
    expect(h.state.row?.access_token).toBe("AT-OLD");
  });

  it("never calls a Procore data API", async () => {
    h.state.row = withLeft(5);
    await keepalive.runProcoreTokenKeepAliveTick();
    h.state.row = withLeft(45);
    await keepalive.runProcoreTokenKeepAliveTick();
    expect(fetchedUrls().length).toBeGreaterThan(0);
    for (const url of fetchedUrls()) {
      expect(url).toMatch(/\/oauth\/token$/);
      expect(url).not.toContain("/rest/");
    }
  });

  it("a failed renewal does not throw, reports failed, and logs no token", async () => {
    h.state.row = withLeft(5);
    h.fetchWithTimeout.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
      json: async () => ({}),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await keepalive.runProcoreTokenKeepAliveTick();
    expect(outcome).toBe("failed");
    expect(warn).toHaveBeenCalled();
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logged).not.toContain("AT-OLD");
  });

  it("the timer ticks every 10 minutes, starts once, and stops", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    h.state.row = withLeft(45);
    keepalive.startProcoreTokenKeepAlive();
    keepalive.startProcoreTokenKeepAlive();
    expect(h.storage.getOAuthToken).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.storage.getOAuthToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.storage.getOAuthToken).toHaveBeenCalledTimes(2);
    keepalive.stopProcoreTokenKeepAlive();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(h.storage.getOAuthToken).toHaveBeenCalledTimes(2);
  });

  it("the server starts it with the other workers (server/routes/index.ts)", () => {
    const src = readFileSync(new URL("../server/routes/index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ startProcoreTokenKeepAlive \} from "\.\.\/procore-token-keepalive"/);
    expect(src).toMatch(/^\s*startProcoreTokenKeepAlive\(\);/m);
  });
});
