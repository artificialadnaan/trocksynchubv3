import { readdirSync, readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// S0b-2b residual (successor ec69 residualRuling; d9): the 35-min floor only gates the START of a recreate. Its create step has
// no enforced overall timeout, so a long one could still reach the normal client's 60 s renewal under the cross-replica lock.
// withoutProcoreTokenRenewal() closes that: code inside it never renews the Procore token, however long it runs. A short stored
// token fails closed (an error, no /oauth/token call, no lock taken). Outside the scope nothing changes. Everything is mocked:
// no database, no network. "Reaching the lock" = pool.connect, the first step of the cross-replica refresh.
// d9's contract (2026-11-10): (a) unchanged outside the scope; (b) a scoped refusal never joins or poisons the shared in-flight
// renewal; (c) a census of every /oauth/token site, with the refresh's own call behind the scope check.

const h = vi.hoisted(() => {
  const state: { row: { accessToken: string; refreshToken: string | null; expiresAt: Date | null } | null } = { row: null };
  const storage = {
    getOAuthToken: vi.fn(async (_p: string) => state.row ?? undefined),
    upsertOAuthToken: vi.fn(async (data: any) => data),
    getAutomationConfig: vi.fn(async (_key: string) => ({
      value: { clientId: "client-id", clientSecret: "client-secret", companyId: "4280", environment: "production" },
    })),
  };
  const fetchWithTimeout = vi.fn(async () => ({ ok: false, status: 599, text: async () => "test: no network", json: async () => ({}) }));
  const pool = {
    connect: vi.fn(async () => {
      throw new Error("test: the renewal reached the cross-replica lock");
    }),
    query: vi.fn(async () => ({ rows: [] })),
  };
  return { state, storage, fetchWithTimeout, pool };
});

vi.mock("../server/storage.ts", () => ({ storage: h.storage }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: h.pool }));
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: h.fetchWithTimeout }));

const procore = await import("../server/procore.ts");

const inMs = (ms: number) => new Date(Date.now() + ms);
const OFF = /Procore token renewal is off for /;

beforeEach(() => {
  h.state.row = null;
  h.storage.getOAuthToken.mockClear();
  h.storage.getAutomationConfig.mockClear();
  h.fetchWithTimeout.mockClear();
  h.pool.connect.mockClear();
});

describe("withoutProcoreTokenRenewal (the recreate's create step never renews; ec69 residual)", () => {
  it("inside: a stored token with 10 s left is refused, with no renewal attempt (no config read, no lock, no /oauth/token)", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    await expect(procore.withoutProcoreTokenRenewal("recreate of RFP request 7", () => procore.getAccessToken())).rejects.toThrow(OFF);
    expect(h.storage.getAutomationConfig).not.toHaveBeenCalled();
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("inside: an unknown expiry (NULL) with a refresh token is refused too, not renewed", async () => {
    h.state.row = { accessToken: "AT-null", refreshToken: "RT-1", expiresAt: null };
    await expect(procore.withoutProcoreTokenRenewal("recreate", () => procore.getAccessToken())).rejects.toThrow(OFF);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("inside: the locked refresh itself refuses before anything else, even when called directly", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    await expect(
      procore.withoutProcoreTokenRenewal("recreate", () => procore.refreshProcoreAccessTokenUnderLock("RT-1")),
    ).rejects.toThrow(OFF);
    expect(h.storage.getAutomationConfig).not.toHaveBeenCalled();
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("inside: the scope follows the work across awaits and timers (the create step is long and asynchronous)", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    const later = () =>
      new Promise<string>((resolve, reject) => setTimeout(() => procore.getAccessToken().then(resolve, reject), 1));
    await expect(
      procore.withoutProcoreTokenRenewal("recreate", async () => {
        await Promise.resolve();
        return later();
      }),
    ).rejects.toThrow(OFF);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("inside: the create step's client (getProcoreClient) fails closed the same way", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    await expect(procore.withoutProcoreTokenRenewal("recreate", () => procore.getProcoreClient())).rejects.toThrow(OFF);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("inside: a stored token with time left is used as stored (no renewal needed, none attempted)", async () => {
    h.state.row = { accessToken: "AT-long", refreshToken: "RT-1", expiresAt: inMs(2 * 3600_000) };
    await expect(procore.withoutProcoreTokenRenewal("recreate", () => procore.getAccessToken())).resolves.toBe("AT-long");
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(h.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("outside (control, d9 (a)): the same short token still goes to the normal renewal under the lock", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    await procore.getAccessToken().catch(() => undefined);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
  });

  it("the scope does not leak: after a scoped call ends, an unscoped call renews as before", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    await procore.withoutProcoreTokenRenewal("recreate", () => procore.getAccessToken()).catch(() => undefined);
    h.pool.connect.mockClear();
    await procore.getAccessToken().catch(() => undefined);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
  });

  it("a scoped refusal neither joins nor poisons an outside renewal already in flight (d9 (b))", async () => {
    h.state.row = { accessToken: "AT-short", refreshToken: "RT-1", expiresAt: inMs(10_000) };
    let release!: (e: Error) => void;
    h.pool.connect.mockImplementationOnce(() => new Promise<never>((_resolve, reject) => (release = reject)));
    const settle = (p: Promise<unknown>) => p.then(() => new Error("resolved"), (e: Error) => e);
    const outside = settle(procore.getAccessToken()); // starts the normal renewal; it waits at the lock
    for (let i = 0; i < 100 && h.pool.connect.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    const scoped = settle(procore.withoutProcoreTokenRenewal("recreate", () => procore.getAccessToken()));
    await new Promise((r) => setTimeout(r, 5)); // time for the scoped call to reach the renewal (and join it, if it could)
    release(new Error("test: the outside renewal ended at the lock"));
    expect((await scoped).message).toMatch(OFF);
    expect((await outside).message).toMatch(/the outside renewal ended at the lock/);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    h.pool.connect.mockClear();
    await procore.getAccessToken().catch(() => undefined);
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
  });

  it("census: /oauth/token appears only at the known sites, and the refresh's own call sits behind the scope check (d9 (c))", () => {
    const root = new URL("../", import.meta.url);
    const found: Record<string, number> = {};
    for (const dir of ["server", "scripts", "shared", "client/src"]) {
      let entries: string[];
      try {
        entries = readdirSync(new URL(`${dir}/`, root), { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const rel of entries) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel) || /\.test\.tsx?$/.test(rel) || rel.includes("node_modules")) continue;
        const n = readFileSync(new URL(`${dir}/${rel}`, root), "utf8").split("/oauth/token").length - 1;
        if (n > 0) found[`${dir}/${rel}`] = n;
      }
    }
    // procore.ts: the refresh's doc comment + its one POST; oauth.ts: the admin callback's authorization_code exchange (an inbound
    // HTTP route, not a renewal); procore-token-read.ts: a comment. A new site fails here and must be reviewed against the scope.
    expect(found).toEqual({ "server/procore.ts": 2, "server/routes/oauth.ts": 1, "server/routes/procore-token-read.ts": 1 });
    const src = readFileSync(new URL("../server/procore.ts", import.meta.url), "utf8");
    const start = src.indexOf("export async function refreshProcoreAccessTokenUnderLock(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("/oauth/token`");
    const open = body.indexOf("): Promise<string> {");
    expect(open).toBeGreaterThan(-1);
    expect(body.slice(open + "): Promise<string> {".length).trimStart().startsWith("refuseIfRenewalOff();")).toBe(true);
    const cb = readFileSync(new URL("../server/routes/oauth.ts", import.meta.url), "utf8");
    const at = cb.indexOf("/oauth/token");
    expect(cb.slice(at, at + 120)).toMatch(/grant_type: "authorization_code"/);
  });

  it("source pin: recreateApprovingRequest runs the create step (processRfpApproval) inside withoutProcoreTokenRenewal", () => {
    const approval = readFileSync(new URL("../server/rfp-approval.ts", import.meta.url), "utf8");
    const start = approval.indexOf("export async function recreateApprovingRequest");
    expect(start).toBeGreaterThan(-1);
    const end = approval.indexOf("\nexport ", start + 1);
    const body = approval.slice(start, end === -1 ? undefined : end);
    const scope = body.indexOf("withoutProcoreTokenRenewal(");
    expect(scope).toBeGreaterThan(-1);
    expect(body.indexOf("processRfpApproval(", scope)).toBeGreaterThan(scope);
    expect(body.slice(0, scope)).not.toMatch(/processRfpApproval\(/);
  });
});
