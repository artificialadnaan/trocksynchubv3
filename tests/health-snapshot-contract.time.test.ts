import { describe, expect, it } from "vitest";

// safeMessage runs on the event loop, and its credential-key rule backtracks quadratically on long dash / underscore runs
// (d6: "a-a-…" 2K = 72 ms, 8K = 1.16 s). The raw input is cut to SAFE_MESSAGE_INPUT_MAX before any pass. This lives in its
// own file because without the cut the call below does not return in any useful time, and would hold the other suites.

const { safeMessage } = await import("../server/health/snapshot-contract.ts");

describe("safeMessage on a pathological input", () => {
  it("returns within a second on 200K characters of 'a-', and still cuts the credential at the head", () => {
    const raw = `password=val-head ${"a-".repeat(100_000)}`;
    const started = performance.now();
    const out = safeMessage(raw);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out ?? "").not.toContain("val-head");
  });
});
