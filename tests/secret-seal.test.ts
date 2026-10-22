import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SEAL_PREFIX, isOAuthConfigKey, isSealed, loadKeyRing, openOAuthConfigValue, openSecret, sealOAuthConfigValue, sealSecret } from "../server/lib/secret-seal.ts";

// H2 (security rotation, 2026-10-22): OAuth tokens sealed at rest with AES-256-GCM and a key id; legacy plaintext still reads (dual read).
const key = () => randomBytes(32).toString("base64");
const env = (extra: Record<string, string | undefined> = {}) => ({ ...extra }) as NodeJS.ProcessEnv;
const K1 = key();
const K2 = key();

describe("sealSecret / openSecret", () => {
  it("is DORMANT without SECRETS_ENCRYPTION_KEY: the value is stored as plaintext, exactly as before", () => {
    expect(sealSecret("tok-123", env())).toBe("tok-123");
    expect(sealSecret(null, env())).toBeNull();
    expect(sealSecret(undefined, env())).toBeUndefined();
  });
  it("round-trips, never stores the plaintext, and uses a fresh IV each time", () => {
    const e = env({ SECRETS_ENCRYPTION_KEY: K1 });
    const a = sealSecret("tok-123", e);
    const b = sealSecret("tok-123", e);
    expect(a.startsWith(`${SEAL_PREFIX}k1:`)).toBe(true);
    expect(a).not.toContain("tok-123");
    expect(a).not.toBe(b);
    expect(openSecret(a, e)).toBe("tok-123");
  });
  it("DUAL READ: a legacy plaintext value opens unchanged, with or without a key; an already-sealed value is not sealed twice", () => {
    expect(openSecret("legacy-plain", env({ SECRETS_ENCRYPTION_KEY: K1 }))).toBe("legacy-plain");
    expect(openSecret("legacy-plain", env())).toBe("legacy-plain");
    const e = env({ SECRETS_ENCRYPTION_KEY: K1 });
    const once = sealSecret("tok", e);
    expect(sealSecret(once, e)).toBe(once);
    expect(isSealed(once)).toBe(true);
  });
  it("KEY ID rotation: a value sealed under k1 opens after the key moves to k2 only if k1 is listed as a previous key", () => {
    const sealedUnderK1 = sealSecret("tok-rot", env({ SECRETS_ENCRYPTION_KEY: K1, SECRETS_ENCRYPTION_KEY_ID: "k1" }));
    const rotated = env({ SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: "k2", SECRETS_PREVIOUS_KEYS: `k1:${K1}` });
    expect(openSecret(sealedUnderK1, rotated)).toBe("tok-rot");
    expect(sealSecret("new", rotated).startsWith(`${SEAL_PREFIX}k2:`)).toBe(true);
    expect(() => openSecret(sealedUnderK1, env({ SECRETS_ENCRYPTION_KEY: K2, SECRETS_ENCRYPTION_KEY_ID: "k2" }))).toThrow(/key id k1/);
  });
  it("a sealed value with no key configured, a tampered ciphertext, and the wrong key all throw (never garbage)", () => {
    const sealed = sealSecret("tok", env({ SECRETS_ENCRYPTION_KEY: K1 }));
    expect(() => openSecret(sealed, env())).toThrow(/SECRETS_ENCRYPTION_KEY is not set/);
    const parts = sealed.split(":");
    parts[5] = Buffer.from("tampered").toString("base64");
    expect(() => openSecret(parts.join(":"), env({ SECRETS_ENCRYPTION_KEY: K1 }))).toThrow();
    expect(() => openSecret(sealed, env({ SECRETS_ENCRYPTION_KEY: K2 }))).toThrow();
  });
  it("refuses a malformed key configuration with the variable's name, and never echoes a key", () => {
    for (const bad of ["not-base64!!", Buffer.from("short").toString("base64"), `${K1}\n`]) {
      let msg = "";
      try { loadKeyRing(env({ SECRETS_ENCRYPTION_KEY: bad })); } catch (e) { msg = String(e); }
      expect(msg).toContain("SECRETS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
      expect(msg).not.toContain(bad.trim());
    }
    expect(() => loadKeyRing(env({ SECRETS_PREVIOUS_KEYS: `k1:${K1}` }))).toThrow(/SECRETS_PREVIOUS_KEYS is set but/);
    expect(() => loadKeyRing(env({ SECRETS_ENCRYPTION_KEY: K1, SECRETS_PREVIOUS_KEYS: `k1:${K2}` }))).toThrow(/repeats key id k1/);
  });
});

describe("*_oauth automation_config values", () => {
  it("identifies the OAuth rows and seals/opens only the token fields, keeping everything else", () => {
    expect(isOAuthConfigKey("microsoft_oauth")).toBe(true);
    expect(isOAuthConfigKey("gmail_oauth")).toBe(true);
    expect(isOAuthConfigKey("procore_config")).toBe(false);
    const e = env({ SECRETS_ENCRYPTION_KEY: K1 });
    const stored = sealOAuthConfigValue({ accessToken: "A", refreshToken: "R", expiresAt: 5, userEmail: "u@x", scope: "s" }, e) as any;
    expect(stored.accessToken.startsWith(SEAL_PREFIX)).toBe(true);
    expect(stored.refreshToken.startsWith(SEAL_PREFIX)).toBe(true);
    expect(stored).toMatchObject({ expiresAt: 5, userEmail: "u@x", scope: "s" });
    expect(openOAuthConfigValue(stored, e)).toEqual({ accessToken: "A", refreshToken: "R", expiresAt: 5, userEmail: "u@x", scope: "s" });
    expect(sealOAuthConfigValue({}, e)).toEqual({}); // a disconnect writes {} and stays {}
    expect(sealOAuthConfigValue(null, e)).toBeNull();
  });
});
