import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H1 (security rotation, 2026-10-22): provider client secrets come from the ENVIRONMENT; the plaintext automation_config copy is never preferred and
// never written again. Storage is mocked; no real secret appears here (placeholder strings only).
const configs = vi.hoisted(() => new Map<string, any>());
const upserts = vi.hoisted(() => [] as any[]);
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => configs.get(key) ?? null),
    upsertAutomationConfig: vi.fn(async (row: any) => { upserts.push(row); configs.set(row.key, { value: row.value }); }),
  },
}));
vi.mock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn() } }));

const { resolveClientSecret, stripClientSecret, legacySecretToKeep, resetClientSecretWarnings } = await import("../server/lib/client-secret.ts");
const { getConfigFromDb, saveMicrosoftConfig } = await import("../server/microsoft.ts");
const { getProcoreConfig } = await import("../server/procore.ts");

const NAMES = ["MICROSOFT_CLIENT_SECRET", "PROCORE_CLIENT_SECRET", "GOOGLE_DRIVE_CLIENT_SECRET", "CLIENT_SECRETS_ENV_ONLY"] as const;
const prior: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const n of NAMES) { prior[n] = process.env[n]; delete process.env[n]; }
  configs.clear(); upserts.length = 0; resetClientSecretWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const n of NAMES) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; }
  vi.restoreAllMocks();
});

describe("resolveClientSecret", () => {
  it("the env var wins over a stored DB copy (the DB-first override is gone)", () => {
    process.env.MICROSOFT_CLIENT_SECRET = "env-value";
    expect(resolveClientSecret({ label: "Microsoft", envName: "MICROSOFT_CLIENT_SECRET", dbValue: "db-value" })).toBe("env-value");
  });
  it("with no env var the legacy DB copy is a warned fallback, and CLIENT_SECRETS_ENV_ONLY=true removes it", () => {
    expect(resolveClientSecret({ label: "Microsoft", envName: "MICROSOFT_CLIENT_SECRET", dbValue: "db-value" })).toBe("db-value");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("MICROSOFT_CLIENT_SECRET is not set"));
    process.env.CLIENT_SECRETS_ENV_ONLY = "true";
    expect(resolveClientSecret({ label: "Microsoft", envName: "MICROSOFT_CLIENT_SECRET", dbValue: "db-value" })).toBe("");
  });
  it("never logs a secret value", () => {
    process.env.PROCORE_CLIENT_SECRET = "env-secret-xyz";
    resolveClientSecret({ label: "Procore", envName: "PROCORE_CLIENT_SECRET", dbValue: "db-secret-abc" });
    resolveClientSecret({ label: "Procore", envName: "GOOGLE_DRIVE_CLIENT_SECRET", dbValue: "db-secret-abc" });
    const logged = JSON.stringify([...(console.warn as any).mock.calls, ...(console.error as any).mock.calls]);
    expect(logged).not.toContain("db-secret-abc");
    expect(logged).not.toContain("env-secret-xyz");
  });
  it("stripClientSecret drops only the secret; legacySecretToKeep keeps a stored copy only while the env var is unset", () => {
    expect(stripClientSecret({ clientId: "c", clientSecret: "s", tenantId: "t" })).toEqual({ clientId: "c", tenantId: "t" });
    expect(legacySecretToKeep("PROCORE_CLIENT_SECRET", "stored")).toBe("stored");
    process.env.PROCORE_CLIENT_SECRET = "env";
    expect(legacySecretToKeep("PROCORE_CLIENT_SECRET", "stored")).toBeUndefined();
  });
});

describe("Microsoft and Procore read the env secret first", () => {
  it("Microsoft: env beats the DB row; DB is the fallback", async () => {
    configs.set("microsoft_config", { value: { clientId: "id", clientSecret: "db-ms", tenantId: "t" } });
    expect((await getConfigFromDb()).clientSecret).toBe("db-ms");
    process.env.MICROSOFT_CLIENT_SECRET = "env-ms";
    expect((await getConfigFromDb()).clientSecret).toBe("env-ms");
  });
  it("Procore: env beats the DB row; DB is the fallback", async () => {
    configs.set("procore_config", { value: { clientId: "id", clientSecret: "db-pc", companyId: "1" } });
    expect((await getProcoreConfig()).clientSecret).toBe("db-pc");
    process.env.PROCORE_CLIENT_SECRET = "env-pc";
    expect((await getProcoreConfig()).clientSecret).toBe("env-pc");
  });
});

describe("secrets are no longer written to automation_config", () => {
  it("saveMicrosoftConfig stores no submitted secret once the env var is set, and keeps only a pre-existing legacy copy before it is", async () => {
    process.env.MICROSOFT_CLIENT_SECRET = "env-ms";
    await saveMicrosoftConfig({ clientId: "id", clientSecret: "typed-secret", tenantId: "t" });
    expect(upserts.at(-1).value).toEqual({ clientId: "id", tenantId: "t" });
    delete process.env.MICROSOFT_CLIENT_SECRET;
    configs.set("microsoft_config", { value: { clientId: "id", clientSecret: "db-ms", tenantId: "t" } });
    await saveMicrosoftConfig({ clientId: "id2", clientSecret: "typed-secret", tenantId: "t" });
    expect(upserts.at(-1).value).toEqual({ clientId: "id2", tenantId: "t", clientSecret: "db-ms" }); // the old copy, never the typed one
    expect(JSON.stringify(upserts)).not.toContain("typed-secret");
  });
});
