import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { recipientReviewUrl, signRecipientLink, verifyRecipientLink } from "../server/rfp-recipient-link.ts";

// #47: per-recipient RFP review links. The secret is a fixture, not a credential.
const SECRET = "test-session-secret-fixture";

describe("RFP recipient links", () => {
  it("a link verifies to its (normalized) recipient, for its own token only", () => {
    const r = signRecipientLink("tok-1", "  Approver@TRockGC.com ", SECRET);
    expect(verifyRecipientLink("tok-1", r, SECRET)).toBe("approver@trockgc.com");
    expect(verifyRecipientLink("tok-2", r, SECRET)).toBeNull();
  });

  it("refuses a missing, malformed, swapped-recipient or forged link", () => {
    const r = signRecipientLink("tok-1", "a@trockgc.com", SECRET);
    const [, mac] = r.split(".");
    const swapped = `${Buffer.from("b@trockgc.com").toString("base64url")}.${mac}`;
    for (const bad of [undefined, null, 42, "", "nodot", "a.b.c", ".abc", swapped, `${r}x`, "x".repeat(3000)]) {
      expect(verifyRecipientLink("tok-1", bad, SECRET), String(bad)).toBeNull();
    }
    expect(verifyRecipientLink("tok-1", signRecipientLink("tok-1", "a@trockgc.com", "other-secret"), SECRET)).toBeNull();
  });

  it("the key is HKDF-SHA256 over SESSION_SECRET with info rfp-review-v1 (a rotation invalidates every link)", () => {
    const key = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(SECRET), Buffer.alloc(0), "rfp-review-v1", 32));
    const expectedMac = crypto.createHmac("sha256", key).update("tok-1\na@trockgc.com").digest("base64url");
    expect(signRecipientLink("tok-1", "a@trockgc.com", SECRET).split(".")[1]).toBe(expectedMac);
    // Not a plain HMAC over the raw secret: the dedicated label separates this key from any other use of the secret.
    const plain = crypto.createHmac("sha256", SECRET).update("tok-1\na@trockgc.com").digest("base64url");
    expect(signRecipientLink("tok-1", "a@trockgc.com", SECRET).split(".")[1]).not.toBe(plain);
  });

  it("no secret: signing throws, verifying refuses (fail closed)", () => {
    expect(() => signRecipientLink("tok-1", "a@trockgc.com", "")).toThrow(/SESSION_SECRET/);
    const r = signRecipientLink("tok-1", "a@trockgc.com", SECRET);
    expect(verifyRecipientLink("tok-1", r, "")).toBeNull();
  });

  it("the URL is the base (trailing slash stripped) + /rfp-review/<token>?r=<signed>", () => {
    const url = recipientReviewUrl("https://hub.example.test/", "tok-1", "a@trockgc.com", SECRET);
    expect(url).toBe(`https://hub.example.test/rfp-review/tok-1?r=${signRecipientLink("tok-1", "a@trockgc.com", SECRET)}`);
  });
});
