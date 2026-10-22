import crypto from "crypto";

/**
 * Webhook signature verification that FAILS CLOSED (security hardening H5, 2026-10-22).
 *
 * Before: a blank secret, or a request carrying NO signature header, skipped verification and the webhook was processed. A blank
 * secret therefore meant "anyone who can POST the URL can drive HubSpot/Procore automations". Now: no secret configured → the endpoint
 * refuses (503, a misconfiguration the operator must fix); a secret but no valid signature → 401. There is no bypass switch.
 *
 * Pure (no I/O, no clock unless injected) so it is tested directly.
 */
export type WebhookVerdict =
  | { ok: true; scheme: string }
  | { ok: false; status: 401 | 503; reason: "secret_not_configured" | "signature_missing" | "signature_invalid" | "timestamp_invalid" };

const MAX_SKEW_MS = 5 * 60 * 1000; // HubSpot v3: reject a request timestamped more than 5 minutes ago

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The exact bytes the sender signed: the raw body captured by the JSON parser, never a re-serialization of req.body. */
export function rawBodyOf(req: { rawBody?: unknown; body?: unknown }): string {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
  if (typeof req.rawBody === "string") return req.rawBody;
  return ""; // no raw body captured: nothing verifiable (the signature will not match)
}

/**
 * HubSpot (public-app webhooks), signed with the app's client secret:
 *   v3: base64(HMAC-SHA256(secret, METHOD + full request URI + raw body + X-HubSpot-Request-Timestamp)) in X-HubSpot-Signature-v3,
 *       and the timestamp must be within 5 minutes;
 *   v1: hex(SHA-256(secret + raw body)) in X-HubSpot-Signature.
 * v3 is preferred when both are present; if v3 does not verify but a valid v1 signature is also present, v1 admits (a proxy can change the URL v3 covers).
 */
export function verifyHubspotWebhook(input: {
  secret: string | undefined;
  method: string;
  /** The full URL HubSpot called, e.g. https://host/webhooks/hubspot (scheme + host + path + query). */
  url: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  nowMs?: number;
}): WebhookVerdict {
  if (!input.secret) return { ok: false, status: 503, reason: "secret_not_configured" };
  const v3 = first(input.headers["x-hubspot-signature-v3"]);
  if (v3) {
    const ts = first(input.headers["x-hubspot-request-timestamp"]);
    const tsMs = ts === undefined ? NaN : Number(ts);
    const now = input.nowMs ?? Date.now();
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > MAX_SKEW_MS) return { ok: false, status: 401, reason: "timestamp_invalid" };
    const expected = crypto.createHmac("sha256", input.secret).update(`${input.method.toUpperCase()}${input.url}${input.rawBody}${ts}`, "utf8").digest("base64");
    if (safeEqual(expected, v3)) return { ok: true, scheme: "hubspot-v3" };
    // A v3 mismatch can be only a URL/host reconstruction difference behind a proxy; a valid v1 signature (also an HMAC proof of the secret) still admits.
    if (!first(input.headers["x-hubspot-signature"])) return { ok: false, status: 401, reason: "signature_invalid" };
  }
  const v1 = first(input.headers["x-hubspot-signature"]);
  if (v1) {
    const expected = crypto.createHash("sha256").update(input.secret + input.rawBody, "utf8").digest("hex");
    return safeEqual(expected, v1.toLowerCase()) ? { ok: true, scheme: "hubspot-v1" } : { ok: false, status: 401, reason: "signature_invalid" };
  }
  return { ok: false, status: 401, reason: "signature_missing" };
}

/** Procore webhook: hex(HMAC-SHA256(secret, raw body)) in X-Procore-Signature or X-Webhook-Signature (an optional `sha256=` prefix is accepted). */
export function verifyProcoreWebhook(input: {
  secret: string | undefined;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}): WebhookVerdict {
  if (!input.secret) return { ok: false, status: 503, reason: "secret_not_configured" };
  const provided = first(input.headers["x-procore-signature"]) ?? first(input.headers["x-webhook-signature"]);
  if (!provided) return { ok: false, status: 401, reason: "signature_missing" };
  const expected = crypto.createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  return safeEqual(expected, provided.replace(/^sha256=/i, "").toLowerCase()) ? { ok: true, scheme: "procore-hmac" } : { ok: false, status: 401, reason: "signature_invalid" };
}
