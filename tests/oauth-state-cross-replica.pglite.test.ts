import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Codex P2 on #121 (68's ruling): Railway deploys overlap old and new replicas, so the in-process `consumed` map is not enough. Two callbacks on
// different replicas each have their own process memory, both load the same session snapshot, both pass, and exchange separate provider codes.
// The one-shot consume must be decided by the SHARED database. Here two "replicas" are two fresh module instances (vi.resetModules + dynamic
// import: separate in-process state) over ONE PGlite database that stands in for the shared PostgreSQL.
//
// HONEST LIMIT: PGlite is a single connection, so Promise.all serializes the two statements; this does NOT exercise real concurrent
// transactions. What it proves is that the verdict comes from the shared store (a fresh process cannot consume what another consumed; a
// mismatch burns the state for the other replica; an unavailable store denies). The real cross-connection guarantee comes from the single
// atomic `INSERT ... ON CONFLICT DO NOTHING RETURNING` on a primary key, which Postgres resolves with a unique-index check.
const dbHolder = vi.hoisted(() => ({ pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get pool() {
    return dbHolder.pool;
  },
}));

let pg: PGlite;
beforeEach(() => {
  pg = new PGlite();
  dbHolder.pool = pg;
});

async function replica() {
  vi.resetModules();
  return await import("../server/lib/oauth-state.ts");
}

describe("one-shot OAuth state across replicas (shared store)", () => {
  it("two replicas race the SAME state from the same session snapshot: exactly one wins", async () => {
    const a = await replica();
    const b = await replica();
    const sessA: Record<string, any> = {};
    const state = a.issueOAuthState(sessA, "hubspot");
    const sessB = structuredClone(sessA);
    const results = await Promise.all([a.consumeOAuthState(sessA, "hubspot", state), b.consumeOAuthState(sessB, "hubspot", state)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a fresh process (restart) cannot consume a state another process consumed", async () => {
    const a = await replica();
    const sess: Record<string, any> = {};
    const state = a.issueOAuthState(sess, "procore");
    const stale = structuredClone(sess);
    expect(await a.consumeOAuthState(sess, "procore", state)).toBe(true);
    const fresh = await replica();
    expect(await fresh.consumeOAuthState(stale, "procore", state)).toBe(false);
  });

  it("a mismatching callback on one replica burns the state for a valid stale copy on the other", async () => {
    const a = await replica();
    const b = await replica();
    const sessA: Record<string, any> = {};
    const state = a.issueOAuthState(sessA, "gmail");
    const sessB = structuredClone(sessA);
    expect(await a.consumeOAuthState(sessA, "gmail", "forged")).toBe(false);
    expect(await b.consumeOAuthState(sessB, "gmail", state)).toBe(false);
  });

  it("a valid first callback passes, and an expired state fails", async () => {
    const a = await replica();
    const s1: Record<string, any> = {};
    expect(await a.consumeOAuthState(s1, "microsoft", a.issueOAuthState(s1, "microsoft"))).toBe(true);
    const s2: Record<string, any> = {};
    const old = a.issueOAuthState(s2, "microsoft");
    expect(await a.consumeOAuthState(s2, "microsoft", old, Date.now() + a.OAUTH_STATE_TTL_MS + 1)).toBe(false);
  });

  it("fails CLOSED when the shared store errors", async () => {
    const a = await replica();
    dbHolder.pool = { query: vi.fn().mockRejectedValue(new Error("connection terminated")) };
    const sess: Record<string, any> = {};
    const state = a.issueOAuthState(sess, "hubspot");
    expect(await a.consumeOAuthState(sess, "hubspot", state)).toBe(false);
  });

  it("recovers: a later valid state is accepted after the store was swapped/recreated or errored once (the table-ensure memo is not poisoned)", async () => {
    const a = await replica();
    const s1: Record<string, any> = {};
    expect(await a.consumeOAuthState(s1, "hubspot", a.issueOAuthState(s1, "hubspot"))).toBe(true);
    dbHolder.pool = new PGlite(); // a database without the table (fresh store); same process memory
    const s2: Record<string, any> = {};
    expect(await a.consumeOAuthState(s2, "hubspot", a.issueOAuthState(s2, "hubspot"))).toBe(true);
    dbHolder.pool = { query: vi.fn().mockRejectedValue(new Error("down")) };
    const s3: Record<string, any> = {};
    expect(await a.consumeOAuthState(s3, "hubspot", a.issueOAuthState(s3, "hubspot"))).toBe(false);
    dbHolder.pool = new PGlite();
    const s4: Record<string, any> = {};
    expect(await a.consumeOAuthState(s4, "hubspot", a.issueOAuthState(s4, "hubspot"))).toBe(true);
  });
});
