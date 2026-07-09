import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runSyncMappingsReconcile, defaultReconcilerDeps, type ReconcilerDeps } from "../server/sync-mappings-reconciler";
import type { ReconMappingRow } from "../shared/sync-mappings-reconcile";

function row(over: Partial<ReconMappingRow> & { id: number }): ReconMappingRow {
  return { sourceSystem: "hubspot", sourceDealId: null, procoreProjectId: null, portfolioProjectId: null, bidboardProjectId: null, procoreProjectNumber: null, ...over };
}

function fakeDeps(rows: ReconMappingRow[], cache: Set<string>) {
  const calls = { audit: [] as any[], review: [] as any[] };
  const deps: ReconcilerDeps = {
    loadRows: async () => rows,
    loadPortfolioCacheIds: async () => cache,
    writeAuditError: async (r) => { calls.audit.push(r); },
    upsertManualReview: async (e) => { calls.review.push(e); },
  };
  return { deps, calls };
}

describe("runSyncMappingsReconcile (alerting)", () => {
  const conflictRows = [
    row({ id: 1, sourceDealId: "D1", procoreProjectId: "X", procoreProjectNumber: "DFW-1" }),
    row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }), // different deal → conflict (error)
    row({ id: 3, sourceDealId: "D3", procoreProjectId: "Y" }),
    row({ id: 4, sourceDealId: "D3", portfolioProjectId: "Y" }), // same deal → redundant (info)
  ];

  it("dry-run reports issues but writes NOTHING", async () => {
    const { deps, calls } = fakeDeps(conflictRows, new Set(["X", "Y"]));
    const report = await runSyncMappingsReconcile(deps, { commit: false });
    expect(report.counts.cross_column_conflict).toBe(1);
    expect(report.counts.cross_column_redundant).toBe(1);
    expect(report.alertsWritten).toBe(0);
    expect(report.committed).toBe(false);
    expect(calls.audit).toHaveLength(0);
    expect(calls.review).toHaveLength(0);
  });

  it("commit writes ONE audit-error + ONE manual-review per ERROR issue; info issues never alert", async () => {
    const { deps, calls } = fakeDeps(conflictRows, new Set(["X", "Y"]));
    const report = await runSyncMappingsReconcile(deps, { commit: true });
    expect(report.alertsWritten).toBe(1); // only the different-deal conflict
    expect(calls.audit).toHaveLength(1);
    expect(calls.review).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({ action: "sync_mappings_integrity_cross_column_conflict", status: "error", source: "sync_mappings_reconciler" });
    expect(calls.review[0].projectNumber).toBe("DFW-1");
    // stable per-issue cycleId → the manual_review upsert de-dupes across runs
    expect(calls.review[0].cycleId).toBe("sync-integrity:cross_column_conflict:X");
  });

  it("orphaned portfolio alerts; clean table → no writes, committed false", async () => {
    const orphan = fakeDeps([row({ id: 9, sourceDealId: "D", portfolioProjectId: "GONE" })], new Set(["ELSE"]));
    const r1 = await runSyncMappingsReconcile(orphan.deps, { commit: true });
    expect(r1.counts.orphaned_portfolio).toBe(1);
    expect(orphan.calls.audit[0].action).toBe("sync_mappings_integrity_orphaned_portfolio");

    const clean = fakeDeps([row({ id: 1, sourceDealId: "D", portfolioProjectId: "HERE" })], new Set(["HERE"]));
    const r2 = await runSyncMappingsReconcile(clean.deps, { commit: true });
    expect(r2.committed).toBe(false);
    expect(clean.calls.audit).toHaveLength(0);
  });
});

describe("defaultReconcilerDeps (raw-SQL loads over the whole table, PGlite)", () => {
  it("loadRows maps all rows + loadPortfolioCacheIds reads the cache; detection runs end-to-end", async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE sync_mappings (
        id SERIAL PRIMARY KEY, source_system text, source_deal_id text,
        procore_project_id text, portfolio_project_id text, bidboard_project_id text, procore_project_number text
      );
      CREATE TABLE procore_projects (procore_id text);
      INSERT INTO sync_mappings (source_system, source_deal_id, procore_project_id, procore_project_number) VALUES ('hubspot','D1','X','DFW-1');
      INSERT INTO sync_mappings (source_system, source_deal_id, portfolio_project_id) VALUES ('hubspot','D2','X');
      INSERT INTO procore_projects (procore_id) VALUES ('X');
    `);
    const recorded = { audit: [] as any[], review: [] as any[] };
    const storage = {
      createAuditLog: async (r: any) => { recorded.audit.push(r); return r; },
      createManualReviewQueueEntry: async (d: any) => { recorded.review.push(d); return d; },
    };
    const report = await runSyncMappingsReconcile(defaultReconcilerDeps(pg as any, storage), { commit: true });
    expect(report.totalRows).toBe(2);
    expect(report.cacheSize).toBe(1);
    expect(report.counts.cross_column_conflict).toBe(1); // D1 vs D2 share id X across columns
    expect(recorded.audit).toHaveLength(1);
    expect(recorded.review).toHaveLength(1);
  });
});
