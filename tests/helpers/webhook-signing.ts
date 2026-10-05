// Test-only auth headers for the inbound Procore webhooks (server/webhooks/signature.ts). The secret is a fixture,
// not a credential.
export const TEST_PROCORE_WEBHOOK_SECRET = "test-procore-webhook-token-fixture";

export function procoreAuthHeaders(secret: string = TEST_PROCORE_WEBHOOK_SECRET) {
  return { authorization: `Bearer ${secret}` };
}
