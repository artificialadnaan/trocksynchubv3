import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Procore refresh tokens are SINGLE-USE. The in-process promise mutex only serialises refreshes inside one
// Node process; two replicas (or a deploy overlap) could each read the same refresh token and both spend it,
// and the loser's refresh fails, logging SyncHub out of Procore. The refresh now runs inside a Postgres
// transaction on ONE dedicated client that holds pg_advisory_xact_lock(hashtext('procore-oauth-refresh')),
// RE-READS the token row once the lock is held, and writes the new pair on that SAME client before COMMIT (a
// second pool connection could lose the write after Procore has spent the old token). Everything here is
// mocked: no database, no network.

const LOCK_KEY = "procore-oauth-refresh";

type Row = { access_token: string; refresh_token: string | null; expires_at: Date | null };

const h = vi.hoisted(() => {
  const state: {
    row: Row | null;
    events: string[];
    trace: string[];
    queries: Array<{ sql: string; params: unknown[]; queryTimeout?: number }>;
    lockTail: Promise<void>;
    released: number;
    connects: number;
    releaseArgs: unknown[];
    failOn: { BEGIN?: boolean; ROLLBACK?: boolean; LOCK?: boolean; COMMIT?: boolean };
  } = {
    row: null,
    events: [],
    trace: [],
    queries: [],
    lockTail: Promise.resolve(),
    released: 0,
    connects: 0,
    releaseArgs: [],
    failOn: {},
  };

  /** A fake pg client: an advisory xact lock that really serialises, released on COMMIT/ROLLBACK. */
  function makeClient() {
    let releaseLock: (() => void) | null = null;
    const endTx = () => {
      if (releaseLock) {
        releaseLock();
        releaseLock = null;
      }
    };
    const ev = (e: string) => {
      state.events.push(e);
      state.trace.push(`client:${e}`);
    };
    return {
      query: vi.fn(async (sqlOrConfig: string | { text: string; values?: unknown[]; query_timeout?: number }, maybeParams: unknown[] = []) => {
        const sql = typeof sqlOrConfig === "string" ? sqlOrConfig : sqlOrConfig.text;
        const params = typeof sqlOrConfig === "string" ? maybeParams : (sqlOrConfig.values ?? maybeParams);
        const queryTimeout = typeof sqlOrConfig === "string" ? undefined : sqlOrConfig.query_timeout;
        state.queries.push({ sql, params, queryTimeout });
        const s = sql.trim().toUpperCase();
        if (s.startsWith("BEGIN")) {
          if (state.failOn.BEGIN) throw new Error("connection terminated during BEGIN");
          ev("BEGIN");
          return { rows: [] };
        }
        if (s.startsWith("SET LOCAL")) {
          ev("SET");
          return { rows: [] };
        }
        if (/pg_advisory_xact_lock/i.test(sql)) {
          if (state.failOn.LOCK) {
            throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
          }
          const prev = state.lockTail;
          let mine!: () => void;
          state.lockTail = new Promise<void>((r) => (mine = r));
          await prev;
          releaseLock = mine;
          ev("LOCK");
          return { rows: [{}] };
        }
        if (/^INSERT\s+INTO\s+oauth_tokens/i.test(sql.trim())) {
          ev("UPSERT");
          const [provider, accessToken, refreshToken, , expiresAt] = params as [string, string, string, string, string | Date];
          expect(provider).toBe("procore");
          state.row = { access_token: accessToken, refresh_token: refreshToken, expires_at: new Date(expiresAt) };
          return { rows: [] };
        }
        if (/from\s+oauth_tokens/i.test(sql)) {
          ev("READ");
          // Postgres' text form of a zone-less timestamp (UTC wall clock), as `expires_at::text` returns it.
          const r = state.row;
          const text = r?.expires_at ? r.expires_at.toISOString().replace("T", " ").replace("Z", "") : null;
          return { rows: r ? [{ ...r, expires_at: text }] : [] };
        }
        if (s.startsWith("COMMIT")) {
          if (state.failOn.COMMIT) throw new Error("connection terminated during COMMIT");
          ev("COMMIT");
          endTx();
          return { rows: [] };
        }
        if (s.startsWith("ROLLBACK")) {
          if (state.failOn.ROLLBACK) throw new Error("connection terminated during ROLLBACK");
          ev("ROLLBACK");
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
      state.trace.push("pool:getOAuthToken");
      const r = state.row;
      return r ? { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at } : undefined;
    }),
    upsertOAuthToken: vi.fn(async (data: any) => {
      state.trace.push("pool:upsertOAuthToken");
      state.row = { access_token: data.accessToken, refresh_token: data.refreshToken, expires_at: data.expiresAt };
      return data;
    }),
    getAutomationConfig: vi.fn(async (_key: string) => {
      state.trace.push("pool:getAutomationConfig");
      return { value: { clientId: "client-id", clientSecret: "client-secret", companyId: "4280", environment: "production" } };
    }),
  };

  const fetchWithTimeout = vi.fn();
  const pool = {
    connect: vi.fn(async () => {
      state.connects++;
      return makeClient();
    }),
    query: vi.fn(async () => {
      state.trace.push("pool:query");
      return { rows: [] };
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
const failedRefresh = async () => {
  h.state.trace.push("fetch");
  return { ok: false, status: 400, text: async () => "invalid_grant", json: async () => ({}) };
};

function sentRefreshTokens(): unknown[] {
  return h.fetchWithTimeout.mock.calls.map((c: any[]) => JSON.parse(c[1].body).refresh_token);
}
const upserts = () => h.state.events.filter((e) => e === "UPSERT").length;

beforeEach(() => {
  h.state.row = null;
  h.state.events = [];
  h.state.trace = [];
  h.state.queries = [];
  h.state.lockTail = Promise.resolve();
  h.state.released = 0;
  h.state.connects = 0;
  h.state.releaseArgs = [];
  h.state.failOn = {};
  h.fetchWithTimeout.mockReset();
  h.storage.upsertOAuthToken.mockClear();
  h.storage.getOAuthToken.mockClear();
  h.pool.connect.mockClear();
  let n = 1;
  h.fetchWithTimeout.mockImplementation(async () => {
    h.state.trace.push("fetch");
    await new Promise((r) => setTimeout(r, 5)); // Procore takes a moment, so a second caller is really waiting
    n++;
    return okRefreshResponse(n);
  });
});

// A test that times out never reaches its own finally: never let fake timers leak into the next test.
afterEach(() => {
  vi.useRealTimers();
});

describe("refreshProcoreAccessTokenUnderLock (cross-replica single flight)", () => {
  it("takes pg_advisory_xact_lock(hashtext('procore-oauth-refresh')) inside a transaction on a dedicated client", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");

    const lock = h.state.queries.find((q) => /pg_advisory_xact_lock/i.test(q.sql));
    expect(lock, "the advisory lock SQL is issued").toBeTruthy();
    expect(lock!.sql).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(/i);
    expect(`${lock!.sql} ${JSON.stringify(lock!.params)}`).toContain(LOCK_KEY);
    // BEGIN, the two SET LOCAL timeouts, the lock, the re-read, the new pair written on THIS client, then COMMIT.
    expect(h.state.events).toEqual(["BEGIN", "SET", "SET", "LOCK", "READ", "UPSERT", "COMMIT"]);
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
    expect(upserts()).toBe(1);
    expect(h.state.released).toBe(2);
  });

  it("a waiter that finds a freshly refreshed row does NOT call /oauth/token", async () => {
    h.state.row = { access_token: "AT-FRESH", refresh_token: "RT-FRESH", expires_at: later() };
    const token = await procore.refreshProcoreAccessTokenUnderLock("RT-FRESH");
    expect(token).toBe("AT-FRESH");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(upserts()).toBe(0);
    expect(h.state.released).toBe(1);
  });

  it("a stale refresh token passed in is never sent to Procore; a rotated pair that is still fresh is returned as is", async () => {
    // Another replica already spent RT-OLD and stored RT-NEW with plenty of life left.
    h.state.row = { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_at: later() };
    const token = await procore.refreshProcoreAccessTokenUnderLock("RT-OLD");
    expect(token).toBe("AT-NEW");
    expect(sentRefreshTokens()).not.toContain("RT-OLD");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("a rotated pair that is already near expiry is REFRESHED with the locked token, not returned stale", async () => {
    // Another replica stored RT-NEW, but its access token has < minValidity left: refreshing is right, and the
    // single-use protection comes from sending the token read under the lock (RT-NEW), never the caller's RT-OLD.
    h.state.row = { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_at: soon() };
    const token = await procore.refreshProcoreAccessTokenUnderLock("RT-OLD");
    expect(token).toBe("AT-2");
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(sentRefreshTokens()).toEqual(["RT-NEW"]);
    expect(h.state.row?.refresh_token).toBe("RT-2");
  });

  it("a rotated pair whose expiry is unknown (null) is refreshed too", async () => {
    h.state.row = { access_token: "AT-NEW", refresh_token: "RT-NEW", expires_at: null };
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-OLD")).resolves.toBe("AT-2");
    expect(sentRefreshTokens()).toEqual(["RT-NEW"]);
  });

  it("the refresh sends the refresh token READ UNDER THE LOCK", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-ROW", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-ROW");
    expect(sentRefreshTokens()).toEqual(["RT-ROW"]);
  });

  it("a failed Procore refresh ROLLs BACK and releases the client (no upsert, no COMMIT)", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.fetchWithTimeout.mockImplementation(failedRefresh);
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/Failed to refresh Procore token/);
    expect(h.state.events).toEqual(["BEGIN", "SET", "SET", "LOCK", "READ", "ROLLBACK"]);
    expect(upserts()).toBe(0);
    expect(h.state.released).toBe(1);
  });

  it("no stored row under the lock -> throws without calling Procore, and releases", async () => {
    h.state.row = null;
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/No Procore OAuth token/);
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(h.state.released).toBe(1);
  });
});

describe("v9 P1: the new pair is written on the SAME locked client, inside the transaction", () => {
  it("the upsert SQL runs on the tx client before COMMIT; no pool query between the Procore call and COMMIT", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");
    expect(h.storage.upsertOAuthToken).not.toHaveBeenCalled();
    const t = h.state.trace;
    const iFetch = t.indexOf("fetch");
    const iUpsert = t.indexOf("client:UPSERT");
    const iCommit = t.indexOf("client:COMMIT");
    expect(iFetch).toBeGreaterThan(-1);
    expect(iUpsert).toBeGreaterThan(iFetch);
    expect(iCommit).toBeGreaterThan(iUpsert);
    expect(t.slice(iFetch, iCommit).filter((e) => e.startsWith("pool:"))).toEqual([]);
    expect(h.state.row).toEqual({ access_token: "AT-2", refresh_token: "RT-2", expires_at: expect.any(Date) });
  });

  it("a Procore response without a new refresh token keeps the one read under the lock", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.fetchWithTimeout.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "AT-X", expires_in: 7200 }),
      text: async () => "",
    }));
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");
    expect(h.state.row?.refresh_token).toBe("RT-1");
    expect(h.state.row?.access_token).toBe("AT-X");
  });
});

describe("v9 P2: lock waits get their own timeouts; a timed-out wait falls back to a fresh row or fails cleanly", () => {
  const ms = (sql: string, name: string): number | null => {
    const m = new RegExp(`SET\\s+LOCAL\\s+${name}\\s*=\\s*'?(\\d+)`, "i").exec(sql);
    return m ? Number(m[1]) : null;
  };

  it("SET LOCAL statement_timeout / lock_timeout right after BEGIN, both above the 30 s Procore fetch timeout", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    await procore.refreshProcoreAccessTokenUnderLock("RT-1");
    const sqls = h.state.queries.map((q) => q.sql);
    expect(sqls[0]).toMatch(/^BEGIN/i);
    const statement = sqls.map((s) => ms(s, "statement_timeout")).find((v) => v !== null);
    const lockT = sqls.map((s) => ms(s, "lock_timeout")).find((v) => v !== null);
    expect(statement).toBeGreaterThan(30_000);
    expect(lockT).toBeGreaterThan(30_000);
    expect(statement!).toBeGreaterThan(lockT!);
    // Both SET LOCALs come before the lock is requested.
    const iLock = sqls.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    expect(sqls.slice(1, iLock).every((s) => /^SET LOCAL/i.test(s))).toBe(true);
    expect(iLock).toBe(3);
    // The pool's client-side 30 s query_timeout would cut the lock wait short: the lock query carries a longer one.
    const lockQ = h.state.queries[iLock];
    expect(lockQ.queryTimeout).toBeGreaterThan(lockT!);
    // The refresh fetch itself is bounded by an explicit 30 s timeout.
    expect(h.fetchWithTimeout.mock.calls[0][2]).toBe(30_000);
  });

  it("a lock wait that times out re-reads the row and returns it when it is fresh (no Procore call)", async () => {
    h.state.row = { access_token: "AT-FRESH", refresh_token: "RT-FRESH", expires_at: later() };
    h.state.failOn.LOCK = true;
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-OLD")).resolves.toBe("AT-FRESH");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(h.state.releaseArgs).toHaveLength(1);
    expect(h.state.releaseArgs[0]).toBeTruthy(); // not a clean COMMIT -> destroyed
  });

  it("a lock wait that times out on a still-near-expiry row fails cleanly, without calling Procore", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.state.failOn.LOCK = true;
    await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/timed out waiting/i);
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
    expect(upserts()).toBe(0);
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
    h.fetchWithTimeout.mockImplementation(failedRefresh);
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
    h.fetchWithTimeout.mockImplementation(failedRefresh);
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

  it("an unknown expiry (NULL) with a refresh token counts as 'needs refresh': one locked refresh, a fresh token returned", async () => {
    h.state.row = { access_token: "AT-NULL", refresh_token: "RT-NULL", expires_at: null };
    expect(await procore.getAccessToken({ minValidityMs: 5 * 60_000 })).toBe("AT-2");
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(sentRefreshTokens()).toEqual(["RT-NULL"]);
    // The stored row now has a real expiry, so the next call is served without another refresh.
    expect(h.state.row?.expires_at).toBeInstanceOf(Date);
    expect(await procore.getAccessToken({ minValidityMs: 5 * 60_000 })).toBe("AT-2");
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("an unknown expiry with NO refresh token behaves as before: the stored token, no lock, no Procore call", async () => {
    h.state.row = { access_token: "AT-NULL", refresh_token: null, expires_at: null };
    expect(await procore.getAccessToken()).toBe("AT-NULL");
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("minValidityMs is configurable: 3 min left is fine by default, but refreshes when the caller needs >= 5 min", async () => {
    h.state.row = { access_token: "AT-3MIN", refresh_token: "RT-3MIN", expires_at: new Date(Date.now() + 3 * 60_000) };
    expect(await procore.getAccessToken()).toBe("AT-3MIN");
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();

    // Under the lock the same threshold applies: a row with 3 min left is NOT "refreshed meanwhile" for this caller.
    expect(await procore.getAccessToken({ minValidityMs: 5 * 60_000 })).toBe("AT-2");
    expect(sentRefreshTokens()).toEqual(["RT-3MIN"]);
  });
});

describe("v9 P3: the OAuth callback's write takes the same advisory lock", () => {
  it("storeProcoreTokenPairUnderLock writes the pair on the locked client inside one transaction", async () => {
    const expiresAt = later();
    await procore.storeProcoreTokenPairUnderLock({ accessToken: "AT-CB", refreshToken: "RT-CB", expiresAt });
    expect(h.state.events).toEqual(["BEGIN", "SET", "SET", "LOCK", "UPSERT", "COMMIT"]);
    const lock = h.state.queries.find((q) => /pg_advisory_xact_lock/i.test(q.sql));
    expect(`${lock!.sql} ${JSON.stringify(lock!.params)}`).toContain(LOCK_KEY);
    expect(h.state.row).toEqual({ access_token: "AT-CB", refresh_token: "RT-CB", expires_at: expiresAt });
    expect(h.storage.upsertOAuthToken).not.toHaveBeenCalled();
    expect(h.state.releaseArgs).toEqual([undefined]);
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("a callback write waits for an in-flight refresh to COMMIT (no interleaving)", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    const refresh = procore.refreshProcoreAccessTokenUnderLock("RT-1");
    await new Promise((r) => setTimeout(r, 1)); // the refresh holds the lock and is talking to Procore
    const store = procore.storeProcoreTokenPairUnderLock({ accessToken: "AT-CB", refreshToken: "RT-CB", expiresAt: later() });
    await Promise.all([refresh, store]);
    const commits = h.state.events.map((e, i) => [e, i] as const).filter(([e]) => e === "COMMIT" || e === "UPSERT");
    // refresh UPSERT, refresh COMMIT, then the callback's UPSERT, COMMIT
    expect(commits.map(([e]) => e)).toEqual(["UPSERT", "COMMIT", "UPSERT", "COMMIT"]);
    expect(h.state.row?.refresh_token).toBe("RT-CB");
  });

  it("a failed callback write destroys the client and rethrows", async () => {
    h.state.failOn.BEGIN = true;
    await expect(
      procore.storeProcoreTokenPairUnderLock({ accessToken: "AT-CB", refreshToken: "RT-CB", expiresAt: later() }),
    ).rejects.toThrow();
    expect(h.state.releaseArgs[0]).toBeTruthy();
  });
});

describe("Codex P2: the refresh's 30 s deadline covers reading the body, not just the headers", () => {
  it("a body that never resolves aborts within 30 s; the lock is released (ROLLBACK + release(true)), nothing stored", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
      let signal: AbortSignal | undefined;
      h.fetchWithTimeout.mockImplementation(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        // Headers arrived; the body stalls forever (only an abort would end a real one).
        return { ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) };
      });
      let settled = false;
      const p = procore.refreshProcoreAccessTokenUnderLock("RT-1").finally(() => (settled = true));
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      expect(signal, "the refresh passes its own deadline signal").toBeDefined();
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(p).rejects.toThrow(/timed out/i);
      expect(signal!.aborted).toBe(true);
      expect(h.state.events).toEqual(["BEGIN", "SET", "SET", "LOCK", "READ", "ROLLBACK"]);
      expect(h.state.releaseArgs).toEqual([true]);
      expect(upserts()).toBe(0);
      // The lock is free again: a later refresh is not stuck behind the stalled one.
      vi.useRealTimers();
      h.fetchWithTimeout.mockImplementation(async () => okRefreshResponse(7));
      await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).resolves.toBe("AT-7");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error body that never resolves is bounded the same way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
      h.fetchWithTimeout.mockImplementation(async () => ({ ok: false, status: 500, json: () => new Promise(() => {}), text: () => new Promise(() => {}) }));
      const p = procore.refreshProcoreAccessTokenUnderLock("RT-1");
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(30_500);
      await expect(p).rejects.toThrow(/timed out/i);
      expect(h.state.releaseArgs).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a COMMIT that fails after Procore answered is logged at error level (the stored pair may be stale)", () => {
  it("logs the new pair's expiresAt and the attempt time, never a token", async () => {
    h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
    h.state.failOn.COMMIT = true;
    const lines: Record<string, string[]> = { log: [], warn: [], error: [], info: [] };
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines[m].push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(" "))),
    );
    const before = Date.now();
    try {
      await expect(procore.refreshProcoreAccessTokenUnderLock("RT-1")).rejects.toThrow(/COMMIT/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(h.fetchWithTimeout).toHaveBeenCalledTimes(1); // Procore answered: RT-1 is spent, AT-2/RT-2 issued
    const err = lines.error.join("\n");
    expect(err).toMatch(/stale/i);
    const isoStamps = err.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
    expect(isoStamps.length).toBeGreaterThanOrEqual(2); // the new pair's expiresAt and the attempt time
    const expiresAtLogged = isoStamps.map((t) => Date.parse(t)).filter((t) => t > before + 7000 * 1000);
    expect(expiresAtLogged.length).toBe(1); // expires_in 7200 s
    const all = Object.values(lines).flat().join("\n");
    for (const token of ["AT-2", "RT-2", "RT-1", "AT-1", "client-secret"]) expect(all).not.toContain(token);
    expect(h.state.releaseArgs).toEqual([true]);
  });

  it("a COMMIT failure BEFORE any Procore call (refreshed-meanwhile path) logs no stale-pair error", async () => {
    h.state.row = { access_token: "AT-FRESH", refresh_token: "RT-FRESH", expires_at: later() };
    h.state.failOn.COMMIT = true;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    try {
      await expect(procore.refreshProcoreAccessTokenUnderLock("RT-FRESH")).rejects.toThrow(/COMMIT/);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).not.toMatch(/stale/i);
  });
});

describe("Codex P2: a deadline that is already aborted never leaves the body promise rejecting unhandled", () => {
  for (const kind of ["ok (json)", "error (text)"] as const) {
    it(`${kind}: headers arrive after the deadline and the body rejects -> no unhandledRejection`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        h.state.row = { access_token: "AT-1", refresh_token: "RT-1", expires_at: soon() };
        const bodyRejects = () => Promise.reject(new Error("BODY-ABORTED-UNHANDLED-PROBE"));
        // A fetch that ignores the signal and answers only after the 30 s deadline has fired.
        h.fetchWithTimeout.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: kind === "ok (json)", status: kind === "ok (json)" ? 200 : 500, json: bodyRejects, text: bodyRejects }), 31_000),
            ),
        );
        const p = procore.refreshProcoreAccessTokenUnderLock("RT-1");
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(31_000);
        await expect(p).rejects.toThrow(/timed out/i);
        vi.useRealTimers();
        // Let Node's unhandled-rejection detection run (it fires after the microtask queue drains).
        for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 20));
        const probes = unhandled.filter((r) => r instanceof Error && r.message === "BODY-ABORTED-UNHANDLED-PROBE");
        expect(probes).toEqual([]);
        expect(h.state.releaseArgs).toEqual([true]);
      } finally {
        vi.useRealTimers();
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }
});
