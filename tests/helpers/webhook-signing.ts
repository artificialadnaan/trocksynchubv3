import crypto from "crypto";

// Test helpers for the webhook routes after H5 (verification fails closed): the secrets the routes read, a JSON parser that captures the raw body
// the way the production parser does (server/json-body.ts), and signatures for the HubSpot v1 and Procore schemes.
export const TEST_HUBSPOT_SECRET = "test-hubspot-secret-not-real-0123456789";
export const TEST_PROCORE_SECRET = "test-procore-secret-not-real-0123456789";

export function setWebhookSecrets(): void {
  process.env.HUBSPOT_CLIENT_SECRET = TEST_HUBSPOT_SECRET;
  process.env.PROCORE_WEBHOOK_SECRET = TEST_PROCORE_SECRET;
}
export function clearWebhookSecrets(): void {
  delete process.env.HUBSPOT_CLIENT_SECRET;
  delete process.env.PROCORE_WEBHOOK_SECRET;
}

export const rawBodyCapture = (req: any, _res: unknown, buf: Buffer): void => {
  req.rawBody = buf;
};

export function hubspotSignedHeaders(rawBody: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-hubspot-signature": crypto.createHash("sha256").update(TEST_HUBSPOT_SECRET + rawBody, "utf8").digest("hex"),
  };
}
export function procoreSignedHeaders(rawBody: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-procore-signature": crypto.createHmac("sha256", TEST_PROCORE_SECRET).update(rawBody, "utf8").digest("hex"),
  };
}
