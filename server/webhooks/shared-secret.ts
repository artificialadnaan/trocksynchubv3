import crypto from "crypto";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// ---- H6: POST /webhooks/procore/project-events — a shared secret in the Authorization header ---------------------------------------------
export type SharedSecretAuth = "valid" | "missing" | "invalid" | "unconfigured";
export interface SharedSecretVerdict { allow: boolean; status?: 401 | 503; auth: SharedSecretAuth; enforced: boolean }

/**
 * Procore's project-events hook carried NO verification at all. Procore lets a webhook send a custom Authorization header; the operator configures
 * the same value in PROCORE_PROJECT_EVENTS_SECRET. Two modes, so events keep flowing while the header is rolled out:
 *   - OBSERVE (PROCORE_PROJECT_EVENTS_ENFORCE unset or not "true"): every request is allowed, and the verdict (valid / missing / invalid / unconfigured)
 *     is logged so the operator can see the header being sent;
 *   - ENFORCE (PROCORE_PROJECT_EVENTS_ENFORCE=true): FAILS CLOSED. No secret configured → 503; a missing or wrong header → 401. There is no bypass.
 * Accepts the exact secret or `Bearer <secret>`; compared in constant time. The header value is never logged.
 */
export function checkSharedSecretHeader(input: { secret: string | undefined; header: string | string[] | undefined; enforce: boolean }): SharedSecretVerdict {
  const provided = first(input.header);
  let auth: SharedSecretAuth;
  if (!input.secret) auth = "unconfigured";
  else if (!provided) auth = "missing";
  else {
    const value = provided.replace(/^Bearer\s+/i, "");
    auth = safeEqual(value, input.secret) ? "valid" : "invalid";
  }
  if (!input.enforce) return { allow: true, auth, enforced: false };
  if (auth === "valid") return { allow: true, auth, enforced: true };
  return { allow: false, status: auth === "unconfigured" ? 503 : 401, auth, enforced: true };
}

/** Express middleware for the project-events route: reads the env at request time, logs the verdict (no values), refuses only when enforcing. */
export function projectEventsAuthGuard(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (l) => console.log(l),
) {
  return (req: { headers: Record<string, string | string[] | undefined> }, res: { status(c: number): { json(b: unknown): unknown } }, next: () => void) => {
    const verdict = checkSharedSecretHeader({
      secret: env.PROCORE_PROJECT_EVENTS_SECRET,
      header: req.headers["authorization"],
      enforce: env.PROCORE_PROJECT_EVENTS_ENFORCE === "true",
    });
    log(`[webhook] procore project-events auth=${verdict.auth} enforce=${verdict.enforced}${verdict.allow ? "" : " REFUSED"}`);
    if (verdict.allow) return next();
    res.status(verdict.status!).json({ error: verdict.auth === "unconfigured" ? "Webhook secret not configured" : "Unauthorized" });
  };
}
