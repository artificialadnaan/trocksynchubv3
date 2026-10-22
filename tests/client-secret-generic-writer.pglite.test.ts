import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// H1 (Codex P1 on #119): PUT /api/automation-config reaches storage.upsertAutomationConfig with an arbitrary body. The storage layer itself must keep a
// client secret out of procore_config / microsoft_config / storage_provider_config.googleDrive. Real SQL on PGlite.
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() { return dbHolder.db; },
  get pool() { return dbHolder.pool; },
}));
const { storage } = await import("../server/storage.ts");

const NAMES = ["PROCORE_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET", "GOOGLE_DRIVE_CLIENT_SECRET", "CLIENT_SECRETS_ENV_ONLY"] as const;
const prior: Record<string, string | undefined> = {};
let pg: PGlite;
beforeEach(async () => {
  for (const n of NAMES) { prior[n] = process.env[n]; delete process.env[n]; }
  pg = new PGlite();
  await pg.exec(`CREATE TABLE automation_config (id SERIAL PRIMARY KEY, key text NOT NULL UNIQUE, value jsonb NOT NULL, description text, is_active boolean NOT NULL DEFAULT true, updated_at timestamp DEFAULT now());`);
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
});
afterEach(() => { for (const n of NAMES) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; } });

const seed = (key: string, value: unknown) => pg.query(`INSERT INTO automation_config (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
const read = async (key: string) => ((await pg.query<{ value: any }>(`SELECT value FROM automation_config WHERE key = $1`, [key])).rows[0]?.value);

describe("generic automation-config writer never persists a typed client secret", () => {
  it("procore_config / microsoft_config: a submitted clientSecret is dropped", async () => {
    await storage.upsertAutomationConfig({ key: "procore_config", value: { clientId: "c", clientSecret: "typed" } } as any);
    expect(await read("procore_config")).toEqual({ clientId: "c" });
    await storage.upsertAutomationConfig({ key: "microsoft_config", value: { clientId: "m", clientSecret: "typed", tenantId: "t" } } as any);
    expect(await read("microsoft_config")).toEqual({ clientId: "m", tenantId: "t" });
  });
  it("an already-stored legacy copy survives only while the env var is unset, and a typed value never replaces it", async () => {
    await seed("procore_config", { clientId: "c", clientSecret: "legacy" });
    await storage.upsertAutomationConfig({ key: "procore_config", value: { clientId: "c2", clientSecret: "typed" } } as any);
    expect(await read("procore_config")).toEqual({ clientId: "c2", clientSecret: "legacy" });
    process.env.PROCORE_CLIENT_SECRET = "from-env";
    await storage.upsertAutomationConfig({ key: "procore_config", value: { clientId: "c3", clientSecret: "legacy" } } as any);
    expect(await read("procore_config")).toEqual({ clientId: "c3" });
  });
  it("storage_provider_config.googleDrive.clientSecret is dropped, other fields kept; the auth-disabled variant is guarded too", async () => {
    await storage.upsertAutomationConfig({ key: "storage_provider_config", value: { activeProvider: "google-drive", googleDrive: { clientId: "x", clientSecret: "typed", refreshToken: "r" } } } as any);
    expect(await read("storage_provider_config")).toEqual({ activeProvider: "google-drive", googleDrive: { clientId: "x", refreshToken: "r" } });
    await storage.upsertAutomationConfigUnlessAuthDisabled({ key: "microsoft_config", value: { clientSecret: "typed" } } as any);
    expect(await read("microsoft_config")).toEqual({});
  });
  it("patchAutomationConfig strips a secret from a protected row's patch; other rows are untouched", async () => {
    await storage.patchAutomationConfig("procore_config", { clientId: "c", clientSecret: "typed" });
    expect(await read("procore_config")).toEqual({ clientId: "c" });
    await storage.upsertAutomationConfig({ key: "other_row", value: { clientSecret: "kept-here" } } as any);
    expect(await read("other_row")).toEqual({ clientSecret: "kept-here" });
  });
});

describe("patchAutomationConfig insertDefaults on a protected row", () => {
  it("a client secret in insertDefaults is not written when the patch creates the row", async () => {
    await storage.patchAutomationConfig("procore_config", { clientId: "c" }, undefined, { clientSecret: "typed", environment: "production" });
    expect(await read("procore_config")).toEqual({ clientId: "c", environment: "production" });
  });
});
