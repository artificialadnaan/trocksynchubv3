import crypto from "node:crypto";

// Test-only signing for the inbound webhooks (server/webhooks/signature.ts). The secrets are fixtures, not credentials.
export const TEST_HUBSPOT_CLIENT_SECRET = "test-hubspot-client-secret-fixture";
export const TEST_PROCORE_WEBHOOK_SECRET = "test-procore-webhook-token-fixture";

/**
 * Headers HubSpot (Signature v3) would send for this POST. The URI's origin is the one the verifier rebuilds: APP_URL
 * when it is set, else https://<host>. `path` is the URI as HubSpot signs it (already in its v3 decoded form).
 */
export function hubspotV3Headers(baseUrl: string, path: string, body: string, opts: { secret?: string; timestamp?: number } = {}) {
  const ts = String(opts.timestamp ?? Date.now());
  const appUrl = process.env.APP_URL?.trim();
  const origin = appUrl ? appUrl.replace(/\/+$/, "") : `https://${new URL(baseUrl).host}`;
  const sig = crypto
    .createHmac("sha256", opts.secret ?? TEST_HUBSPOT_CLIENT_SECRET)
    .update(`POST` + origin + path + body + ts)
    .digest("base64");
  return { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts };
}

export function procoreAuthHeaders(secret: string = TEST_PROCORE_WEBHOOK_SECRET) {
  return { authorization: `Bearer ${secret}` };
}
