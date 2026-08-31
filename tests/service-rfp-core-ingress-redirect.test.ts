// =============================================================================
// [CodeRabbit #75 — CWE-319] THE POST MUST NOT FOLLOW A REDIRECT.
//
// fetch follows redirects by default, and 307/308 PRESERVE the method and body. A redirect to `http:`
// would therefore replay this POST in cleartext — carrying the customer's name, contact email and site
// address. That defeats the https-only check on the base URL: validating the configured ORIGIN is
// worthless if the request can be walked off it mid-flight.
//
// Asserted on the request INIT rather than by simulating a redirect, because the guarantee is a property
// of how the request is issued: with `redirect: "error"` the runtime rejects before any body is resent,
// and there is no observable second request to assert against.
// =============================================================================

import { describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../server/lib/fetch-with-timeout.ts", () => ({ fetchWithTimeout: fetchMock }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const { postServiceRfpApproved } = await import("../server/sync/core-ingress-client.ts");

const BODY = {
  version: "trock.crm.service-rfp-approved.v1",
  office: "dallas",
  occurredAt: new Date("2026-08-31T12:00:00.000Z").toISOString(),
  rfp: { requestId: 1, approvedAt: new Date("2026-08-31T11:59:00.000Z").toISOString() },
  deal: { id: "11111111-1111-4111-8111-111111111111", rfpProjectNumber: "RFP-1" },
  company: { id: "22222222-2222-4222-8222-222222222222", name: "Acme" },
  primaryContact: { name: "Dana", email: "dana@acme.test", businessPhone: null },
  bid: { title: "Re-roof", estimatedValue: null, dueAt: null, description: null, notes: null },
  property: { id: "33333333-3333-4333-8333-333333333333", name: "Site", address: null },
} as any;

describe("the approved-RFP POST refuses to be redirected", () => {
  it("issues the request with redirect: 'error', so a 307/308 cannot replay the body", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ bidId: "bid-1" }), { status: 201, headers: { "Content-Type": "application/json" } }),
    );

    await postServiceRfpApproved({
      targetUrl: "https://core.example.com/webhooks/crm/dallas/service-rfp/v1",
      body: BODY,
      secret: "x".repeat(64),
    } as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    // The whole point: a downgrade to http must not be reachable by following a Location header.
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
  });

  it("classifies a redirect refusal as RETRYABLE, so a relocated ingress is not dead-lettered", async () => {
    // Node rejects the fetch when redirect:'error' meets a 3xx; the existing catch turns any transport
    // failure into a retryable outcome. A genuinely relocated Core is then a provisioning fix plus a
    // retry, not a terminal loss of the approval.
    fetchMock.mockRejectedValue(new TypeError("unexpected redirect"));

    const outcome = await postServiceRfpApproved({
      targetUrl: "https://core.example.com/webhooks/crm/dallas/service-rfp/v1",
      body: BODY,
      secret: "x".repeat(64),
    } as any);

    expect(outcome.kind).toBe("retryable");
  });
});
