import { existsSync, readFileSync } from "fs";
import { dirname, join, normalize } from "path";
import { describe, expect, it } from "vitest";

// Codex 4534051215 on #127 (and P1 4530978794 on #128): the operator CLIs must never load server/index.ts, which binds the port and runs startup
// migrations on import. This walks each CLI's RUNTIME import graph from the source: static imports / re-exports, bare imports
// and dynamic import("…"); `import type` / `export type` and all-type specifier lists are erased at runtime, so they are not edges.
// No CLI is spawned: before the fix that would boot the app against the test database.
const ROOT = process.cwd();

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else if (spec.startsWith("@shared/")) base = join("shared", spec.slice("@shared/".length));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(ROOT, candidate))) return candidate;
  }
  return null;
}

function runtimeImports(file: string): string[] {
  const src = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const specs: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s*["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    const clause = m[3].trim();
    if (clause.startsWith("{") && clause.endsWith("}")) {
      const names = clause.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    specs.push(m[4]);
  }
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs.map((s) => resolveSpecifier(file, s)).filter((r): r is string => r !== null);
}

/** The chain root -> … -> target through runtime imports, or [] when target is unreachable. */
function chainTo(root: string, target: string): string[] {
  const parent = new Map<string, string | null>([[root, null]]);
  const queue = [root];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file === target) {
      const chain: string[] = [];
      for (let at: string | null = file; at !== null; at = parent.get(at) ?? null) chain.unshift(at);
      return chain;
    }
    for (const next of runtimeImports(file)) {
      if (!parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return [];
}

describe("the operator CLIs never load the server entry point (Codex P1 on #128)", () => {
  it("positive control: the walker finds server/index.ts from a module that still imports it", () => {
    expect(chainTo("server/sync/bidboard-core-ingestion.ts", "server/index.ts")).toEqual(["server/sync/bidboard-core-ingestion.ts", "server/index.ts"]);
  });
  // The union of #128's two CLIs and #127's resolver CLI (A3 carry): #128's describe title is kept so its frozen names hold.
  for (const cli of ["scripts/rfp-requeue-dead.ts", "scripts/rfp-redrive-to-core.ts", "scripts/rfp-resolve-approving.ts"]) {
    it(`${cli}: server/index.ts is not in its runtime import graph`, () => {
      expect(existsSync(join(ROOT, cli))).toBe(true);
      expect(chainTo(cli, "server/index.ts")).toEqual([]);
    });
  }
});
