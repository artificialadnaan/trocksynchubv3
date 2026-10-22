import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H1 follow-up (Codex on #119): a Settings save that would leave NO usable client secret is refused instead of acknowledged, using the same rules the
// OAuth paths apply (env first, then the legacy stored copy unless CLIENT_SECRETS_ENV_ONLY=true).
const configs = vi.hoisted(() => new Map<string, any>());
const saved = vi.hoisted(() => [] as any[]);
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => configs.get(key) ?? null),
    upsertAutomationConfig: vi.fn(async (row: any) => { saved.push(row); configs.set(row.key, { value: row.value }); }),
    getUser: vi.fn(async () => ({ id: "u", role: "admin" })),
  },
}));
vi.mock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn() } }));
vi.mock("../server/routes/settings.ts", () => ({ requireAdmin: (_q: any, _s: any, n: any) => n() }));
vi.mock("../server/procore.ts", () => ({ storeProcoreTokenPairUnderLock: vi.fn() }));

const { hasUsableClientSecret, resetClientSecretWarnings } = await import("../server/lib/client-secret.ts");

const NAMES = ["MICROSOFT_CLIENT_SECRET", "PROCORE_CLIENT_SECRET", "CLIENT_SECRETS_ENV_ONLY"] as const;
const prior: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) { prior[n] = process.env[n]; delete process.env[n]; }
  configs.clear(); saved.length = 0; resetClientSecretWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { for (const n of NAMES) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; } vi.restoreAllMocks(); });

describe("hasUsableClientSecret follows the OAuth paths' rules", () => {
  it("env present → usable; legacy copy only → usable; neither → not; legacy copy under CLIENT_SECRETS_ENV_ONLY → NOT usable", () => {
    expect(hasUsableClientSecret("PROCORE_CLIENT_SECRET", undefined)).toBe(false);
    expect(hasUsableClientSecret("PROCORE_CLIENT_SECRET", "legacy")).toBe(true);
    process.env.CLIENT_SECRETS_ENV_ONLY = "true";
    expect(hasUsableClientSecret("PROCORE_CLIENT_SECRET", "legacy")).toBe(false); // the OAuth path would ignore it too
    process.env.PROCORE_CLIENT_SECRET = "from-env";
    expect(hasUsableClientSecret("PROCORE_CLIENT_SECRET", undefined)).toBe(true);
  });
});

describe("POST /api/integrations/microsoft/config", () => {
  async function post(body: any): Promise<number> {
    const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");
    const app = express();
    app.use(express.json());
    registerOAuthRoutes(app, (_q: any, _s: any, n: any) => n());
    const server = app.listen(0);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server");
    try {
      return (await fetch(`http://127.0.0.1:${addr.port}/api/integrations/microsoft/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
  it("refuses a save that leaves no usable secret (a typed secret is not stored), and accepts one once the env var is set", async () => {
    expect(await post({ clientId: "id", clientSecret: "typed", tenantId: "t" })).toBe(400);
    expect(saved).toHaveLength(0);
    process.env.MICROSOFT_CLIENT_SECRET = "from-env";
    expect(await post({ clientId: "id", tenantId: "t" })).toBe(200);
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain("typed");
  });
  it("still needs a client id", async () => {
    process.env.MICROSOFT_CLIENT_SECRET = "from-env";
    expect(await post({ tenantId: "t" })).toBe(400);
  });
});
