// Inbound webhook authentication (security audit P1, 2026-10-04). The vendor webhooks used to verify only
// `if (signature)` — a request with NO signature header was accepted — and only `if (secret)`, so with the secret
// unset (production, 2026-10-04) nothing was verified at all.
//
// Now FAIL CLOSED:
//  - no secret configured -> 503 webhook_auth_not_configured (never "accept unverified");
//  - a missing or wrong token -> 401;
//  - the comparison is constant-time.
//
// The HubSpot webhook is retired (T-Rock no longer uses HubSpot): /webhooks/hubspot is a 410 stub with no verifier.
// Procore: Procore does not HMAC-sign webhook bodies. Its hooks carry the custom headers configured on the hook, so
//   the hook is set up with `Authorization: Bearer <PROCORE_WEBHOOK_SECRET>`, compared here in constant time.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type WebhookAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still spend a comparison, so a length mismatch is not a faster "no".
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function oneHeader(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0]! : null;
  return typeof v === "string" ? v : null;
}

export function verifyProcoreToken(req: Request, secret: string | undefined): WebhookAuthResult {
  if (!secret?.trim()) return { ok: false, status: 503, error: "webhook_auth_not_configured" };
  const auth = oneHeader(req, "authorization");
  if (!auth) return { ok: false, status: 401, error: "invalid_signature" };
  return safeEqual(auth, `Bearer ${secret}`) ? { ok: true } : { ok: false, status: 401, error: "invalid_signature" };
}

/** Route guard: answers the refusal (with a log line naming the reason only) or calls next(). */
export function requireWebhookAuth(
  source: "procore",
  verify: (req: Request) => WebhookAuthResult,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = verify(req);
    if (result.ok) return next();
    console.warn(`[webhook] ${source} request refused: ${result.error}`);
    res.status(result.status).json({ error: result.error });
  };
}
