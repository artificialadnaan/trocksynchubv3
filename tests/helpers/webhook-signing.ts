import crypto from "node:crypto";

// Test-only signing for the inbound webhooks (server/webhooks/signature.ts). The secrets are fixtures, not credentials.
export const TEST_HUBSPOT_CLIENT_SECRET = "test-hubspot-client-secret-fixture";
export const TEST_PROCORE_WEBHOOK_SECRET = "test-procore-webhook-token-fixture";

/** Headers HubSpot (Signature v3) would send for this POST: the URI is https://<host><path>, as the verifier rebuilds it. */
export function hubspotV3Headers(baseUrl: string, path: string, body: string, opts: { secret?: string; timestamp?: number } = {}) {
  const ts = String(opts.timestamp ?? Date.now());
  const host = new URL(baseUrl).host;
  const sig = crypto
    .createHmac("sha256", opts.secret ?? TEST_HUBSPOT_CLIENT_SECRET)
    .update(`POST` + `https://${host}${path}` + body + ts)
    .digest("base64");
  return { "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts };
}

export function procoreAuthHeaders(secret: string = TEST_PROCORE_WEBHOOK_SECRET) {
  return { authorization: `Bearer ${secret}` };
}
