#!/usr/bin/env -S npx tsx
/**
 * [DESTRUCTIVE — owner go] Re-seal the OAuth tokens that are still PLAINTEXT, or sealed under a RETIRED key id, in oauth_tokens and the *_oauth
 * automation_config rows (security hardening H2). Ships OFF: the default is a DRY RUN that prints COUNTS ONLY (never a token); --apply additionally
 * requires the owner's named go in RESEAL_OWNER_GO and SECRETS_ENCRYPTION_KEY (plus SECRETS_PREVIOUS_KEYS for any retired id still in use).
 *
 * --apply is ONE transaction that first takes the same advisory lock the Procore refresh takes (so a refresh or reconnect cannot persist a new
 * single-use pair between this script's read and its write), then re-reads the rows FOR UPDATE and rewrites them. It is rolled back unless every
 * rewritten value opens back to exactly what was there. Run it through DATABASE_PUBLIC_URL when it is run from outside Railway.
 *
 *   DATABASE_URL=... npx tsx scripts/reseal-oauth-secrets.ts                       # dry run
 *   SECRETS_ENCRYPTION_KEY=... RESEAL_OWNER_GO="<who approved>" DATABASE_URL=... npx tsx scripts/reseal-oauth-secrets.ts --apply
 */
import pg from "pg";
import { isOAuthConfigKey, loadKeyRing, mapOAuthConfigValue, needsReseal, openSecret, sealSecret } from "../server/lib/secret-seal";

const TOKEN_FIELDS = ["accessToken", "refreshToken"] as const;
/** The advisory lock server/procore.ts takes around every refresh and reconnect (withProcoreOAuthLock). */
const PROCORE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('procore-oauth-refresh'))";

export function configFieldsToReseal(value: unknown, currentKeyId: string | null): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return TOKEN_FIELDS.filter((f) => needsReseal((value as any)[f], currentKeyId));
}
/** Kept for the plaintext-only callers/tests. */
export const plaintextConfigFields = (value: unknown): string[] => configFieldsToReseal(value, null);

type TokenRow = { provider: string; access_token: string; refresh_token: string | null };
type ConfigRow = { key: string; value: unknown };

async function collect(client: pg.PoolClient, currentKeyId: string | null, lock: boolean) {
  const suffix = lock ? " FOR UPDATE" : "";
  const tokens = await client.query<TokenRow>(`SELECT provider, access_token, refresh_token FROM oauth_tokens ORDER BY provider${suffix}`);
  const configs = await client.query<ConfigRow>(`SELECT key, value FROM automation_config WHERE key LIKE '%\\_oauth' ORDER BY key${suffix}`);
  return {
    tokens: tokens.rows,
    configs: configs.rows,
    tokenTargets: tokens.rows.filter((r) => needsReseal(r.access_token, currentKeyId) || needsReseal(r.refresh_token, currentKeyId)),
    configTargets: configs.rows.filter((r) => isOAuthConfigKey(r.key) && configFieldsToReseal(r.value, currentKeyId).length > 0),
  };
}

/** The reseal itself, on any pg-style client (a test drives it on PGlite). */
export async function resealWith(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, apply: boolean, env: NodeJS.ProcessEnv, out: (s: string) => void): Promise<void> {
  const currentKeyId = loadKeyRing(env)?.currentId ?? null;
  if (!apply) {
    const c = await collect(client as any, currentKeyId, false);
    out(`oauth_tokens: ${c.tokens.length} rows, ${c.tokenTargets.length} to re-seal (providers: ${c.tokenTargets.map((r) => r.provider).join(", ") || "-"})`);
    out(`*_oauth configs: ${c.configs.length} rows, ${c.configTargets.length} to re-seal (keys: ${c.configTargets.map((r) => r.key).join(", ") || "-"})`);
    out("DRY RUN: nothing was written. Re-run with --apply, RESEAL_OWNER_GO and SECRETS_ENCRYPTION_KEY once the owner has said go by name.");
    return;
  }
  await client.query("BEGIN");
  try {
    await client.query(PROCORE_LOCK_SQL); // exclude a concurrent Procore refresh / reconnect before reading anything
    const c = await collect(client as any, currentKeyId, true); // re-read under the lock: the rows below are exactly what is rewritten
    for (const r of c.tokenTargets) {
      const plainA = openSecret(r.access_token, env);
      const plainR = openSecret(r.refresh_token, env);
      const a = sealSecret(plainA, env);
      const rt = sealSecret(plainR, env);
      if (openSecret(a, env) !== plainA || openSecret(rt, env) !== plainR) throw new Error(`verification failed for oauth_tokens ${r.provider}`);
      await client.query("UPDATE oauth_tokens SET access_token = $2, refresh_token = $3, updated_at = now() WHERE provider = $1", [r.provider, a, rt]);
    }
    for (const r of c.configTargets) {
      const plain = mapOAuthConfigValue(r.value, (x) => openSecret(x, env));
      const sealed = mapOAuthConfigValue(plain, (x) => sealSecret(x, env));
      const reopened = mapOAuthConfigValue(sealed, (x) => openSecret(x, env));
      if (JSON.stringify(reopened) !== JSON.stringify(plain)) throw new Error(`verification failed for automation_config ${r.key}`);
      await client.query("UPDATE automation_config SET value = $2::jsonb, updated_at = now() WHERE key = $1", [r.key, JSON.stringify(sealed)]);
    }
    await client.query("COMMIT");
    out(`APPLIED (owner go: ${env.RESEAL_OWNER_GO}): re-sealed ${c.tokenTargets.length} oauth_tokens row(s) and ${c.configTargets.length} config row(s) under key id ${currentKeyId}.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = console.log): Promise<number> {
  const apply = argv.includes("--apply");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  if (apply) {
    if (!env.RESEAL_OWNER_GO?.trim()) throw new Error("--apply refused: set RESEAL_OWNER_GO to the name of the owner's go (this rewrites stored tokens)");
    if (!loadKeyRing(env)) throw new Error("--apply refused: SECRETS_ENCRYPTION_KEY is not set");
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await resealWith(client, apply, env, out);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && /reseal-oauth-secrets\.ts$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
