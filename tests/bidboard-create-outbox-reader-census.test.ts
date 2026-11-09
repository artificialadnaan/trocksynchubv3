import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// CONTRACT v2.2 §2 (E-8, a4 condition): EVERY reader of bidboard_create_outbox must ignore `routed_core`, so a core-stamped
// command is never read as an unprocessed row. The rule this census enforces:
//   - a POSITIVE status predicate (`status = 'x'`, `status IN ('x','y')`) can only match routed_core if it names it ⇒ safe unless named;
//   - a NEGATIVE predicate (`<>`, `!=`, `NOT IN`) DOES match routed_core ⇒ each one must be classified below, by exact text;
//   - a positive predicate that NAMES routed_core must be classified too.
// It scans every non-test source file that references the table, and pins that set of files, so a NEW reader fails here.
const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["server", "shared", "client", "scripts", "script"];
const TABLE_RE = /bidboard_create_outbox|bidboardCreateOutbox/;

/** Files allowed to reference the table (paths relative to the repo root). A new one must be classified here first. */
const READER_FILES = ["scripts/migrate-multi-source-rfp.ts", "server/sync/bidboard-create-worker.ts", "shared/schema.ts"];

/** Negative / routed_core-naming status predicates, by exact trimmed line, with WHY routed_core is handled. */
const CLASSIFIED: Record<string, string> = {
  "AND nb.status <> 'superseded'":
    "re-queue sibling guard: a NEWER routed_core row for the deal is a live round ⇒ an older failed Procore round is NOT re-queued (desired; the footprint rule then holds it)",
  "AND nb.status NOT IN ('superseded', 'failed')":
    "done-branch sibling guard: same as above, routed_core counted as a live newer round by design",
};

function walk(dir: string): string[] {
  let out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    if (n === "node_modules" || n === "dist") continue;
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const readers = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => TABLE_RE.test(readFileSync(f, "utf8")))
  .map((f) => relative(ROOT, f).split("\\").join("/"))
  .sort();

const NEGATIVE_RE = /\bstatus\s*(<>|!=|NOT\s+IN)\b/i;
const NAMES_ROUTED_CORE_RE = /\bstatus\b[^;\n]*'routed_core'/i;

describe("bidboard_create_outbox reader census (E-8)", () => {
  it("the set of files that reference the table is exactly the classified set", () => {
    expect(readers).toEqual(READER_FILES);
  });
  it("every negative / routed_core-naming status predicate in those files is classified, and no classification is stale", () => {
    const found: string[] = [];
    for (const f of readers) {
      for (const raw of readFileSync(join(ROOT, f), "utf8").split("\n")) {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("--")) continue;
        if (NEGATIVE_RE.test(line) || NAMES_ROUTED_CORE_RE.test(line)) found.push(line);
      }
    }
    const unclassified = found.filter((l) => !(l in CLASSIFIED));
    expect(unclassified, "classify each new predicate in CLASSIFIED").toEqual([]);
    expect(Object.keys(CLASSIFIED).filter((k) => !found.includes(k)), "stale CLASSIFIED entries").toEqual([]);
  });
  it("the Procore worker's claim filters destination = 'procore'", () => {
    const src = readFileSync(join(ROOT, "server/sync/bidboard-create-worker.ts"), "utf8");
    const claim = src.slice(src.indexOf("export async function claimNextBidboardCreateCommand"));
    const body = claim.slice(0, claim.indexOf("\n}\n"));
    expect(body).toMatch(/AND destination = 'procore'/);
  });
});

// Behaviour: the REAL claim against Postgres never takes a core-stamped row, whatever its status.
const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ get db() { return dbHolder.db; }, get pool() { return undefined; } }));
vi.mock("../server/playwright/bidboard.ts", () => ({ createBidBoardProjectFromDeal: vi.fn() }));
vi.mock("../server/rfp-approval.ts", () => ({ checkRfpApprovalSourceEligibility: vi.fn(), buildSourceDealUrl: vi.fn(), normalizedDealData: vi.fn() }));
vi.mock("../server/sync/bidboard-callback-worker.ts", () => ({ buildBidBoardCreatedCallbackTargetUrl: () => "https://crm.example.test/x" }));
vi.mock("../server/storage.ts", () => ({ storage: {} }));

describe("claimNextBidboardCreateCommand never claims a core-stamped row", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`CREATE TABLE bidboard_callback_outbox (id serial PRIMARY KEY, rfp_approval_request_id integer NOT NULL)`);
    await pg.exec(readFileSync(new URL("../migrations/0023_create_bidboard_create_outbox.sql", import.meta.url), "utf8"));
    await pg.exec(readFileSync(new URL("../migrations/0027_rfp_core_routing.sql", import.meta.url), "utf8"));
    dbHolder.db = drizzle(pg);
  }, 30000);
  afterAll(async () => { await pg?.close?.(); });
  it("routed_core, and even a core row left in pending, are never claimed; a procore pending row is", async () => {
    const { claimNextBidboardCreateCommand } = await import("../server/sync/bidboard-create-worker.ts");
    await pg.exec(`
      INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, payload, status, destination)
      VALUES ('trock_crm', 'd-core-1', 'k-core-1', '{}'::jsonb, 'routed_core', 'core'),
             ('trock_crm', 'd-core-2', 'k-core-2', '{}'::jsonb, 'pending', 'core');
    `);
    expect(await claimNextBidboardCreateCommand()).toBeNull();
    await pg.exec(`INSERT INTO bidboard_create_outbox (source_system, source_deal_id, source_event_id, payload, status) VALUES ('trock_crm', 'd-p', 'k-p', '{}'::jsonb, 'pending')`);
    const claimed = await claimNextBidboardCreateCommand();
    expect(claimed?.source_event_id).toBe("k-p");
  });
});
