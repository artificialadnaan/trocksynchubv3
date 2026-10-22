import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for OAuth tokens (security hardening H2, 2026-10-22). AES-256-GCM with a KEY ID and previous keys, the construction of
 * Expense's apps/api/src/crypto/token-encryption.ts: 12-byte random IV per value, the auth tag is always checked, and a key must be exactly 32
 * bytes of canonical base64.
 *
 * Stored form of a sealed value (a plain string in the existing text/jsonb columns, so no schema change):
 *     enc:v1:<keyId>:<iv base64>:<tag base64>:<ciphertext base64>
 *
 * DUAL READ (the migration path): a value WITHOUT the `enc:v1:` prefix is a legacy plaintext token and is returned as is; a prefixed value is
 * decrypted with the key its id names. DORMANT UNTIL CONFIGURED: with no SECRETS_ENCRYPTION_KEY, sealSecret writes plaintext exactly as before, so
 * deploying this code changes no stored data. Once the key is set, every NEW write is sealed; existing rows are re-sealed by the owner-go script
 * scripts/reseal-oauth-secrets.ts (dry run by default). Values are never logged.
 *
 * Env: SECRETS_ENCRYPTION_KEY (base64, 32 bytes), SECRETS_ENCRYPTION_KEY_ID (default "k1"), SECRETS_PREVIOUS_KEYS ("id:base64,id:base64").
 */
export const SEAL_PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

type KeyRing = { currentId: string; keys: Map<string, Buffer> };

function decodeKey(base64: string, where: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== base64) throw new Error(`${where} must be a base64-encoded 32-byte key`);
  return key;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** The configured key ring, or null when SECRETS_ENCRYPTION_KEY is unset (sealing is then off). Throws on a malformed configuration. */
export function loadKeyRing(env: NodeJS.ProcessEnv = process.env): KeyRing | null {
  const current = env.SECRETS_ENCRYPTION_KEY;
  const previous = env.SECRETS_PREVIOUS_KEYS;
  if (!current) {
    if (previous) throw new Error("SECRETS_PREVIOUS_KEYS is set but SECRETS_ENCRYPTION_KEY is not");
    return null;
  }
  const currentId = env.SECRETS_ENCRYPTION_KEY_ID || "k1";
  if (!ID_PATTERN.test(currentId)) throw new Error("SECRETS_ENCRYPTION_KEY_ID must be 1-32 characters of A-Z a-z 0-9 _ -");
  const keys = new Map<string, Buffer>([[currentId, decodeKey(current, "SECRETS_ENCRYPTION_KEY")]]);
  for (const entry of (previous ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf(":");
    const id = at < 0 ? "" : entry.slice(0, at);
    if (!ID_PATTERN.test(id)) throw new Error("SECRETS_PREVIOUS_KEYS entries must be id:base64");
    if (keys.has(id)) throw new Error(`SECRETS_PREVIOUS_KEYS repeats key id ${id}`);
    keys.set(id, decodeKey(entry.slice(at + 1), `SECRETS_PREVIOUS_KEYS (${id})`));
  }
  return { currentId, keys };
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SEAL_PREFIX);
}

/** The key id a sealed value names (null for a plaintext value). */
export function sealedKeyId(value: unknown): string | null {
  if (!isSealed(value)) return null;
  return value.slice(SEAL_PREFIX.length).split(":")[0] || null;
}

/** True when a stored value should be (re)sealed under the CURRENT key: plaintext, or sealed under a retired key id. Empty/absent values never are. */
export function needsReseal(value: unknown, currentKeyId: string | null): boolean {
  if (typeof value !== "string" || value === "") return false;
  if (!isSealed(value)) return true;
  return currentKeyId !== null && sealedKeyId(value) !== currentKeyId;
}

/** Seal a token for storage. null/undefined/empty pass through; with no key configured the plaintext is returned unchanged (dormant). An already-sealed value is not sealed twice. */
export function sealSecret<T extends string | null | undefined>(plain: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof plain !== "string" || plain === "" || isSealed(plain)) return plain;
  const ring = loadKeyRing(env);
  if (!ring) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ring.keys.get(ring.currentId)!, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${SEAL_PREFIX}${ring.currentId}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}` as T;
}

/** Open a stored token. A value without the prefix is legacy plaintext and is returned unchanged. A sealed value needs its key id in the ring; tampering throws. */
export function openSecret<T extends string | null | undefined>(stored: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!isSealed(stored)) return stored;
  const parts = stored.slice(SEAL_PREFIX.length).split(":");
  if (parts.length !== 4) throw new Error("Malformed sealed secret");
  const [keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const ring = loadKeyRing(env);
  if (!ring) throw new Error(`A stored secret is sealed with key id ${keyId} but SECRETS_ENCRYPTION_KEY is not set`);
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`A stored secret is sealed with key id ${keyId}, which is not in SECRETS_ENCRYPTION_KEY / SECRETS_PREVIOUS_KEYS`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8") as T;
}

/** The automation_config rows that hold OAuth tokens (microsoft_oauth, gmail_oauth, ...). */
export const isOAuthConfigKey = (key: string): boolean => /_oauth$/.test(key);
const OAUTH_CONFIG_FIELDS = ["accessToken", "refreshToken"] as const;

/** A copy of an OAuth config value with its token fields sealed (or opened). Non-object values pass through. */
export function mapOAuthConfigValue(value: unknown, fn: (s: string) => string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of OAUTH_CONFIG_FIELDS) if (typeof copy[field] === "string") copy[field] = fn(copy[field] as string);
  return copy;
}
export const sealOAuthConfigValue = (value: unknown, env?: NodeJS.ProcessEnv) => mapOAuthConfigValue(value, (s) => sealSecret(s, env));
export const openOAuthConfigValue = (value: unknown, env?: NodeJS.ProcessEnv) => mapOAuthConfigValue(value, (s) => openSecret(s, env));
