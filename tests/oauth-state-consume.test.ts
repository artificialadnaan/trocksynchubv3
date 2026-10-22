import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
// The shared store is the authority (see oauth-state-cross-replica.pglite.test.ts); here it is a real PGlite database.
const dbHolder = vi.hoisted(() => ({ pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get pool() {
    return dbHolder.pool;
  },
}));
beforeEach(() => {
  dbHolder.pool = new PGlite();
});

import { OAUTH_STATE_TTL_MS, consumeOAuthState, issueOAuthState } from "../server/lib/oauth-state.ts";

// Codex on #121: two callbacks for the same session can both load the same pending state before either response saves the session
// (the same authorization URL opened twice yields two provider codes). The one-shot property must not depend on the session write: a
// state value is also remembered as consumed in the process, atomically (a synchronous check-and-set), for as long as it could be valid.
describe("one-shot OAuth state under concurrent callbacks", () => {
  it("two callbacks that both loaded the SAME pending state: exactly one passes", async () => {
    const first: Record<string, any> = {};
    const state = issueOAuthState(first, "hubspot");
    const second = structuredClone(first); // the second request read the session before the first one's delete was saved
    expect(await consumeOAuthState(first, "hubspot", state)).toBe(true);
    expect(await consumeOAuthState(second, "hubspot", state)).toBe(false);
    expect(first.hubspotOAuthState).toBeUndefined();
  });

  it("a different state, a different provider, or a later authorization is unaffected", async () => {
    const s1: Record<string, any> = {};
    const a = issueOAuthState(s1, "microsoft");
    expect(await consumeOAuthState(s1, "microsoft", a)).toBe(true);
    const s2: Record<string, any> = {};
    const b = issueOAuthState(s2, "microsoft");
    expect(b).not.toBe(a);
    expect(await consumeOAuthState(s2, "microsoft", b)).toBe(true);
  });

  it("a wrong, missing or expired state still fails, and a consumed value is not accepted again after expiry either", async () => {
    const s: Record<string, any> = {};
    const st = issueOAuthState(s, "gmail");
    expect(await consumeOAuthState(s, "gmail", "nope")).toBe(false);
    expect(await consumeOAuthState(s, "gmail", st)).toBe(false); // consumed (even by the failed attempt)
    const t: Record<string, any> = {};
    const old = issueOAuthState(t, "gmail");
    expect(await consumeOAuthState(t, "gmail", old, Date.now() + OAUTH_STATE_TTL_MS + 1)).toBe(false);
  });

  it("an invalid callback and a valid one that loaded the SAME snapshot: the mismatch consumes the pending state, so the valid stale copy fails", async () => {
    const invalid: Record<string, any> = {};
    const state = issueOAuthState(invalid, "procore");
    const valid = structuredClone(invalid); // loaded the same session snapshot before the invalid request's delete was saved
    expect(await consumeOAuthState(invalid, "procore", "forged")).toBe(false);
    expect(await consumeOAuthState(valid, "procore", state)).toBe(false);
  });
});
