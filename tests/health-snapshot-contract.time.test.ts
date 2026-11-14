import { describe, expect, it } from "vitest";

// safeMessage runs on the event loop. The raw input is cut to SAFE_MESSAGE_INPUT_MAX before any pass, and every pass is
// bounded (cleaner r3): a key run is at most 80 characters, the value scan is one pass. This lives in its own file because a
// regression here does not fail fast, it just doesn't return in any useful time, and would hold the other suites.

const { safeMessage, SAFE_MESSAGE_INPUT_MAX } = await import("../server/health/snapshot-contract.ts");

describe("safeMessage on pathological inputs", () => {
  it("returns within a second on 200K characters of 'a-', and still cuts the credential at the head", () => {
    const raw = `password=val-head ${"a-".repeat(100_000)}`;
    const started = performance.now();
    const out = safeMessage(raw);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out ?? "").not.toContain("val-head");
  });

  // d9 on #139: the r2 key rule's nested segment loop went cubic on runs of a short credential word. d9 round 3: every input
  // here is at most SAFE_MESSAGE_INPUT_MAX, so the cut leaves it whole and every pass (pairs, values, the r4 residue read) runs
  // on all of it; an input past the cut would be emptied first and prove nothing.
  it.each([
    ["pw- x500 (spaced)", "pw- ".repeat(500)],
    ["password- x222", "password-".repeat(222)],
    ["keykey x666", "key".repeat(666)],
    ["token: x333", "token:".repeat(333)],
    ["token: then 1994 [", `token:${"[".repeat(1994)}`],
    ["token: then an unclosed quote", `token:"${"a".repeat(1993)}`],
    ["password= then 1991 backslashes", `password=${"\\".repeat(1991)}`],
    ["a- x1000", "a-".repeat(1000)],
    ["scheme starts x333 (r4 residue read)", "a://b ".repeat(333)],
    ["one 2000-character key run (r4 residue read)", "a_".repeat(1000)],
  ])("%s returns within a second, at most 200 characters, and reaches every pass", (_name, raw) => {
    expect(raw.length).toBeLessThanOrEqual(SAFE_MESSAGE_INPUT_MAX);
    const started = performance.now();
    const out = safeMessage(raw);
    expect(performance.now() - started).toBeLessThan(1000);
    expect((out ?? "").length).toBeLessThanOrEqual(200);
  });
});
