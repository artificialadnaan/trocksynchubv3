/**
 * Provider CLIENT SECRETS come from the environment (security hardening H1, 2026-10-22).
 *
 * Before: Microsoft's and Procore's client secrets were read DB-first from the plaintext `automation_config` JSON (microsoft_config /
 * procore_config) and the Drive secret from storage_provider_config, so every rotated secret landed in a database whose password may be exposed.
 *
 * Now: the ENVIRONMENT variable is the one copy. Resolution order:
 *   1. the env var, when set (a DB copy is IGNORED, never preferred);
 *   2. otherwise the legacy DB copy, with a one-time warning, so a deploy that precedes the env var being set does not take the integration down.
 *      CLIENT_SECRETS_ENV_ONLY=true removes this step (use it once the env values are live and the DB copies are cleared).
 * New secrets are never WRITTEN to the database (see stripClientSecret). Names only are logged, never values.
 */
const warned = new Set<string>();

export function resolveClientSecret(opts: { label: string; envName: string; dbValue: unknown }): string {
  // Trimmed: a pasted value with a trailing newline or space is the same secret, and a whitespace-only value is "unset" (it must not shadow a good legacy copy).
  const fromEnv = process.env[opts.envName]?.trim();
  if (fromEnv) return fromEnv;
  const legacy = typeof opts.dbValue === "string" ? opts.dbValue : "";
  if (process.env.CLIENT_SECRETS_ENV_ONLY === "true") {
    if (legacy && !warned.has(`only:${opts.envName}`)) {
      warned.add(`only:${opts.envName}`);
      console.error(`[client-secret] ${opts.label}: ${opts.envName} is not set and CLIENT_SECRETS_ENV_ONLY=true, so the legacy database copy is NOT used`);
    }
    return "";
  }
  if (legacy && !warned.has(opts.envName)) {
    warned.add(opts.envName);
    console.warn(`[client-secret] ${opts.label}: ${opts.envName} is not set; using the legacy database copy. Set ${opts.envName} and clear the database copy.`);
  }
  return legacy;
}

/** True when a secret is actually usable under the same rules the OAuth paths apply (env first, then the legacy copy unless CLIENT_SECRETS_ENV_ONLY). A save that would leave this false is refused. */
export function hasUsableClientSecret(envName: string, dbValue: unknown): boolean {
  return resolveClientSecret({ label: envName, envName, dbValue }) !== "";
}

/** A config object without its `clientSecret` (what is persisted from now on). */
export function stripClientSecret<T extends Record<string, unknown>>(value: T): Omit<T, "clientSecret"> {
  const { clientSecret: _dropped, ...rest } = value;
  return rest;
}

/**
 * What a settings save may keep of an EXISTING stored secret: the legacy copy is carried over only while the env var is still unset (so saving
 * other fields does not take the integration down before the env value exists); once the env var is set the stored copy is dropped. A value
 * typed into a form is never what this returns.
 */
export function legacySecretToKeep(envName: string, existingDbValue: unknown): string | undefined {
  if (process.env[envName]?.trim()) return undefined;
  return typeof existingDbValue === "string" && existingDbValue.length > 0 ? existingDbValue : undefined;
}

/** Test seam: forget which warnings were already printed. */
export function resetClientSecretWarnings(): void {
  warned.clear();
}
