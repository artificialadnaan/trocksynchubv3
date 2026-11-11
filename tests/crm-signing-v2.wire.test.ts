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
// CodeRabbit 4536816188 harness: the real alert path is stubbed below rfp-core-alert too, so even a mock miss reaches no database
// or mail client on the runner (the overlap cases also assert the real module logged nothing).
vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({ recordPushOutcomeAndMaybeAlert: vi.fn(async () => ({ action: "none" })), escapeHtml: (t: string) => t }));

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

// CodeRabbit 4536816188 on #130. The key is recorded only after a CONFIRMED delivery (4536104331), so two refusals for the same
// signer + reason that overlap must not both send while the first delivery is still pending; a pending delivery that fails must
// still leave the next refusal free to alert.
// Harness (a4 STOP-ACK s1cr-red-9229105): two CONCURRENT dynamic imports of a vi.mock'ed module resolved one of them to the real
// module, so the second refusal starts only once the first is inside the mocked delivery (its import done), and each case asserts
// the real module logged no ALERT line (a console spy, proven live by a control line), so a mock miss can never pass silently.
describe("CodeRabbit 4536816188 on #130: overlapping refusals while a delivery is pending", () => {
  const refusal = { reason: "secret_short" as const, detail: "synthetic" };

  /** A console spy proven live by a control line through the real log(); `lines()` = the real alert module's ALERT lines. */
  async function watchRealAlerts() {
    const spy = vi.spyOn(console, "log");
    const { log } = await import("../server/log.ts");
    log("spy control 4536816188", "harness");
    expect(spy.mock.calls.some((c) => String(c[0]).includes("spy control 4536816188"))).toBe(true);
    return { spy, lines: () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[rfp-core] ALERT")) };
  }

  it("two overlapping refusals for the same signer + reason raise ONE alert", async () => {
    const watch = await watchRealAlerts();
    try {
      let settle: (delivered: boolean) => void = () => {};
      alertMock.mockImplementationOnce(() => new Promise<any>((r) => { settle = r; }));
      const first = v2.alertCrmSigningRefused("signer_overlap", refusal);
      await vi.waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
      const second = v2.alertCrmSigningRefused("signer_overlap", refusal);
      settle(true);
      await Promise.all([first, second]);
      expect(watch.lines()).toEqual([]);
      expect(alertMock).toHaveBeenCalledTimes(1);
    } finally {
      watch.spy.mockRestore();
    }
  });

  it("(guard) a pending delivery that FAILS leaves the next refusal free to raise the alert again", async () => {
    const watch = await watchRealAlerts();
    try {
      let settle: (delivered: boolean) => void = () => {};
      alertMock.mockImplementationOnce(() => new Promise<any>((r) => { settle = r; }));
      const first = v2.alertCrmSigningRefused("signer_overlap_fail", refusal);
      await vi.waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
      const second = v2.alertCrmSigningRefused("signer_overlap_fail", refusal);
      settle(false);
      await Promise.all([first, second]);
      await v2.alertCrmSigningRefused("signer_overlap_fail", refusal);
      expect(watch.lines()).toEqual([]);
      expect(alertMock).toHaveBeenCalledTimes(2);
    } finally {
      watch.spy.mockRestore();
    }
  });
});
