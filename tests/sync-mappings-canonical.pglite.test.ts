import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// db.ts is swapped for a per-test PGlite instance (real Postgres in WASM) so the storage methods run
// their ACTUAL SQL — partial unique indexes, ON CONFLICT, ORDER BY — not string mocks.
const dbHolder = vi.hoisted(() => ({ db: null as any, pool: null as any }));
vi.mock("../server/db.ts", () => ({
  get db() {
    return dbHolder.db;
  },
  get pool() {
    return dbHolder.pool;
  },
}));

const { storage } = await import("../server/storage.ts");
const { runSyncMappingsDedupe } = await import("../server/sync-mappings-dedupe.ts");

const DDL = `
  CREATE TABLE sync_mappings (
    id SERIAL PRIMARY KEY,
    source_system text NOT NULL DEFAULT 'hubspot',
    source_deal_id text NOT NULL,
    hubspot_deal_id text,
    hubspot_company_id text,
    procore_project_id text,
    procore_company_id text,
    companycam_project_id text,
    hubspot_deal_name text,
    procore_project_name text,
    procore_project_number text,
    bidboard_project_id text,
    bidboard_project_name text,
    portfolio_project_id text,
    portfolio_project_name text,
    project_phase text DEFAULT 'bidboard',
    sent_to_portfolio_at timestamp,
    last_sync_at timestamp,
    last_sync_status text DEFAULT 'pending',
    last_sync_direction text,
    metadata jsonb,
    created_at timestamp DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_sync_mappings_bidboard_project_id ON sync_mappings(bidboard_project_id) WHERE bidboard_project_id IS NOT NULL;
`;
const IDX_PROCORE = `CREATE UNIQUE INDEX idx_sync_mappings_procore_project_id ON sync_mappings(procore_project_id) WHERE procore_project_id IS NOT NULL;`;
const IDX_PORTFOLIO = `CREATE UNIQUE INDEX idx_sync_mappings_portfolio_project_id ON sync_mappings(portfolio_project_id) WHERE portfolio_project_id IS NOT NULL;`;

async function freshDb(opts: { withCanonicalIndexes?: boolean } = {}) {
  const pg = new PGlite();
  await pg.exec(DDL);
  if (opts.withCanonicalIndexes !== false) {
    await pg.exec(IDX_PROCORE);
    await pg.exec(IDX_PORTFOLIO);
  }
  dbHolder.pool = pg;
  dbHolder.db = drizzle(pg);
  return pg;
}

async function seed(pg: PGlite, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  await pg.query(
    `INSERT INTO sync_mappings (${keys.join(", ")}) VALUES (${placeholders.join(", ")})`,
    keys.map((k) => cols[k]),
  );
}
const count = async (pg: PGlite, where = "TRUE") =>
  Number(((await pg.query(`SELECT count(*)::int AS n FROM sync_mappings WHERE ${where}`)).rows[0] as any).n);

describe("sync_mappings canonical invariants (PGlite)", () => {
  describe("partial unique indexes", () => {
    let pg: PGlite;
    beforeEach(async () => {
      pg = await freshDb();
    });

    it("rejects a 2nd row with the same non-null procore_project_id", async () => {
      await seed(pg, { source_deal_id: "d1", procore_project_id: "PJ-1" });
      await expect(seed(pg, { source_deal_id: "d2", procore_project_id: "PJ-1" })).rejects.toThrow();
    });

    it("rejects a 2nd row with the same non-null portfolio_project_id", async () => {
      await seed(pg, { source_deal_id: "d1", portfolio_project_id: "PF-1" });
      await expect(seed(pg, { source_deal_id: "d2", portfolio_project_id: "PF-1" })).rejects.toThrow();
    });

    it("allows many rows with a NULL procore_project_id (bidboard-only rows are unconstrained)", async () => {
      await seed(pg, { source_deal_id: "d1", bidboard_project_id: "BB-1" });
      await seed(pg, { source_deal_id: "d2", bidboard_project_id: "BB-2" });
      await seed(pg, { source_deal_id: "d3" });
      expect(await count(pg, "procore_project_id IS NULL")).toBe(3);
    });
  });

  describe("createSyncMapping upsert", () => {
    let pg: PGlite;
    beforeEach(async () => {
      pg = await freshDb();
    });

    it("re-syncing the same procore project UPDATES in place — refreshes sync fields, never clobbers lineage", async () => {
      await storage.createSyncMapping({
        sourceDealId: "deal-1",
        procoreProjectId: "PJ-9",
        procoreProjectName: "Original Name",
        procoreProjectNumber: "DFW-9",
        bidboardProjectId: "BB-9",
        lastSyncStatus: "synced",
      } as any);

      // A second sync arrives with a fresher status but a NULL name/number and NO bidboard id.
      const result = await storage.createSyncMapping({
        sourceDealId: "deal-1",
        procoreProjectId: "PJ-9",
        lastSyncStatus: "re-synced",
      } as any);

      expect(await count(pg)).toBe(1); // upsert, not a duplicate
      expect(result.lastSyncStatus).toBe("re-synced"); // telemetry refreshed
      expect(result.bidboardProjectId).toBe("BB-9"); // lineage preserved
      expect(result.procoreProjectName).toBe("Original Name"); // COALESCE: NULL didn't wipe it
      expect(result.procoreProjectNumber).toBe("DFW-9");
    });

    it("a bidboard row with NULL procore_project_id still throws on the bidboard ownership index (guard preserved)", async () => {
      await storage.createSyncMapping({ sourceDealId: "deal-a", bidboardProjectId: "BB-OWN" } as any);
      // Same bidboard id, different deal, no procore id → outside the procore ON CONFLICT arbiter →
      // must still collide on the bidboard unique index.
      await expect(
        storage.createSyncMapping({ sourceDealId: "deal-b", bidboardProjectId: "BB-OWN" } as any),
      ).rejects.toThrow();
    });
  });

  describe("42P10 fallback when the arbiter index does not exist yet", () => {
    it("createSyncMapping falls back to a plain insert (PR is safe to merge before db:push)", async () => {
      const pg = await freshDb({ withCanonicalIndexes: false });
      await storage.createSyncMapping({ sourceDealId: "deal-1", procoreProjectId: "PJ-1", lastSyncStatus: "a" } as any);
      // No procore unique index → ON CONFLICT raises 42P10 → fallback inserts a second row instead of throwing.
      await expect(
        storage.createSyncMapping({ sourceDealId: "deal-2", procoreProjectId: "PJ-1", lastSyncStatus: "b" } as any),
      ).resolves.toBeTruthy();
      expect(await count(pg)).toBe(2);
    });
  });

  describe("deterministic getters over duplicate rows (pre-dedup window)", () => {
    let pg: PGlite;
    beforeEach(async () => {
      // No canonical indexes so we can seed the duplicate rows the getters must resolve deterministically.
      pg = await freshDb({ withCanonicalIndexes: false });
    });

    it("getSyncMappingByProcoreProjectId prefers the portfolio-bearing row", async () => {
      await seed(pg, { source_deal_id: "d", procore_project_id: "PJ-1", last_sync_at: "2026-01-01" });
      await seed(pg, { source_deal_id: "d", procore_project_id: "PJ-1", bidboard_project_id: "BB-1", last_sync_at: "2026-02-01" });
      await seed(pg, { source_deal_id: "d", procore_project_id: "PJ-1", portfolio_project_id: "PF-1", last_sync_at: "2025-01-01" });

      const row = await storage.getSyncMappingByProcoreProjectId("PJ-1");
      expect(row?.portfolioProjectId).toBe("PF-1"); // portfolio beats bidboard beats plain, even though it's the oldest sync
    });

    it("getSyncMappingByProcoreProjectNumber returns a lineage-bearing row for a shared number", async () => {
      await seed(pg, { source_deal_id: "d1", procore_project_number: "DFW-5", procore_project_id: "PJ-A" });
      await seed(pg, { source_deal_id: "d2", procore_project_number: "DFW-5", bidboard_project_id: "BB-5" });

      const row = await storage.getSyncMappingByProcoreProjectNumber("DFW-5");
      expect(row?.bidboardProjectId).toBe("BB-5");
    });

    it("getSyncMappingBySourceDealId is deterministic (lineage/freshest) across a deal's rows", async () => {
      await seed(pg, { source_deal_id: "deal-x", procore_project_id: "PJ-1", last_sync_at: "2026-01-01" });
      await seed(pg, { source_deal_id: "deal-x", bidboard_project_id: "BB-1", last_sync_at: "2026-03-01" });

      const row = await storage.getSyncMappingBySourceDealId("hubspot", "deal-x");
      expect(row?.bidboardProjectId).toBe("BB-1");
    });
  });

  describe("runSyncMappingsDedupe end-to-end", () => {
    it("collapses a procore_project_id cluster to one survivor and merges non-null fields", async () => {
      const pg = await freshDb({ withCanonicalIndexes: false });
      // A 3-row junk cluster sharing PJ-DUP (mirrors the prod shape: no bidboard/portfolio).
      await seed(pg, { source_deal_id: "PJ-DUP", procore_project_id: "PJ-DUP", procore_project_name: null, procore_project_number: "DFW-DUP" });
      await seed(pg, { source_deal_id: "PJ-DUP", procore_project_id: "PJ-DUP", procore_project_name: "Real Name", procore_project_number: null });
      await seed(pg, { source_deal_id: "PJ-DUP", procore_project_id: "PJ-DUP", procore_project_name: null, procore_project_number: null });
      // An untouched control row on a different project.
      await seed(pg, { source_deal_id: "other", procore_project_id: "PJ-OK" });

      const report = await runSyncMappingsDedupe(pg, { commit: true });
      expect(report.committed).toBe(true);
      expect(report.rowsToDelete).toBe(2);
      expect(await count(pg, "procore_project_id = 'PJ-DUP'")).toBe(1);
      expect(await count(pg, "procore_project_id = 'PJ-OK'")).toBe(1);

      const survivor = (await pg.query(`SELECT * FROM sync_mappings WHERE procore_project_id = 'PJ-DUP'`)).rows[0] as any;
      expect(survivor.procore_project_name).toBe("Real Name"); // merged from the deleted sibling
      expect(survivor.procore_project_number).toBe("DFW-DUP"); // survivor's own value kept

      // Now that dupes are gone, the unique index can be created — proving the migration ordering.
      await expect(pg.exec(IDX_PROCORE)).resolves.toBeTruthy();

      // Idempotent: a second run finds nothing.
      const again = await runSyncMappingsDedupe(pg, { commit: true });
      expect(again.clusters).toBe(0);
      expect(again.committed).toBe(false);
    });
  });
});
