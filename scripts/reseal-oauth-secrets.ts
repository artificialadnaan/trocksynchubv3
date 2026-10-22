#!/usr/bin/env -S npx tsx
/**
 * [DESTRUCTIVE — owner go] Re-seal the OAuth tokens that are still PLAINTEXT in oauth_tokens and the *_oauth automation_config rows
 * (security hardening H2). Ships OFF: the default is a DRY RUN that prints COUNTS ONLY (never a token); --apply additionally requires the owner's
 * named go in RESEAL_OWNER_GO and SECRETS_ENCRYPTION_KEY to be set. Each row is rewritten in one transaction, and the transaction is rolled back
 * unless every rewritten value opens back to exactly what was there. Run it through DATABASE_PUBLIC_URL when it is run from outside Railway.
 *
 *   DATABASE_URL=... npx tsx scripts/reseal-oauth-secrets.ts                       # dry run
 *   SECRETS_ENCRYPTION_KEY=... RESEAL_OWNER_GO="<who approved>" DATABASE_URL=... npx tsx scripts/reseal-oauth-secrets.ts --apply
 */
import pg from "pg";
import { isOAuthConfigKey, isSealed, loadKeyRing, mapOAuthConfigValue, openSecret, sealSecret } from "../server/lib/secret-seal";

const TOKEN_FIELDS = ["accessToken", "refreshToken"] as const;

export function plaintextConfigFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return TOKEN_FIELDS.filter((f) => typeof (value as any)[f] === "string" && (value as any)[f] !== "" && !isSealed((value as any)[f]));
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
    const tokens = await client.query<{ provider: string; access_token: string; refresh_token: string | null }>(
      "SELECT provider, access_token, refresh_token FROM oauth_tokens ORDER BY provider",
    );
    const configs = await client.query<{ key: string; value: unknown }>("SELECT key, value FROM automation_config WHERE key LIKE '%\\_oauth' ORDER BY key");
    const tokenTargets = tokens.rows.filter((r) => (r.access_token && !isSealed(r.access_token)) || (r.refresh_token && !isSealed(r.refresh_token)));
    const configTargets = configs.rows.filter((r) => isOAuthConfigKey(r.key) && plaintextConfigFields(r.value).length > 0);
    out(`oauth_tokens: ${tokens.rows.length} rows, ${tokenTargets.length} with plaintext (providers: ${tokenTargets.map((r) => r.provider).join(", ") || "-"})`);
    out(`*_oauth configs: ${configs.rows.length} rows, ${configTargets.length} with plaintext (keys: ${configTargets.map((r) => r.key).join(", ") || "-"})`);
    if (!apply) {
      out("DRY RUN: nothing was written. Re-run with --apply, RESEAL_OWNER_GO and SECRETS_ENCRYPTION_KEY once the owner has said go by name.");
      return 0;
    }
    await client.query("BEGIN");
    try {
      for (const r of tokenTargets) {
        const a = sealSecret(r.access_token, env);
        const rt = sealSecret(r.refresh_token, env);
        if (openSecret(a, env) !== r.access_token || openSecret(rt, env) !== r.refresh_token) throw new Error(`verification failed for oauth_tokens ${r.provider}`);
        await client.query("UPDATE oauth_tokens SET access_token = $2, refresh_token = $3, updated_at = now() WHERE provider = $1", [r.provider, a, rt]);
      }
      for (const r of configTargets) {
        const sealed = mapOAuthConfigValue(r.value, (s) => sealSecret(s, env));
        const reopened = mapOAuthConfigValue(sealed, (s) => openSecret(s, env));
        if (JSON.stringify(reopened) !== JSON.stringify(r.value)) throw new Error(`verification failed for automation_config ${r.key}`);
        await client.query("UPDATE automation_config SET value = $2::jsonb, updated_at = now() WHERE key = $1", [r.key, JSON.stringify(sealed)]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    out(`APPLIED (owner go: ${env.RESEAL_OWNER_GO}): re-sealed ${tokenTargets.length} oauth_tokens row(s) and ${configTargets.length} config row(s).`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && /reseal-oauth-secrets\.ts$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
