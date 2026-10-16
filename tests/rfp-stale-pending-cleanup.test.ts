import { mkdtempSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { parseOlderThanDays, rfpDisplayName } from "../server/pendingRfpOpen";
import { writeRfpCleanupSnapshot } from "../server/rfpCleanupSnapshot";

const ROOT = resolve(__dirname, "..");

// Static relative-import closure of a module (plus the @shared alias). Deterministic: no module is executed.
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(ROOT, entry)];
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      let base: string | null = null;
      if (spec.startsWith(".")) base = resolve(dirname(file), spec);
      else if (spec.startsWith("@shared/")) base = resolve(ROOT, "shared", spec.slice("@shared/".length));
      if (!base) continue;
      const hit = candidates(base).find((c) => { try { return statSync(c).isFile(); } catch { return false; } });
      if (hit) stack.push(hit);
    }
  }
  return seen;
}

describe("the stale-pending cleanup script never boots the SyncHub server (Codex P1 on #114)", () => {
  it("server/index.ts (Express, schedulers, workers) is not in the script's import closure", () => {
    const closure = importClosure("scripts/rfp-stale-pending-cleanup.ts");
    expect(closure.has(resolve(ROOT, "server/index.ts"))).toBe(false);
  });
});

describe("parseOlderThanDays: the script validates the window exactly like the scheduler (Codex P2 on #114)", () => {
  it.each([
    [undefined, 30], ["45", 45], ["0", 30], ["-5", 30], ["Infinity", 30], ["abc", 30], ["", 30],
  ])("%s -> %s", (raw, expected) => {
    expect(parseOlderThanDays(raw)).toBe(expected);
  });
});

describe("rfpDisplayName: a blank edited name falls back to the original (Codex P2 on #114)", () => {
  it("whitespace-only edited dealname -> the source deal name", () => {
    expect(rfpDisplayName({ editedFields: { dealname: "   " }, dealData: { dealname: "Walton Roof" } })).toBe("Walton Roof");
  });
  it("blank everywhere -> the dash", () => {
    expect(rfpDisplayName({ editedFields: { dealname: "" }, dealData: { project_name: " " } })).toBe("—");
  });
  it("a real edited name still wins", () => {
    expect(rfpDisplayName({ editedFields: { dealname: "Edited" }, dealData: { dealname: "Original" } })).toBe("Edited");
  });
});

describe("writeRfpCleanupSnapshot: owner-only, never overwrites (Codex P2 on #114)", () => {
  it("writes mode 0600 under a random name", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfp-snap-"));
    const a = writeRfpCleanupSnapshot(dir, [{ id: 1 }]);
    const b = writeRfpCleanupSnapshot(dir, [{ id: 2 }]);
    expect(a).not.toBe(b);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(a, "utf8"))).toEqual([{ id: 1 }]);
    expect(readdirSync(dir)).toHaveLength(2);
  });
  it("refuses a path that already exists (exclusive create)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rfp-snap-"));
    writeRfpCleanupSnapshot(dir, [], () => "fixed");
    expect(() => writeRfpCleanupSnapshot(dir, [], () => "fixed")).toThrow(/EEXIST/);
  });
});

describe("the cleanup apply re-checks for an approval attempt INSIDE its transaction (Codex round 4 on #114)", () => {
  it("apply() reads rfp_approval_attempt audit rows and consults rfpCleanupBlock before the update", () => {
    const src = readFileSync(resolve(ROOT, "scripts/rfp-stale-pending-cleanup.ts"), "utf8");
    const helper = src.slice(src.indexOf("async function approvalAttempts"), src.indexOf("async function preview"));
    expect(helper).toContain('"rfp_approval_attempt"');
    const tx = src.slice(src.indexOf("db.transaction"));
    const attempts = tx.indexOf("approvalAttempts(tx,");
    const block = tx.indexOf("rfpCleanupBlock(");
    const update = tx.indexOf(".update(rfpApprovalRequests)");
    expect(attempts).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(update);
    expect(attempts).toBeLessThan(update);
  });
});
