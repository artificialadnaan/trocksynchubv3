import { describe, expect, it } from "vitest";

// safeMessage runs on the event loop. The raw input is cut to SAFE_MESSAGE_INPUT_MAX before any pass, and every pass is
// bounded (cleaner r3): a key run is at most 80 characters, the value scan is one pass. This lives in its own file because a
// regression here does not fail fast, it just doesn't return in any useful time, and would hold the other suites.

const { safeMessage } = await import("../server/health/snapshot-contract.ts");

describe("safeMessage on pathological inputs", () => {
  it("returns within a second on 200K characters of 'a-', and still cuts the credential at the head", () => {
    const raw = `password=val-head ${"a-".repeat(100_000)}`;
    const started = performance.now();
    const out = safeMessage(raw);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out ?? "").not.toContain("val-head");
  });

  // d9 on #139: the r2 key rule's nested segment loop went cubic on runs of a short credential word.
  it.each([
    ["pw- x667", "pw-".repeat(667)],
    ["password- x222", "password-".repeat(222)],
    ["keykey 100K", "key".repeat(33_334)],
    ["token: x400", "token:".repeat(400)],
    ["token: then 2000 [", `token:${"[".repeat(2000)}`],
    ["token: then an unclosed quote", `token:"${"a".repeat(5000)}`],
    ["password= then 100K backslashes", `password=${"\\".repeat(100_000)}`],
  ])("%s returns within a second, at most 200 characters", (_name, raw) => {
    const started = performance.now();
    const out = safeMessage(raw);
    expect(performance.now() - started).toBeLessThan(1000);
    expect((out ?? "").length).toBeLessThanOrEqual(200);
  });
});
