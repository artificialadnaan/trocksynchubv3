import crypto from "crypto";

// Equal-length digests first, so timingSafeEqual always runs and the secret's length is not revealed by an early exit.
function safeEqual(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a, "utf8").digest();
  const y = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(x, y);
}
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// ---- H6: POST /webhooks/procore/project-events — a shared secret in the Authorization header ---------------------------------------------
export type SharedSecretAuth = "valid" | "missing" | "invalid" | "unconfigured";
export interface SharedSecretVerdict { allow: boolean; status?: 401 | 503; auth: SharedSecretAuth; enforced: boolean }

/**
 * Procore's project-events hook carried NO verification at all. Procore lets a webhook send a custom Authorization header; the operator configures
 * the same value in PROCORE_PROJECT_EVENTS_SECRET. Two modes (WEBHOOK_PROCORE_PROJECT_EVENTS_MODE), so events keep flowing while the header is rolled out:
 *   - LOG (the mode when the variable is unset, or "log"): every request is allowed, and the verdict (valid / missing / invalid / unconfigured)
 *     is logged so the operator can see the header being sent;
 *   - ENFORCE ("enforce"): FAILS CLOSED. No secret configured → 503; a missing or wrong header → 401. There is no bypass.
 * ANY OTHER VALUE IS ENFORCE (a typo such as "Enforced" or "on" must never leave the route open); the log says so.
 * Accepts the exact secret or `Bearer <secret>`; compared in constant time. The header value is never logged.
 */
export function checkSharedSecretHeader(input: { secret: string | undefined; header: string | string[] | undefined; enforce: boolean }): SharedSecretVerdict {
  const provided = first(input.header);
  let auth: SharedSecretAuth;
  if (!input.secret) auth = "unconfigured";
  else if (!provided) auth = "missing";
  else {
    // The exact header first (a secret that itself starts with "Bearer " must match as configured), then the form without the scheme.
    const stripped = provided.replace(/^Bearer\s+/i, "");
    const exact = safeEqual(provided, input.secret);
    const bare = safeEqual(stripped, input.secret);
    auth = exact || bare ? "valid" : "invalid";
  }
  if (!input.enforce) return { allow: true, auth, enforced: false };
  if (auth === "valid") return { allow: true, auth, enforced: true };
  return { allow: false, status: auth === "unconfigured" ? 503 : 401, auth, enforced: true };
}

/** Express middleware for the project-events route: reads the env at request time, logs the verdict (no values), refuses only when enforcing. */
export function projectEventsMode(env: NodeJS.ProcessEnv = process.env): { enforce: boolean; recognised: boolean } {
  const configured = env.WEBHOOK_PROCORE_PROJECT_EVENTS_MODE;
  // Unset (or an empty value) is the default LOG mode; a value of only whitespace is a typo and enforces like any other unrecognised value.
  if (configured === undefined || configured === "") return { enforce: false, recognised: true };
  const raw = configured.trim().toLowerCase();
  if (raw === "log") return { enforce: false, recognised: true };
  return { enforce: true, recognised: raw === "enforce" };
}

export function projectEventsAuthGuard(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (l) => console.log(l),
) {
  return (req: { headers: Record<string, string | string[] | undefined> }, res: { status(c: number): { json(b: unknown): unknown } }, next: () => void) => {
    const mode = projectEventsMode(env);
    const verdict = checkSharedSecretHeader({
      secret: env.PROCORE_PROJECT_EVENTS_SECRET,
      header: req.headers["authorization"],
      enforce: mode.enforce,
    });
    log(`[webhook] procore project-events auth=${verdict.auth} enforce=${verdict.enforced}${mode.recognised ? "" : " (unrecognised WEBHOOK_PROCORE_PROJECT_EVENTS_MODE: enforcing)"}${verdict.allow ? "" : " REFUSED"}`);
    if (verdict.allow) return next();
    res.status(verdict.status!).json({ error: verdict.auth === "unconfigured" ? "Webhook secret not configured" : "Unauthorized" });
  };
}
