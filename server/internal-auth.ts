// Shared-secret gate for the /api/internal/* operator endpoints (no session auth).
//
// FAIL CLOSED: when INTERNAL_API_SECRET is unset or blank, every guarded endpoint answers
// 503 { error: "internal_secret_not_configured" }. There is deliberately NO fallback value: an
// endpoint that would otherwise accept a secret committed to the repository is disabled instead.
//
// The secret is read from the `x-internal-secret` header only, and compared in constant time.
import crypto from "crypto";
import type { RequestHandler } from "express";

export const INTERNAL_SECRET_HEADER = "x-internal-secret";
export const INTERNAL_SECRET_ENV = "INTERNAL_API_SECRET";

/** The configured secret, or null when it is unset or blank (which disables the endpoints). */
export function getConfiguredInternalSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[INTERNAL_SECRET_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw;
}

/**
 * Constant-time equality. Both sides are hashed to fixed-length SHA-256 digests first, so
 * crypto.timingSafeEqual always compares equal-length buffers and the comparison time does not
 * depend on where the inputs differ or on the length of the provided value.
 */
export function internalSecretMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export const requireInternalSecret: RequestHandler = (req, res, next) => {
  const expected = getConfiguredInternalSecret();
  if (expected === null) {
    res.status(503).json({ error: "internal_secret_not_configured" });
    return;
  }
  const provided = req.headers?.[INTERNAL_SECRET_HEADER];
  if (typeof provided !== "string" || provided === "" || !internalSecretMatches(provided, expected)) {
    res.status(401).json({ error: "invalid_internal_secret" });
    return;
  }
  next();
};
