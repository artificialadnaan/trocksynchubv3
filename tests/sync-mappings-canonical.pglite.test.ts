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
const { runSyncMappingsDedupe } = await import("../shared/sync-mappings-dedupe.ts");

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
const IDX_PROCORE = `CREATE UNIQUE INDEX idx_sync_mappings_procore_project_id ON sync_mappings(procore_project_id) WHERE procore_project_id IS NOT NULL AND btrim(procore_project_id) <> '';`;
const IDX_PORTFOLIO = `CREATE UNIQUE INDEX idx_sync_mappings_portfolio_project_id ON sync_mappings(portfolio_project_id) WHERE portfolio_project_id IS NOT NULL AND btrim(portfolio_project_id) <> '';`;

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
  const placeholders = keys.map((k, i) => (k === "metadata" ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await pg.query(
    `INSERT INTO sync_mappings (${keys.join(", ")}) VALUES (${placeholders.join(", ")})`,
    keys.map((k) => (k === "metadata" && cols[k] != null ? JSON.stringify(cols[k]) : cols[k])),
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

  describe("createSyncMapping (plain insert — ownership preserved)", () => {
    let pg: PGlite;
    beforeEach(async () => {
      pg = await freshDb();
    });

    it("a bidboard row with NULL procore_project_id still throws on the bidboard ownership index", async () => {
      await storage.createSyncMapping({ sourceDealId: "deal-a", bidboardProjectId: "BB-OWN" } as any);
      await expect(
        storage.createSyncMapping({ sourceDealId: "deal-b", bidboardProjectId: "BB-OWN" } as any),
      ).rejects.toThrow();
    });

    it("REJECTS a duplicate procore_project_id — /api/bidboard/link-deal ownership semantics preserved", async () => {
      // link-deal sets procoreProjectId = bidboardProjectId and relies on the insert THROWING (not silently
      // upserting the other deal's row).
      await storage.createSyncMapping({ sourceDealId: "deal-a", procoreProjectId: "PJ-OWN" } as any);
      await expect(
        storage.createSyncMapping({ sourceDealId: "deal-b", procoreProjectId: "PJ-OWN" } as any),
      ).rejects.toThrow();
    });
  });

  describe("upsertSyncMappingByProcoreProject (read-then-write)", () => {
    let pg: PGlite;
    beforeEach(async () => {
      pg = await freshDb();
    });

    it("re-sync fills a gap + refreshes telemetry, never clobbers lineage/metadata (additive)", async () => {
      await storage.upsertSyncMappingByProcoreProject({
        sourceDealId: "deal-1",
        procoreProjectId: "PJ-9",
        procoreProjectName: "Original Name",
        procoreProjectNumber: "DFW-9",
        bidboardProjectId: "BB-9",
        lastSyncStatus: "synced",
        metadata: { proposalId: "P1" },
      } as any);

      const result = await storage.upsertSyncMappingByProcoreProject({
        sourceDealId: "deal-1",
        procoreProjectId: "PJ-9",
        lastSyncStatus: "re-synced",
        metadata: { proposalId: "SHOULD-NOT-WIN" },
      } as any);

      expect(await count(pg)).toBe(1); // upsert, not a duplicate
      expect(result.lastSyncStatus).toBe("re-synced"); // telemetry refreshed (caller supplied it)
      expect(result.bidboardProjectId).toBe("BB-9"); // lineage preserved
      expect(result.procoreProjectName).toBe("Original Name"); // fill-only: a NULL didn't wipe it
      expect(result.procoreProjectNumber).toBe("DFW-9");
      expect(result.metadata).toEqual({ proposalId: "P1" }); // fill-only keeps the load-bearing proposalId
    });

    it("FILLS a supplied companyCamProjectId onto the existing row (link, not a silent no-op / dup)", async () => {
      await storage.createSyncMapping({ sourceDealId: "deal-1", procoreProjectId: "PJ-CC", procoreProjectName: "P" } as any);
      const result = await storage.upsertSyncMappingByProcoreProject(
        { sourceDealId: "deal-1", procoreProjectId: "PJ-CC", companyCamProjectId: "CC-77" } as any,
      );
      expect(await count(pg)).toBe(1);
      expect(result.companyCamProjectId).toBe("CC-77");
    });

    it("does NOT downgrade telemetry on a link-only upsert (no telemetry supplied)", async () => {
      await storage.createSyncMapping({
        sourceDealId: "deal-1", procoreProjectId: "PJ-T", lastSyncStatus: "synced", lastSyncAt: new Date("2026-05-01"),
      } as any);
      const result = await storage.upsertSyncMappingByProcoreProject(
        { sourceDealId: "deal-1", procoreProjectId: "PJ-T", companyCamProjectId: "CC-1" } as any,
      );
      expect(result.lastSyncStatus).toBe("synced"); // preserved, not wiped to NULL/pending
      expect(result.lastSyncAt).not.toBeNull();
    });

    it("collapses the cross-column case — an id already stamped as portfolio_project_id is linked, not duplicated", async () => {
      // A transitioned mapping carries the id in portfolio_project_id; a later CompanyCam match keys on it as procore.
      await storage.createSyncMapping({ sourceDealId: "deal-1", bidboardProjectId: "BB-1", portfolioProjectId: "PROJ-X" } as any);
      const result = await storage.upsertSyncMappingByProcoreProject(
        { sourceDealId: "deal-1", procoreProjectId: "PROJ-X", companyCamProjectId: "CC-9" } as any,
      );
      expect(await count(pg)).toBe(1); // no second row for the same project
      expect(result.portfolioProjectId).toBe("PROJ-X");
      expect(result.companyCamProjectId).toBe("CC-9");
    });

    it("migrates the source identity onto a junk-sourced existing row so it becomes reachable by the real deal", async () => {
      // Existing procore-only row whose source_deal_id is the junk self-reference (== procore id).
      await storage.createSyncMapping({ procoreProjectId: "PJ-M" } as any); // sourceDealId derives to "PJ-M"
      await storage.upsertSyncMappingByProcoreProject(
        { procoreProjectId: "PJ-M", hubspotDealId: "H-REAL" } as any, // sourceDealId derives to "H-REAL"
      );
      expect(await count(pg)).toBe(1);
      const found = await storage.getSyncMappingByHubspotDealId("H-REAL");
      expect(found?.procoreProjectId).toBe("PJ-M"); // now reachable via the real HubSpot deal
    });

    it("works with NO unique index yet (read-then-write) — finds + links the existing row, no dup", async () => {
      const pg2 = await freshDb({ withCanonicalIndexes: false });
      await storage.createSyncMapping({ sourceDealId: "deal-1", procoreProjectId: "PJ-1", procoreProjectName: "P" } as any);
      const result = await storage.upsertSyncMappingByProcoreProject(
        { sourceDealId: "deal-1", procoreProjectId: "PJ-1", companyCamProjectId: "CC-1" } as any,
      );
      expect(await count(pg2)).toBe(1);
      expect(result.companyCamProjectId).toBe("CC-1");
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

    it("getBidboardMappingByProcoreProjectNumber returns the freshest real-bidboard row, ignoring blank/portfolio-only rows", async () => {
      await seed(pg, { source_deal_id: "d1", procore_project_number: "DFW-7", portfolio_project_id: "PF-7" }); // no bidboard
      await seed(pg, { source_deal_id: "d2", procore_project_number: "DFW-7", bidboard_project_id: "  " }); // blank → excluded
      await seed(pg, { source_deal_id: "d3", procore_project_number: "DFW-7", bidboard_project_id: "BB-OLD", last_sync_at: "2026-01-01" });
      await seed(pg, { source_deal_id: "d4", procore_project_number: "DFW-7", bidboard_project_id: "BB-NEW", last_sync_at: "2026-05-01" });

      const row = await storage.getBidboardMappingByProcoreProjectNumber("DFW-7");
      expect(row?.bidboardProjectId).toBe("BB-NEW");
    });
  });

  describe("runSyncMappingsDedupe end-to-end", () => {
    it("collapses a procore_project_id cluster to one survivor and merges non-null fields", async () => {
      const pg = await freshDb({ withCanonicalIndexes: false });
      // A 3-row junk cluster sharing PJ-DUP (mirrors the prod shape: no bidboard/portfolio).
      await seed(pg, { source_deal_id: "PJ-DUP", procore_project_id: "PJ-DUP", procore_project_name: null, procore_project_number: "DFW-DUP" });
      await seed(pg, { source_deal_id: "PJ-DUP", procore_project_id: "PJ-DUP", procore_project_name: "Real Name", procore_project_number: null, metadata: { proposalId: "PX" } });
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
      expect(survivor.metadata).toEqual({ proposalId: "PX" }); // jsonb sibling metadata merged via the ::jsonb UPDATE path

      // Now that dupes are gone, the unique index can be created — proving the migration ordering.
      await expect(pg.exec(IDX_PROCORE)).resolves.toBeTruthy();

      // Idempotent: a second run finds nothing.
      const again = await runSyncMappingsDedupe(pg, { commit: true });
      expect(again.clusters).toBe(0);
      expect(again.committed).toBe(false);
    });
  });
});
