import { describe, expect, it } from "vitest";
import { OAUTH_STATE_TTL_MS, consumeOAuthState, issueOAuthState } from "../server/lib/oauth-state.ts";

// Codex on #121: two callbacks for the same session can both load the same pending state before either response saves the session
// (the same authorization URL opened twice yields two provider codes). The one-shot property must not depend on the session write: a
// state value is also remembered as consumed in the process, atomically (a synchronous check-and-set), for as long as it could be valid.
describe("one-shot OAuth state under concurrent callbacks", () => {
  it("two callbacks that both loaded the SAME pending state: exactly one passes", () => {
    const first: Record<string, any> = {};
    const state = issueOAuthState(first, "hubspot");
    const second = structuredClone(first); // the second request read the session before the first one's delete was saved
    expect(consumeOAuthState(first, "hubspot", state)).toBe(true);
    expect(consumeOAuthState(second, "hubspot", state)).toBe(false);
    expect(first.hubspotOAuthState).toBeUndefined();
  });

  it("a different state, a different provider, or a later authorization is unaffected", () => {
    const s1: Record<string, any> = {};
    const a = issueOAuthState(s1, "microsoft");
    expect(consumeOAuthState(s1, "microsoft", a)).toBe(true);
    const s2: Record<string, any> = {};
    const b = issueOAuthState(s2, "microsoft");
    expect(b).not.toBe(a);
    expect(consumeOAuthState(s2, "microsoft", b)).toBe(true);
  });

  it("a wrong, missing or expired state still fails, and a consumed value is not accepted again after expiry either", () => {
    const s: Record<string, any> = {};
    const st = issueOAuthState(s, "gmail");
    expect(consumeOAuthState(s, "gmail", "nope")).toBe(false);
    expect(consumeOAuthState(s, "gmail", st)).toBe(false); // consumed (even by the failed attempt)
    const t: Record<string, any> = {};
    const old = issueOAuthState(t, "gmail");
    expect(consumeOAuthState(t, "gmail", old, Date.now() + OAUTH_STATE_TTL_MS + 1)).toBe(false);
  });

  it("an invalid callback and a valid one that loaded the SAME snapshot: the mismatch consumes the pending state, so the valid stale copy fails", () => {
    const invalid: Record<string, any> = {};
    const state = issueOAuthState(invalid, "procore");
    const valid = structuredClone(invalid); // loaded the same session snapshot before the invalid request's delete was saved
    expect(consumeOAuthState(invalid, "procore", "forged")).toBe(false);
    expect(consumeOAuthState(valid, "procore", state)).toBe(false);
  });
});
