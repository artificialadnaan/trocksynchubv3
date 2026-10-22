import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// H2 against real Postgres: what the storage layer WRITES for oauth_tokens and the *_oauth config rows is sealed when SECRETS_ENCRYPTION_KEY is
// set, callers still get plaintext, and legacy plaintext rows keep reading (dual read).
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() { return dbHolder.db; },
  get pool() { return dbHolder.pool; },
}));
const { storage } = await import("../server/storage.ts");

let pg: PGlite;
const KEY = randomBytes(32).toString("base64");
const prior = process.env.SECRETS_ENCRYPTION_KEY;

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE automation_config (id SERIAL PRIMARY KEY, key text NOT NULL UNIQUE, value jsonb NOT NULL, description text, is_active boolean NOT NULL DEFAULT true, updated_at timestamp DEFAULT now());
    CREATE TABLE oauth_tokens (id SERIAL PRIMARY KEY, provider text NOT NULL UNIQUE, access_token text NOT NULL, refresh_token text, token_type text DEFAULT 'Bearer', expires_at timestamp, scopes text, metadata jsonb, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
  `);
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
  delete process.env.SECRETS_ENCRYPTION_KEY;
});
afterEach(() => { if (prior === undefined) delete process.env.SECRETS_ENCRYPTION_KEY; else process.env.SECRETS_ENCRYPTION_KEY = prior; });

const rawToken = async (p: string) => (await pg.query<any>(`SELECT access_token, refresh_token FROM oauth_tokens WHERE provider = $1`, [p])).rows[0];
const rawConfig = async (k: string) => (await pg.query<any>(`SELECT value FROM automation_config WHERE key = $1`, [k])).rows[0]?.value;

describe("oauth_tokens at rest", () => {
  it("with the key set the row holds ciphertext, the caller gets plaintext, and an update re-seals", async () => {
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    const out = await storage.upsertOAuthToken({ provider: "procore", accessToken: "ACCESS-1", refreshToken: "REFRESH-1", tokenType: "Bearer" } as any);
    expect(out).toMatchObject({ accessToken: "ACCESS-1", refreshToken: "REFRESH-1" });
    const raw = await rawToken("procore");
    expect(raw.access_token.startsWith("enc:v1:k1:")).toBe(true);
    expect(raw.refresh_token.startsWith("enc:v1:k1:")).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("ACCESS-1");
    expect(await storage.getOAuthToken("procore")).toMatchObject({ accessToken: "ACCESS-1", refreshToken: "REFRESH-1" });
    await storage.upsertOAuthToken({ provider: "procore", accessToken: "ACCESS-2", refreshToken: "REFRESH-2", tokenType: "Bearer" } as any);
    expect((await storage.getOAuthToken("procore"))?.accessToken).toBe("ACCESS-2");
    expect((await rawToken("procore")).access_token).not.toContain("ACCESS-2");
  });
  it("DUAL READ: a legacy plaintext row reads as is, with or without the key; with no key set new writes stay plaintext (dormant)", async () => {
    await pg.query(`INSERT INTO oauth_tokens (provider, access_token, refresh_token) VALUES ('hubspot', 'LEGACY-A', 'LEGACY-R')`);
    expect(await storage.getOAuthToken("hubspot")).toMatchObject({ accessToken: "LEGACY-A", refreshToken: "LEGACY-R" });
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    expect(await storage.getOAuthToken("hubspot")).toMatchObject({ accessToken: "LEGACY-A", refreshToken: "LEGACY-R" });
    delete process.env.SECRETS_ENCRYPTION_KEY;
    await storage.upsertOAuthToken({ provider: "companycam", accessToken: "PLAIN", refreshToken: null, tokenType: "Bearer" } as any);
    expect((await rawToken("companycam")).access_token).toBe("PLAIN");
  });
});

describe("*_oauth automation_config rows at rest", () => {
  it("microsoft_oauth / gmail_oauth hold sealed token fields; reads return plaintext; non-OAuth rows are untouched", async () => {
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    await storage.upsertAutomationConfig({ key: "microsoft_oauth", value: { accessToken: "MS-A", refreshToken: "MS-R", expiresAt: 99, userEmail: "u@x" }, isActive: true } as any);
    await storage.upsertAutomationConfig({ key: "procore_polling", value: { enabled: true, accessToken: "not-a-token-row" }, isActive: true } as any);
    const raw = await rawConfig("microsoft_oauth");
    expect(raw.accessToken.startsWith("enc:v1:k1:")).toBe(true);
    expect(raw).toMatchObject({ expiresAt: 99, userEmail: "u@x" });
    expect(JSON.stringify(raw)).not.toContain("MS-A");
    expect((await storage.getAutomationConfig("microsoft_oauth"))?.value).toEqual({ accessToken: "MS-A", refreshToken: "MS-R", expiresAt: 99, userEmail: "u@x" });
    expect(await rawConfig("procore_polling")).toEqual({ enabled: true, accessToken: "not-a-token-row" }); // not an *_oauth key
    const all = await storage.getAutomationConfigs();
    expect(all.find((c) => c.key === "microsoft_oauth")?.value).toMatchObject({ accessToken: "MS-A" });
  });
  it("DUAL READ: a legacy plaintext microsoft_oauth row reads as is, and the conditional upsert also seals", async () => {
    await pg.query(`INSERT INTO automation_config (key, value) VALUES ('gmail_oauth', '{"accessToken":"G-A","refreshToken":"G-R","expiresAt":1}'::jsonb)`);
    expect((await storage.getAutomationConfig("gmail_oauth"))?.value).toMatchObject({ accessToken: "G-A", refreshToken: "G-R" });
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    await storage.upsertAutomationConfigUnlessAuthDisabled({ key: "gmail_oauth", value: { accessToken: "G-A2", refreshToken: "G-R2", expiresAt: 2 }, isActive: true } as any);
    expect((await rawConfig("gmail_oauth")).accessToken.startsWith("enc:v1:k1:")).toBe(true);
    expect((await storage.getAutomationConfig("gmail_oauth"))?.value).toMatchObject({ accessToken: "G-A2" });
  });
});

describe("scripts/reseal-oauth-secrets.ts argument guards", () => {
  it("refuses --apply without the owner's named go or without a key (it never reaches the database)", async () => {
    const { run } = await import("../scripts/reseal-oauth-secrets.ts");
    await expect(run(["--apply"], { DATABASE_URL: "postgres://nowhere.invalid/x" } as any, () => undefined)).rejects.toThrow(/RESEAL_OWNER_GO/);
    await expect(run(["--apply"], { DATABASE_URL: "postgres://nowhere.invalid/x", RESEAL_OWNER_GO: "owner" } as any, () => undefined)).rejects.toThrow(/SECRETS_ENCRYPTION_KEY is not set/);
    await expect(run([], {} as any, () => undefined)).rejects.toThrow(/DATABASE_URL/);
  });
  it("plaintextConfigFields finds only unsealed, non-empty token fields", async () => {
    const { plaintextConfigFields } = await import("../scripts/reseal-oauth-secrets.ts");
    expect(plaintextConfigFields({ accessToken: "a", refreshToken: "enc:v1:k1:x:y:z" })).toEqual(["accessToken"]);
    expect(plaintextConfigFields({})).toEqual([]);
    expect(plaintextConfigFields(null)).toEqual([]);
  });
});

describe("scripts/reseal-oauth-secrets.ts on real Postgres", () => {
  const K1 = randomBytes(32).toString("base64");
  const K2 = randomBytes(32).toString("base64");
  const envK1 = { SECRETS_ENCRYPTION_KEY: K1, SECRETS_ENCRYPTION_KEY_ID: "k1", RESEAL_OWNER_GO: "owner" } as NodeJS.ProcessEnv;
  const envK2 = { SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: "k2", SECRETS_PREVIOUS_KEYS: `k1:${K1}`, RESEAL_OWNER_GO: "owner" } as NodeJS.ProcessEnv;

  it("dry run reports plaintext AND retired-key rows and writes nothing; apply re-seals both under the CURRENT key id, locks first, and every value still opens", async () => {
    const { resealWith } = await import("../scripts/reseal-oauth-secrets.ts");
    const { sealSecret, openSecret } = await import("../server/lib/secret-seal.ts");
    await pg.query(`INSERT INTO oauth_tokens (provider, access_token, refresh_token) VALUES ('hubspot', 'PLAIN-A', 'PLAIN-R')`);
    await pg.query(`INSERT INTO oauth_tokens (provider, access_token, refresh_token) VALUES ('companycam', $1, NULL)`, [sealSecret("CC-TOKEN", envK1)]);
    await pg.query(`INSERT INTO oauth_tokens (provider, access_token, refresh_token) VALUES ('procore', $1, $2)`, [sealSecret("PC-A", envK2), sealSecret("PC-R", envK2)]); // already current
    await pg.query(`INSERT INTO automation_config (key, value) VALUES ('gmail_oauth', $1::jsonb)`, [JSON.stringify({ accessToken: sealSecret("G-A", envK1), refreshToken: "G-PLAIN-R", expiresAt: 1 })]);
    const before = JSON.stringify((await pg.query<any>(`SELECT * FROM oauth_tokens ORDER BY provider`)).rows);

    const lines: string[] = [];
    await resealWith(pg as any, false, envK2, (l) => lines.push(l));
    expect(lines[0]).toContain("2 to re-seal (providers: companycam, hubspot)");
    expect(lines[1]).toContain("1 to re-seal (keys: gmail_oauth)");
    expect(JSON.stringify((await pg.query<any>(`SELECT * FROM oauth_tokens ORDER BY provider`)).rows)).toBe(before);

    const sqls: string[] = [];
    const spy = { query: (sql: string, params?: unknown[]) => { sqls.push(sql.replace(/\s+/g, " ").slice(0, 140)); return (pg as any).query(sql, params); } };
    await resealWith(spy, true, envK2, () => undefined);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toContain("pg_advisory_xact_lock(hashtext('procore-oauth-refresh'))");
    expect(sqls.slice(2, 4).every((q) => q.includes("FOR UPDATE"))).toBe(true); // re-read under the lock
    const rows = (await pg.query<any>(`SELECT provider, access_token, refresh_token FROM oauth_tokens ORDER BY provider`)).rows;
    for (const r of rows) expect(r.access_token.startsWith("enc:v1:k2:")).toBe(true);
    expect(rows.map((r: any) => openSecret(r.access_token, envK2))).toEqual(["CC-TOKEN", "PLAIN-A", "PC-A"]);
    const cfg = (await pg.query<any>(`SELECT value FROM automation_config WHERE key = 'gmail_oauth'`)).rows[0].value;
    expect(cfg.accessToken.startsWith("enc:v1:k2:")).toBe(true);
    expect(cfg.refreshToken.startsWith("enc:v1:k2:")).toBe(true);
    expect(openSecret(cfg.accessToken, envK2)).toBe("G-A");
    expect(openSecret(cfg.refreshToken, envK2)).toBe("G-PLAIN-R");
    expect(cfg.expiresAt).toBe(1);
    // and a second run finds nothing left to do
    const again: string[] = [];
    await resealWith(pg as any, false, envK2, (l) => again.push(l));
    expect(again[0]).toContain("0 to re-seal");
  });
});
