import { beforeEach, describe, expect, it, vi } from "vitest";

// Procore refresh tokens are SINGLE-USE. The in-process promise mutex only serialises refreshes inside one
// Node process; two replicas (or a deploy overlap) could each read the same refresh token and both spend it,
// and the loser's refresh fails, logging SyncHub out of Procore. The refresh now runs inside a Postgres
// transaction that holds pg_advisory_xact_lock(hashtext('procore-oauth-refresh')) and RE-READS the token row
// once the lock is held, so a waiter that finds the row already refreshed returns it without calling Procore.
// Everything here is mocked: no database, no network.

const LOCK_KEY = "procore-oauth-refresh";

type Row = { access_token: string; refresh_token: string | null; expires_at: Date | null };

const h = vi.hoisted(() => {
  const state: {
    row: Row | null;
    events: string[];
    queries: Array<{ sql: string; params: unknown[] }>;
    lockTail: Promise<void>;
    released: number;
    connects: number;
    releaseArgs: unknown[];
    failOn: { BEGIN?: boolean; ROLLBACK?: boolean };
  } = { row: null, events: [], queries: [], lockTail: Promise.resolve(), released: 0, connects: 0, releaseArgs: [], failOn: {} };

  /** A fake pg client: an advisory xact lock that really serialises, released on COMMIT/ROLLBACK. */
  function makeClient() {
    let releaseLock: (() => void) | null = null;
    const endTx = () => {
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      }
    };
    return {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        state.queries.push({ sql, params });
        const s = sql.trim().toUpperCase();
        if (s.startsWith("BEGIN")) {
          if (state.failOn.BEGIN) throw new Error("connection terminated during BEGIN");
          state.events.push("BEGIN");
          return { rows: [] };
        }
        if (/pg_advisory_xact_lock/i.test(sql)) {
          const prev = state.lockTail;
          let mine!: () => void;
          state.lockTail = new Promise<void>((r) => (mine = r));
          await prev;
          releaseLock = mine;
          state.events.push("LOCK");
          return { rows: [{}] };
        }
        if (/from\s+oauth_tokens/i.test(sql)) {
          state.events.push("READ");
          return { rows: state.row ? [{ ...state.row }] : [] };
        }
        if (s.startsWith("COMMIT")) {
          state.events.push("COMMIT");
          endTx();
          return { rows: [] };
        }
        if (s.startsWith("ROLLBACK")) {
          if (state.failOn.ROLLBACK) throw new Error("connection terminated during ROLLBACK");
          state.events.push("ROLLBACK");
          endTx();
          return { rows: [] };
        }
        throw new Error(`unexpected SQL in test: ${sql}`);
      }),
      release: vi.fn((arg?: unknown) => {
        state.releaseArgs.push(arg);
        state.released++;
      }),
    };
  }

  const storage = {
    getOAuthToken: vi.fn(async (_p: string) => {
      const r = state.row;
      return r ? { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at } : undefined;
    }),
    upsertOAuthToken: vi.fn(async (data: any) => {
      state.events.push("UPSERT");
      state.row = { access_token: data.accessToken, refresh_token: data.refreshToken, expires_at: data.expiresAt };
      return data;
    }),
    getAutomationConfig: vi.fn(async (_key: string) => ({
      value: { clientId: "client-id", clientSecret: "client-secret", companyId: "4280", environment: "production" },
    })),
  };

  const fetchWithTimeout = vi.fn();
  const pool = {
    connect: vi.fn(async () => {
      state.connects++;
      return makeClient();
    }),
  };
  return { state, storage, fetchWithTimeout, pool };
});

vi.mock("../server/storage.ts", () => ({ storage: h.storage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: h.pool }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: h.fetchWithTimeout }));

const procore = await import("../server/procore.ts");

const soon = () => new Date(Date.now() + 10_000); // inside the 60 s refresh window
const later = () => new Date(Date.now() + 2 * 3600_000);

function okRefreshResponse(n: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: `AT-${n}`, refresh_token: `RT-${n}`, expires_in: 7200 }),
    text: async () => "",
  };
}

function sentRefreshTokens(): unknown[] {
  return h.fetchWithTimeout.mock.calls.map((c: any[]) => JSON.parse(c[1].body).refresh_token);
}

beforeEach(() => {
  h.state.row = null;
  h.state.events = [];
  h.state.queries = [];
  h.state.lockTail = Promise.resolve();
  h.state.released = 0;
  h.state.connects = 0;
  h.state.releaseArgs = [];
  h.state.failOn = {};
  h.fetchWithTimeout.mockReset();
  h.storage.upsertOAuthToken.mockClear();
  h.pool.connect.mockClear();
  let n = 1;
  h.fetchWithTimeout.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5)); // Procore takes a moment, so a second caller is really waiting
    n++;
    return okRefreshResponse(n);
  });
});

describe("refreshProcoreAccessTokenUnderLock (cross-replica single flight)", () => {
  it("takes pg_advisory_xact_lock(hashtext('procore-oauth-refresh')) inside a transaction on a dedicated client", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");

    const lock = h.state.queries.find((q) => /pg_advisory_xact_lock/i.test(q.sql));
    expect(lock, "the advisory lock SQL is issued").toBeTruthy();
    expect(lock!.sql).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(/i);
    expect(`${lock!.sql} ${JSON.stringify(lock!.params)}`).toContain(LOCK_KEY);
    // BEGIN, then the lock, then the re-read, then Procore + upsert, and only then COMMIT.
    expect(h.state.events).toEqual(["BEGIN", "LOCK", "READ", "UPSERT", "COMMIT"]);
    expect(h.state.released).toBe(1);
  });

  it("two concurrent refreshes (two 'replicas') call /oauth/token ONCE; the second gets the refreshed row", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    const [a, b] = await Promise.all([
      procore.refreshProcoreAccessTokenUnderLock("RT-1"),
      procore.refreshProcoreAccessTokenUnderLock("RT-1"),
    ]);
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(sentRefreshTokens()).toEqual(["RT-1"]);
    expect(a).toBe("AT-2");
    expect(b).toBe("AT-2");
    expect(h.storage.upsertOAuthToken).toHaveBeenCalledTimes(1);
    expect(h.state.released).toBe(2);
  });

  it("a waiter that finds a freshly refreshed row does NOT call /oauth/token", async () => {
    h.state.row = { access_token: "AT-FRESH", refresh_token: "RT-FRESH", expires_at: later() };
    const token = await procore.refreshProcoreAccessTokenUnderLock("RT-FRESH");
    expect(token).toBe("AT-FRESH");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(h.storage.upsertOAuthToken).not.toHaveBeenCalled();
    expect(h.state.released).toBe(1);
  });

  it("a stale refresh token passed in is never sent to Procore (the row's newer pair wins)", async () => {
    // Another replica already spent RT-OLD and stored RT-NEW, even though the new pair is near expiry.
    h.state.row = { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_at: soon() };
    const token = await procore.refreshProcoreAccessTokenUnderLock("RT-OLD");
    expect(token).toBe("AT-NEW");
    expect(sentRefreshTokens()).not.toContain("RT-OLD");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("the refresh sends the refresh token READ UNDER THE LOCK", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-ROW", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-ROW");
    expect(sentRefreshTokens()).toEqual(["RT-ROW"]);
  });

  it("a failed Procore refresh ROLLs BACK and releases the client (no upsert, no COMMIT)", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.fetchWithTimeout.mockImplementation(async () => ({ ok: false, status: 400, text: async () => "invalid_grant", json: async () => ({}) }));
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/Failed to refresh Procore token/);
    expect(h.state.events).toEqual(["BEGIN", "LOCK", "READ", "ROLLBACK"]);
    expect(h.storage.upsertOAuthToken).not.toHaveBeenCalled();
    expect(h.state.released).toBe(1);
  });

  it("no stored row under the lock -> throws without calling Procore, and releases", async () => {
    h.state.row = null;
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/No Procore OAuth token/);
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(h.state.released).toBe(1);
  });
});

describe("the pool client is destroyed, never reused, unless the transaction ended in a clean COMMIT", () => {
  it("a clean COMMIT returns the client with a plain release()", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");
    expect(h.state.releaseArgs).toEqual([undefined]);
  });

  it("the refreshed-meanwhile COMMIT also returns it with a plain release()", async () => {
    h.state.row = { access_token: "AT-FRESH", refresh_token: "RT-FRESH", expires_at: later() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-FRESH");
    expect(h.state.releaseArgs).toEqual([undefined]);
  });

  it("ROLLBACK rejecting -> release is called with a truthy argument (destroy), and the original error surfaces", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.state.failOn.ROLLBACK = true;
    h.fetchWithTimeout.mockImplementation(async () => ({ ok: false, status: 400, text: async () => "invalid_grant", json: async () => ({}) }));
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/Failed to refresh Procore token/);
    expect(h.state.releaseArgs).toHaveLength(1);
    expect(h.state.releaseArgs[0]).toBeTruthy();
  });

  it("BEGIN throwing -> release is called with a truthy argument; no lock, no Procore call", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.state.failOn.BEGIN = true;
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/BEGIN/);
    expect(h.state.events).not.toContain("LOCK");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(h.state.releaseArgs).toHaveLength(1);
    expect(h.state.releaseArgs[0]).toBeTruthy();
  });

  it("a failure rolled back cleanly still destroys the client (plain release only after COMMIT)", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.fetchWithTimeout.mockImplementation(async () => ({ ok: false, status: 400, text: async () => "invalid_grant", json: async () => ({}) }));
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow();
    expect(h.state.events).toContain("ROLLBACK");
    expect(h.state.releaseArgs[0]).toBeTruthy();
  });
});

describe("getAccessToken goes through the locked refresh, and keeps the in-process mutex", () => {
  it("a near-expiry token refreshes via the lock; two concurrent callers in one process share one refresh", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    const [a, b] = await Promise.all([procore.getAccessToken(), procore.getAccessToken()]);
    expect(a).toBe("AT-2");
    expect(b).toBe("AT-2");
    expect(h.pool.connect).toHaveBeenCalledTimes(1); // the in-process mutex collapsed the two callers
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("a valid token is returned without touching the lock or Procore", async () => {
    h.state.row = { access_token: "AT-OK", refresh_token: "RT-OK", expires_at: later() };
    expect(await procore.getAccessToken()).toBe("AT-OK");
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
