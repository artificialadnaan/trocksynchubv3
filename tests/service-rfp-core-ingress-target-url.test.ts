import { describe, expect, it } from "vitest";

import { buildServiceRfpIngressTargetUrl } from "../server/sync/core-ingress-client.ts";

/**
 * The target URL is where the customer's name, contact email and site address are sent. The HMAC
 * authenticates those bytes; it does not conceal them, so the transport has to.
 */
describe("service-RFP Core ingress target URL", () => {
  it("builds the office-scoped path from an https base", () => {
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com")).toBe(
      "https://core.example.com/webhooks/crm/dallas/service-rfp/v1",
    );
    // A trailing slash on the configured base must not produce a doubled separator.
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com/")).toBe(
      "https://core.example.com/webhooks/crm/dallas/service-rfp/v1",
    );
  });

  it("refuses a plain-http base rather than sending customer data in the clear", () => {
    // A misconfigured base URL is the realistic way this happens, and returning null keeps the feature
    // inert — the same shape an absent secret already takes — instead of shipping a readable payload.
    expect(buildServiceRfpIngressTargetUrl("dallas", "http://core.example.com")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "http://127.0.0.1:3000")).toBeNull();
  });

  it("refuses a base that is absent, blank, or not a URL at all", () => {
    expect(buildServiceRfpIngressTargetUrl("dallas", undefined)).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "   ")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "core.example.com")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("", "https://core.example.com")).toBeNull();
  });

  it("percent-encodes the office segment", () => {
    expect(buildServiceRfpIngressTargetUrl("da llas", "https://core.example.com")).toBe(
      "https://core.example.com/webhooks/crm/da%20llas/service-rfp/v1",
    );
  });
});

/**
 * [CodeRabbit #75] A base URL that would RETARGET the POST is a misconfiguration, not a usable value.
 *
 * The protocol check alone let `https://host?x=1` through, and the ingress path is appended AFTER the
 * query — so the request goes to `/` carrying a malformed query instead of the ingress route. A fragment
 * is never transmitted at all. This validation exists to keep a bad configuration INERT rather than
 * half-working, which is the same reason plain http is refused rather than tolerated.
 */
describe("a base URL carrying a query or fragment is refused", () => {
  it("refuses a query string, which would otherwise swallow the ingress path", () => {
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com?x=1")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com/?x=1")).toBeNull();
  });

  it("refuses a fragment, which is never sent and so can only mislead", () => {
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com#frag")).toBeNull();
  });

  it("refuses a BARE delimiter, which parses as empty and slips a component check [Codex #79]", () => {
    // `new URL("https://host?")` reports search === "" — falsy — so a parsed-component guard accepts it,
    // and the appended path then lands inside the query: `https://host?/webhooks/...` requests `/`.
    // These are the likeliest copy-paste shapes, so they are the ones a component check must not miss.
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com?")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com#")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com/?")).toBeNull();
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com/#")).toBeNull();
  });

  it("still accepts an ordinary https base with a path prefix", () => {
    // The guard must not over-reach: a mounted-under-a-prefix Core is a legitimate configuration.
    expect(buildServiceRfpIngressTargetUrl("dallas", "https://core.example.com/api")).toBe(
      "https://core.example.com/api/webhooks/crm/dallas/service-rfp/v1",
    );
  });
});
