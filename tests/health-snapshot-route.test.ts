import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/internal/health/snapshot (integration-health S2): T-Rock Core's signed, read-only fetch of SyncHub's health
// snapshot. Auth is procore-token-read's scheme byte for byte (CONTRACT ADDENDUM-1 ruling 3) with its own secret pair,
// SYNCHUB_HEALTH_READ_SECRET_CURRENT / _PREVIOUS (>= 32 bytes, fail closed). The collector is mocked here; its reads are
// tested on PGlite (health-snapshot-collect.pglite.test.ts). Synthetic values only.

const h = vi.hoisted(() => ({ collect: vi.fn(), connect: vi.fn(), release: vi.fn() }));
vi.mock("../server/health/collect-synchub.ts", () => ({ collectSynchubSnapshot: h.collect }));
// The default lease: one client from the shared pool, wrapped for drizzle. Both faked; nothing connects.
vi.mock("../server/db.ts", () => ({ pool: { connect: h.connect }, db: {} }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: (client: unknown) => ({ client }) }));

const { registerHealthSnapshotRoutes, createHealthSnapshotHandler, HEALTH_SNAPSHOT_PATH } = await import("../server/routes/health-snapshot.ts");

const PATH = "/api/internal/health/snapshot";
const CURRENT = "a-synchub-health-read-secret-current-0123456789"; // > 32 bytes
const PREVIOUS = "a-synchub-health-read-secret-previous-012345678";
const SNAPSHOT = {
  schema: "trock.integration-health.snapshot.v1",
  system: "synchub",
  generated_at: "2026-11-14T03:00:00.000Z",
  producer_commit: null,
  connections: [],
};

/** Core's signer (core/src/modules/qb-sync/expense-reference-client.ts signExpenseQbRead), copied. */
function signLikeCore(secret: string, timestamp: number, p: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = ["v1", String(timestamp), "POST", p, bodyHash].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical, "utf8").digest("hex")}`;
}

function handlerFromRegistration() {
  const routes: Record<string, any[]> = {};
  const app: any = { post: vi.fn((p: string, ...handlers: any[]) => (routes[`POST ${p}`] = handlers)), get: vi.fn(), use: vi.fn() };
  registerHealthSnapshotRoutes(app);
  const handlers = routes[`POST ${PATH}`];
  expect(handlers, "route registered").toBeTruthy();
  expect(handlers).toHaveLength(1); // no session middleware in front of it
  return handlers[0];
}

async function call(req: { headers?: Record<string, unknown>; rawBody?: Buffer }, handler = handlerFromRegistration()) {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, sent: undefined as string | undefined };
  res.status = vi.fn((c: number) => ((res.statusCode = c), res));
  res.set = vi.fn((k: string, v: string) => ((res.headers[k.toLowerCase()] = v), res));
  res.type = vi.fn((t: string) => ((res.headers["content-type"] = t), res));
  res.json = vi.fn((b: unknown) => ((res.sent = JSON.stringify(b)), res));
  res.send = vi.fn((b: string) => ((res.sent = b), res));
  await handler({ path: PATH, method: "POST", body: {}, ...req, headers: req.headers ?? {} }, res, vi.fn());
  return { res, body: res.sent === undefined ? undefined : JSON.parse(res.sent) };
}

const nowS = () => Math.floor(Date.now() / 1000);
function signed(body = "{}", opts: { secret?: string; ts?: number; path?: string } = {}) {
  const ts = opts.ts ?? nowS();
  return {
    headers: {
      "content-type": "application/json",
      "x-trock-timestamp": String(ts),
      "x-trock-signature": signLikeCore(opts.secret ?? CURRENT, ts, opts.path ?? PATH, body),
    },
    rawBody: body === "" ? undefined : Buffer.from(body, "utf8"),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SYNCHUB_HEALTH_READ_SECRET_CURRENT", CURRENT);
  vi.stubEnv("SYNCHUB_HEALTH_READ_SECRET_PREVIOUS", PREVIOUS);
  h.collect.mockReset().mockResolvedValue(SNAPSHOT);
  h.release.mockReset();
  h.connect.mockReset().mockResolvedValue({ release: h.release });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("POST /api/internal/health/snapshot", () => {
  it("exports the literal path", () => {
    expect(HEALTH_SNAPSHOT_PATH).toBe(PATH);
  });

  it("a CURRENT signature -> 200 with the collected snapshot, no-store, never through res.json (the /api logger echoes it)", async () => {
    const { res, body } = await call(signed());
    expect(res.statusCode).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json).not.toHaveBeenCalled();
    expect(h.collect).toHaveBeenCalledTimes(1);
  });

  it("a PREVIOUS signature also passes (rotation), and an empty body signs sha256('')", async () => {
    expect((await call(signed("{}", { secret: PREVIOUS }))).res.statusCode).toBe(200);
    expect((await call(signed(""))).res.statusCode).toBe(200);
  });

  it.each([
    ["wrong secret", () => signed("{}", { secret: "another-secret-that-is-long-enough-0000000" })],
    ["a signature for another path", () => signed("{}", { path: "/api/internal/procore/access-token" })],
    ["stale timestamp (-301 s)", () => signed("{}", { ts: nowS() - 301 })],
    ["future timestamp (+301 s)", () => signed("{}", { ts: nowS() + 301 })],
    ["missing timestamp", () => { const s = signed(); delete (s.headers as any)["x-trock-timestamp"]; return s; }],
    ["missing signature", () => { const s = signed(); delete (s.headers as any)["x-trock-signature"]; return s; }],
    ["malformed signature", () => { const s = signed(); (s.headers as any)["x-trock-signature"] = "deadbeef"; return s; }],
    ["tampered body", () => ({ ...signed(), rawBody: Buffer.from('{"x":1}') })],
    ["non-numeric timestamp", () => { const s = signed(); (s.headers as any)["x-trock-timestamp"] = "12a"; return s; }],
  ])("%s -> 401 and nothing is collected", async (_name, make) => {
    const { res, body } = await call(make());
    expect(res.statusCode).toBe(401);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("timestamps within +-300 s are accepted", async () => {
    for (const ts of [nowS() - 299, nowS() + 299]) expect((await call(signed("{}", { ts }))).res.statusCode).toBe(200);
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["shorter than 32 bytes", "x".repeat(31)],
  ])("CURRENT %s -> 503 snapshot_unavailable, even with a usable PREVIOUS (fail closed)", async (_name, value) => {
    if (value === undefined) {
      vi.unstubAllEnvs();
      delete process.env.SYNCHUB_HEALTH_READ_SECRET_CURRENT;
      vi.stubEnv("SYNCHUB_HEALTH_READ_SECRET_PREVIOUS", PREVIOUS);
    } else vi.stubEnv("SYNCHUB_HEALTH_READ_SECRET_CURRENT", value);
    const { res, body } = await call(signed("{}", { secret: PREVIOUS }));
    expect(res.statusCode).toBe(503);
    expect(body).toEqual({ error: "snapshot_unavailable", reason: "not_configured" });
    expect(h.collect).not.toHaveBeenCalled();
  });

  it("a PREVIOUS shorter than 32 bytes is ignored, not a way in", async () => {
    vi.stubEnv("SYNCHUB_HEALTH_READ_SECRET_PREVIOUS", "short-previous");
    expect((await call(signed("{}", { secret: "short-previous" }))).res.statusCode).toBe(401);
  });

  it("a collection error -> 503 snapshot_unavailable with a fixed reason: never a partial snapshot, never the error text", async () => {
    h.collect.mockRejectedValueOnce(new Error("relation rfp_core_create_outbox: someone@example.test"));
    const { res, body } = await call(signed());
    expect(res.statusCode).toBe(503);
    expect(body).toEqual({ error: "snapshot_unavailable", reason: "collection_failed" });
    expect(res.sent).not.toContain("someone@example.test");
  });

  it("a collection slower than the deadline -> 503 deadline", async () => {
    const handler = createHealthSnapshotHandler({ collect: () => new Promise(() => undefined) as any, deadlineMs: 30 });
    const { res, body } = await call(signed(), handler);
    expect(res.statusCode).toBe(503);
    expect(body).toEqual({ error: "snapshot_unavailable", reason: "deadline" });
  });
});

describe("one collection at a time, and a deadline that frees its connection (PR #139 review)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("two concurrent requests share ONE collection on ONE leased connection", async () => {
    const pending = deferred<any>();
    const collect = vi.fn(() => pending.promise);
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ db: {}, release }));
    const handler = createHealthSnapshotHandler({ collect, acquire, deadlineMs: 5_000 } as any);
    const first = call(signed(), handler);
    const second = call(signed(), handler);
    await new Promise((r) => setTimeout(r, 10));
    pending.resolve(SNAPSHOT);
    const [a, b] = await Promise.all([first, second]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect([a.res.statusCode, b.res.statusCode]).toEqual([200, 200]);
    expect(b.body).toEqual(SNAPSHOT);
    expect(release.mock.calls).toEqual([[false]]);
  });

  it("past the deadline: 503, the connection is DESTROYED (its late rejection handled); the next request collects afresh", async () => {
    // A statement that never returns until its connection is destroyed (pg rejects it with "Connection terminated").
    const stuck = deferred<any>();
    const releases: boolean[] = [];
    const acquire = vi.fn(async () => ({
      db: {},
      release: (destroy: boolean) => {
        releases.push(destroy);
        if (destroy) stuck.reject(new Error("Connection terminated"));
      },
    }));
    let runs = 0;
    const collect = vi.fn(() => (++runs === 1 ? stuck.promise : Promise.resolve(SNAPSHOT)));
    const handler = createHealthSnapshotHandler({ collect, acquire, deadlineMs: 30 } as any);

    const first = await call(signed(), handler);
    expect(first.res.statusCode).toBe(503);
    expect(first.body).toEqual({ error: "snapshot_unavailable", reason: "deadline" });
    expect(releases).toEqual([true]);

    const second = await call(signed(), handler);
    expect(second.res.statusCode).toBe(200);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(releases).toEqual([true, false]);
  });
});
