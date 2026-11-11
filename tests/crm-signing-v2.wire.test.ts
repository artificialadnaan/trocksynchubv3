import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SIGNING-HARDENING r1 (4c5bb802): the ONE shared SyncHub → CRM v2 signer (server/crm-signing-v2.ts) and the golden vector
// pinned on both sides (the same numbers are in 28's CRM verifier test). The wire: x-signature-version: 2,
// x-signature-timestamp: <unix seconds>, the signature header = sha256=<lowercase hex HMAC-SHA256(secret,
// "v2\n" + METHOD + "\n" + path + "\n" + ts + "\n" + hex(sha256(raw body)))>, path = the requested URL's pathname. At first
// use: a secret < 32 bytes or a non-https URL (localhost / 127.0.0.1 exempt) refuses the send, ONE alert per signer +
// reason. Synthetic key and bodies only (I7).
const alertMock = vi.hoisted(() => vi.fn(async (_code: string, _detail: Record<string, unknown>) => {}));
vi.mock("../server/sync/rfp-core-alert.ts", () => ({ raiseRfpCoreAlert: alertMock }));

const v2 = await import("../server/crm-signing-v2.ts");

const GOLDEN_KEY = "synthetic-crm-sign-v2-key-0123456789abcdef";
const GOLDEN_PATH = "/api/internal/core-bid-created";
const GOLDEN_TS = 1767225600;
const GOLDEN_BODY = '{"a":1}';
const GOLDEN_BODY_SHA256 = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";
const GOLDEN_SIGNED_STRING = "v2\nPOST\n/api/internal/core-bid-created\n1767225600\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";
const GOLDEN_HEADER = "sha256=695942909dd87954e0f052afb0fffe9e6442cb620cc1de89c7a8a55f6b1c7f5e";

beforeEach(() => {
  alertMock.mockReset();
  v2.resetCrmSigningRefusalsForTests();
});

describe("the shared golden vector (pinned with the CRM verifier)", () => {
  it("POST /api/internal/core-bid-created, ts 1767225600, body {\"a\":1}: the exact signed string and header value", () => {
    expect(Buffer.byteLength(GOLDEN_KEY, "utf8")).toBe(42);
    expect(crypto.createHash("sha256").update(GOLDEN_BODY).digest("hex")).toBe(GOLDEN_BODY_SHA256);
    expect(v2.crmV2SignedString({ method: "POST", path: GOLDEN_PATH, timestamp: GOLDEN_TS, rawBody: GOLDEN_BODY })).toBe(GOLDEN_SIGNED_STRING);
    expect(v2.signCrmV2({ method: "POST", path: GOLDEN_PATH, timestamp: GOLDEN_TS, rawBody: GOLDEN_BODY, secret: GOLDEN_KEY })).toBe(GOLDEN_HEADER);
  });
  it("crmV2Headers: exactly the three headers, the path read off the requested URL (no query), the method upper-cased, ts in whole seconds", () => {
    const r = v2.crmV2Headers({
      url: "https://crm.example.test/api/internal/core-bid-created?ignored=1", rawBody: GOLDEN_BODY, secret: GOLDEN_KEY,
      signatureHeader: "x-rfp-request-signature", method: "post", now: new Date(GOLDEN_TS * 1000 + 999),
    });
    expect(r).toEqual({
      ok: true,
      headers: { "x-rfp-request-signature": GOLDEN_HEADER, "x-signature-version": "2", "x-signature-timestamp": "1767225600" },
    });
  });
});

describe("the first-use refusals", () => {
  it("the floor is 32 bytes; the URL must be https, http only to exactly localhost / 127.0.0.1", () => {
    expect(v2.crmSecretUsable("s".repeat(32))).toBe(true);
    expect(v2.crmSecretUsable("s".repeat(31))).toBe(false);
    expect(v2.crmSecretUsable("")).toBe(false);
    expect(v2.crmSecretUsable(undefined)).toBe(false);
    for (const ok of ["https://crm.example.test", "http://localhost:3001", "http://127.0.0.1:3001", "http://localhost/api/internal/x"]) {
      expect(v2.crmUrlAllowed(ok), ok).toBe(true);
    }
    for (const bad of ["http://crm.example.test", "http://localhost.example.test:3001", "http://127.0.0.2:3001", "ftp://crm.example.test", "not a url", ""]) {
      expect(v2.crmUrlAllowed(bad), bad).toBe(false);
    }
  });
  it("crmV2Headers refuses a short secret or a non-https URL (nothing to sign, nothing to send)", () => {
    expect(v2.crmV2Headers({ url: "https://crm.example.test/x", rawBody: "{}", secret: "s".repeat(31), signatureHeader: "x-rfp-request-signature" }))
      .toMatchObject({ ok: false, reason: "secret_short" });
    expect(v2.crmV2Headers({ url: "http://crm.example.test/x", rawBody: "{}", secret: GOLDEN_KEY, signatureHeader: "x-rfp-request-signature" }))
      .toMatchObject({ ok: false, reason: "url_refused" });
  });
  it("the refusal alert fires ONCE per signer + reason (crm_signing_refused), and again only after that signer signed", async () => {
    await v2.alertCrmSigningRefused("signer_a", { reason: "secret_short", detail: "synthetic" });
    await v2.alertCrmSigningRefused("signer_a", { reason: "secret_short", detail: "synthetic" });
    await v2.alertCrmSigningRefused("signer_b", { reason: "url_refused", detail: "synthetic" });
    expect(alertMock.mock.calls.map((c) => [c[0], c[1].signer, c[1].reason])).toEqual([
      ["crm_signing_refused", "signer_a", "secret_short"],
      ["crm_signing_refused", "signer_b", "url_refused"],
    ]);
    v2.clearCrmSigningRefusal("signer_a");
    await v2.alertCrmSigningRefused("signer_a", { reason: "secret_short", detail: "synthetic" });
    expect(alertMock).toHaveBeenCalledTimes(3);
  });
});
