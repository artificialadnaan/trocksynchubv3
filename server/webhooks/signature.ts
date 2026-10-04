// Inbound webhook authentication (security audit P1, 2026-10-04). Both vendor webhooks used to verify only
// `if (signature)` — a request with NO signature header was accepted — and only `if (secret)`, so with the secret
// unset (production, 2026-10-04) nothing was verified at all. The hash was also a hex HMAC over a RE-SERIALISED
// JSON.stringify(req.body) compared with !==, which matches neither vendor's scheme.
//
// Now FAIL CLOSED:
//  - no secret configured -> 503 webhook_auth_not_configured (never "accept unverified");
//  - a missing or wrong signature/token -> 401;
//  - every comparison is constant-time, over the RAW request bytes (req.rawBody from json-body.ts).
//
// HubSpot (Signature v3, https://developers.hubspot.com/docs/api/webhooks/validating-requests):
//   X-HubSpot-Signature-v3 = base64( HMAC-SHA256( clientSecret, METHOD + URI + rawBody + timestamp ) )
//   X-HubSpot-Request-Timestamp = epoch ms; a request more than 5 minutes off is refused (replay window).
//   URI is the full URL HubSpot called; behind Railway's proxy it is rebuilt from APP_URL (else https://<host>).
// Procore: Procore does not HMAC-sign webhook bodies. Its hooks carry the custom headers configured on the hook, so
//   the hook is set up with `Authorization: Bearer <PROCORE_WEBHOOK_SECRET>`, compared here in constant time.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const HUBSPOT_SIGNATURE_MAX_AGE_MS = 5 * 60_000;

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

function rawBodyOf(req: Request): Buffer {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  return Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
}

// HubSpot v3 signs the URI with exactly these percent-escapes decoded (path AND query); every other escape stays
// encoded, so the query is never fully decoded. Express keeps them encoded in req.originalUrl.
// https://developers.hubspot.com/docs/api/webhooks/validating-requests
const HUBSPOT_V3_DECODED: Record<string, string> = {
  "%3A": ":", "%2F": "/", "%3F": "?", "%40": "@", "%21": "!", "%24": "$",
  "%27": "'", "%28": "(", "%29": ")", "%2A": "*", "%2C": ",", "%3B": ";",
};

export function decodeHubSpotV3Uri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => HUBSPOT_V3_DECODED[m.toUpperCase()]!);
}

/** The full URL HubSpot signed: APP_URL's origin (the public one) plus the path and query as received, normalised. */
export function hubspotSignedUri(req: Request, appUrl = process.env.APP_URL): string {
  const base = appUrl?.trim() ? appUrl.trim().replace(/\/+$/, "") : `https://${req.get("host") ?? ""}`;
  return `${base}${decodeHubSpotV3Uri(req.originalUrl)}`;
}

export function verifyHubSpotV3(
  req: Request,
  secret: string | undefined,
  nowMs: number = Date.now(),
): WebhookAuthResult {
  if (!secret?.trim()) return { ok: false, status: 503, error: "webhook_auth_not_configured" };
  const signature = oneHeader(req, "x-hubspot-signature-v3");
  const timestamp = oneHeader(req, "x-hubspot-request-timestamp");
  if (!signature || !timestamp || !/^\d{1,16}$/.test(timestamp)) return { ok: false, status: 401, error: "invalid_signature" };
  if (Math.abs(nowMs - Number(timestamp)) > HUBSPOT_SIGNATURE_MAX_AGE_MS) return { ok: false, status: 401, error: "stale_signature" };
  const source = Buffer.concat([
    Buffer.from(`${req.method.toUpperCase()}${hubspotSignedUri(req)}`, "utf8"),
    rawBodyOf(req),
    Buffer.from(timestamp, "utf8"),
  ]);
  const expected = crypto.createHmac("sha256", secret).update(source).digest("base64");
  return safeEqual(signature, expected) ? { ok: true } : { ok: false, status: 401, error: "invalid_signature" };
}

export function verifyProcoreToken(req: Request, secret: string | undefined): WebhookAuthResult {
  if (!secret?.trim()) return { ok: false, status: 503, error: "webhook_auth_not_configured" };
  const auth = oneHeader(req, "authorization");
  if (!auth) return { ok: false, status: 401, error: "invalid_signature" };
  return safeEqual(auth, `Bearer ${secret}`) ? { ok: true } : { ok: false, status: 401, error: "invalid_signature" };
}

/** Route guard: answers the refusal (with a log line naming the reason only) or calls next(). */
export function requireWebhookAuth(
  source: "hubspot" | "procore",
  verify: (req: Request) => WebhookAuthResult,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = verify(req);
    if (result.ok) return next();
    console.warn(`[webhook] ${source} request refused: ${result.error}`);
    res.status(result.status).json({ error: result.error });
  };
}
