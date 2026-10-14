import { createHash, createHmac } from "node:crypto";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/internal/procore/access-token: Core's signed, read-only fetch of SyncHub's Procore ACCESS token.
// SyncHub stays the only caller of Procore's /oauth/token; the refresh token never leaves SyncHub.
// Auth is Core's HMAC scheme (byte for byte its client, core/src/modules/qb-sync/expense-reference-client.ts):
//   canonical = "v1\n<ts>\nPOST\n<path>\n<sha256hex(rawBody)>"   x-trock-signature: sha256=<hex HMAC-SHA256>
// with its own secret CORE_PROCORE_TOKEN_READ_SECRET (>= 32 bytes, fail closed). Everything is mocked.

const h = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getCompanyId: vi.fn(),
  getOAuthToken: vi.fn(),
}));

vi.mock("../server/procore.ts", () => ({ getAccessToken: h.getAccessToken, getCompanyId: h.getCompanyId }));
vi.mock("../server/storage.ts", () => ({ storage: { getOAuthToken: h.getOAuthToken } }));

const { registerProcoreTokenReadRoutes, PROCORE_TOKEN_READ_PATH } = await import("../server/routes/procore-token-read.ts");

const PATH = "/api/internal/procore/access-token";
const SECRET = "a-core-procore-token-read-secret-0123456789"; // > 32 bytes
const REFRESH_SECRET = "RT-NEVER-LEAVES-SYNCHUB";
const CLIENT_SECRET = "PROCORE-CLIENT-SECRET";

/** Core's signer, copied verbatim from expense-reference-client.ts signExpenseQbRead. */
function signLikeCore(secret: string, timestamp: number, p: string, body: string): string {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = ["v1", String(timestamp), "POST", p, bodyHash].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical, "utf8").digest("hex")}`;
}

function routeHandlers() {
  const routes: Record<string, any[]> = {};
  const app: any = {
    post: vi.fn((p: string, ...handlers: any[]) => (routes[`POST ${p}`] = handlers)),
    get: vi.fn(),
    use: vi.fn(),
  };
  registerProcoreTokenReadRoutes(app);
  const handlers = routes[`POST ${PATH}`];
  expect(handlers, "route registered").toBeTruthy();
  return handlers;
}

async function call(req: { headers?: Record<string, unknown>; rawBody?: Buffer; body?: unknown }) {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, sent: undefined as string | undefined };
  res.status = vi.fn((c: number) => ((res.statusCode = c), res));
  res.set = vi.fn((k: string, v: string) => ((res.headers[k.toLowerCase()] = v), res));
  res.setHeader = vi.fn((k: string, v: string) => ((res.headers[k.toLowerCase()] = v), res));
  res.type = vi.fn((t: string) => ((res.headers["content-type"] = t), res));
  res.json = vi.fn((b: unknown) => ((res.sent = JSON.stringify(b)), res));
  res.send = vi.fn((b: string) => ((res.sent = b), res));
  const handlers = routeHandlers();
  const pending: Promise<unknown>[] = [];
  let i = 0;
  const next: any = (err?: unknown) => {
    if (err) throw err;
    const fn = handlers[i++];
    if (fn) pending.push(Promise.resolve(fn({ path: PATH, method: "POST", body: {}, ...req, headers: req.headers ?? {} }, res, next)));
  };
  next();
  for (let k = 0; k < pending.length; k++) await pending[k];
  return { res, body: res.sent === undefined ? undefined : JSON.parse(res.sent) };
}

const nowS = () => Math.floor(Date.now() / 1000);
function signed(body = "", opts: { secret?: string; ts?: number; path?: string } = {}) {
  const ts = opts.ts ?? nowS();
  return {
    headers: {
      "content-type": "application/json",
      "x-trock-timestamp": String(ts),
      "x-trock-signature": signLikeCore(opts.secret ?? SECRET, ts, opts.path ?? PATH, body),
    },
    rawBody: body === "" ? undefined : Buffer.from(body, "utf8"),
  };
}

const EXPIRES = new Date(Date.now() + 90 * 60_000);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CORE_PROCORE_TOKEN_READ_SECRET", SECRET);
  h.getAccessToken.mockReset().mockResolvedValue("AT-VALID");
  h.getCompanyId.mockReset().mockResolvedValue("4280");
  h.getOAuthToken.mockReset().mockResolvedValue({
    provider: "procore",
    accessToken: "AT-VALID",
    refreshToken: REFRESH_SECRET,
    expiresAt: EXPIRES,
    metadata: { clientSecret: CLIENT_SECRET },
  });
});

describe("POST /api/internal/procore/access-token", () => {
  it("exports the literal path", () => {
    expect(PROCORE_TOKEN_READ_PATH).toBe(PATH);
  });

  it("a valid Core signature -> 200 with EXACTLY { accessToken, expiresAt, companyId }, no-store", async () => {
    const { res, body } = await call(signed("{}"));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["accessToken", "companyId", "expiresAt"]);
    expect(body).toEqual({ accessToken: "AT-VALID", expiresAt: EXPIRES.toISOString(), companyId: "4280" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(h.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("an empty body signs sha256('') and is accepted", async () => {
    const { res, body } = await call(signed(""));
    expect(res.statusCode).toBe(200);
    expect(body.accessToken).toBe("AT-VALID");
  });

  it("the response never contains the refresh token or the client secret, and is not handed to res.json (the /api request logger echoes res.json bodies)", async () => {
    const { res } = await call(signed("{}"));
    expect(res.sent).not.toContain(REFRESH_SECRET);
    expect(res.sent).not.toMatch(/refresh/i);
    expect(res.sent).not.toContain(CLIENT_SECRET);
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong secret", () => signed("{}", { secret: "another-secret-that-is-long-enough-000000" })],
    ["signature for another path", () => signed("{}", { path: "/api/internal/procore/other" })],
    ["stale timestamp (-301 s)", () => signed("{}", { ts: nowS() - 301 })],
    ["future timestamp (+301 s)", () => signed("{}", { ts: nowS() + 301 })],
    ["missing timestamp", () => { const s = signed("{}"); delete (s.headers as any)["x-trock-timestamp"]; return s; }],
    ["missing signature", () => { const s = signed("{}"); delete (s.headers as any)["x-trock-signature"]; return s; }],
    ["malformed signature", () => { const s = signed("{}"); (s.headers as any)["x-trock-signature"] = "deadbeef"; return s; }],
    ["tampered body", () => ({ ...signed("{}"), rawBody: Buffer.from('{"x":1}') })],
    ["non-numeric timestamp", () => { const s = signed("{}"); (s.headers as any)["x-trock-timestamp"] = "12a"; return s; }],
  ])("%s -> 401 and the token is never read", async (_name, make) => {
    const { res, body } = await call(make());
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(body)).not.toContain("AT-VALID");
    expect(h.getAccessToken).not.toHaveBeenCalled();
    expect(h.getOAuthToken).not.toHaveBeenCalled();
  });

  it("timestamps within +-300 s are accepted", async () => {
    for (const ts of [nowS() - 299, nowS() + 299]) {
      const { res } = await call(signed("{}", { ts }));
      expect(res.statusCode).toBe(200);
    }
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
    ["shorter than 32 bytes", "x".repeat(31)],
  ])("secret %s -> 503 core_token_read_not_configured (fail closed)", async (_name, value) => {
    if (value === undefined) {
      vi.unstubAllEnvs();
      delete process.env.CORE_PROCORE_TOKEN_READ_SECRET;
    } else vi.stubEnv("CORE_PROCORE_TOKEN_READ_SECRET", value);
    const { res, body } = await call(signed("{}", { secret: value ?? SECRET }));
    expect(res.statusCode).toBe(503);
    expect(body).toEqual({ error: "core_token_read_not_configured" });
    expect(h.getAccessToken).not.toHaveBeenCalled();
  });

  it("a token that cannot be had (no token / refresh failed) -> 503 procore_token_unavailable, token not logged", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))),
    );
    h.getAccessToken.mockRejectedValueOnce(new Error("Failed to refresh Procore token: 400 invalid_grant"));
    const { res, body } = await call(signed("{}"));
    spies.forEach((s) => s.mockRestore());
    expect(res.statusCode).toBe(503);
    expect(body.error).toBe("procore_token_unavailable");
    expect(typeof body.reason).toBe("string");
    expect(body.reason.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(["error", "reason"]);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(logs.join("\n")).not.toContain(REFRESH_SECRET);
    expect(logs.join("\n")).not.toContain("AT-VALID");
  });

  it("an expired stored token -> 503, never an expired token", async () => {
    h.getOAuthToken.mockResolvedValue({ accessToken: "AT-VALID", refreshToken: REFRESH_SECRET, expiresAt: new Date(Date.now() - 1000) });
    const { res, body } = await call(signed("{}"));
    expect(res.statusCode).toBe(503);
    expect(body.error).toBe("procore_token_unavailable");
    expect(res.sent).not.toContain("AT-VALID");
  });

  it("a stored token with <= 60 s left is never served: one more getAccessToken(), then 503 if still near expiry", async () => {
    for (const msLeft of [10_000, 59_000]) {
      h.getAccessToken.mockClear();
      h.getOAuthToken.mockResolvedValue({ accessToken: "AT-NEAR", refreshToken: REFRESH_SECRET, expiresAt: new Date(Date.now() + msLeft) });
      const { res, body } = await call(signed("{}"));
      expect(res.statusCode).toBe(503);
      expect(body.error).toBe("procore_token_unavailable");
      expect(res.sent).not.toContain("AT-NEAR");
      expect(h.getAccessToken).toHaveBeenCalledTimes(2);
    }
  });

  it("a near-expiry row is served only after the second getAccessToken() refreshed it", async () => {
    const fresh = new Date(Date.now() + 2 * 3600_000);
    h.getOAuthToken
      .mockResolvedValueOnce({ accessToken: "AT-NEAR", refreshToken: REFRESH_SECRET, expiresAt: new Date(Date.now() + 10_000) })
      .mockResolvedValueOnce({ accessToken: "AT-REFRESHED", refreshToken: "RT-2", expiresAt: fresh });
    const { res, body } = await call(signed("{}"));
    expect(res.statusCode).toBe(200);
    expect(body).toEqual({ accessToken: "AT-REFRESHED", expiresAt: fresh.toISOString(), companyId: "4280" });
    expect(res.sent).not.toContain("AT-NEAR");
    expect(h.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it("no stored row -> 503 procore_token_unavailable", async () => {
    h.getAccessToken.mockRejectedValueOnce(new Error("No Procore OAuth token found. Please authenticate via OAuth first."));
    h.getOAuthToken.mockResolvedValue(undefined);
    const { res, body } = await call(signed("{}"));
    expect(res.statusCode).toBe(503);
    expect(body.error).toBe("procore_token_unavailable");
  });

  it("is registered by registerRoutes (server/routes/index.ts)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../server/routes/index.ts"), "utf8");
    expect(src).toMatch(/import\s*\{\s*registerProcoreTokenReadRoutes\s*\}\s*from\s*["']\.\/procore-token-read["']/);
    expect(src).toMatch(/registerProcoreTokenReadRoutes\(app\)/);
  });
});
