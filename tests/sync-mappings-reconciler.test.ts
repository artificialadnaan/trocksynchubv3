import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { runSyncMappingsReconcile, defaultReconcilerDeps, type ReconcilerDeps } from "../server/sync-mappings-reconciler";
import type { ReconMappingRow } from "../shared/sync-mappings-reconcile";

function row(over: Partial<ReconMappingRow> & { id: number }): ReconMappingRow {
  return { sourceSystem: "hubspot", sourceDealId: null, procoreProjectId: null, portfolioProjectId: null, bidboardProjectId: null, procoreProjectNumber: null, ...over };
}

function fakeDeps(
  rows: ReconMappingRow[],
  cache: Set<string>,
  opts: { failAuditOnce?: boolean; cacheThrows?: boolean } = {},
) {
  const calls = { audit: [] as any[], review: [] as any[] };
  let failed = false;
  const deps: ReconcilerDeps = {
    loadRows: async () => rows,
    loadPortfolioCacheIds: async () => {
      if (opts.cacheThrows) throw new Error("procore_projects cache down");
      return cache;
    },
    writeAuditError: async (r) => {
      if (opts.failAuditOnce && !failed) { failed = true; throw new Error("transient audit write failure"); }
      calls.audit.push(r);
    },
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
    // cycleId is stable per-issue (id + row pair) → de-dupes across runs, never collapses distinct pairs
    expect(calls.review[0].cycleId).toBe("sync-integrity:cross_column_conflict:X:1-2");
  });

  it("distinct conflicts sharing one Procore id get DISTINCT cycleIds (no manual_review collapse)", async () => {
    // id X is procore on row 1 and portfolio on TWO different-deal rows 2 and 3 → two conflicts.
    const rows = [
      row({ id: 1, sourceDealId: "D1", procoreProjectId: "X", procoreProjectNumber: "DFW-1" }),
      row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }),
      row({ id: 3, sourceDealId: "D3", portfolioProjectId: "X" }),
    ];
    const { deps, calls } = fakeDeps(rows, new Set(["X"]));
    await runSyncMappingsReconcile(deps, { commit: true });
    expect(calls.review).toHaveLength(2);
    expect(new Set(calls.review.map((r) => r.cycleId)).size).toBe(2); // distinct → both survive the upsert
  });

  it("a cache-load failure still runs the cross-column checks (only orphan checks skipped)", async () => {
    const rows = [
      row({ id: 1, sourceDealId: "D1", procoreProjectId: "X" }),
      row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }), // conflict — needs no cache
    ];
    const { deps, calls } = fakeDeps(rows, new Set(["X"]), { cacheThrows: true });
    const report = await runSyncMappingsReconcile(deps, { commit: true });
    expect(report.cacheSize).toBe(0); // fell back to empty set
    expect(report.counts.cross_column_conflict).toBe(1); // still detected + alerted
    expect(calls.audit).toHaveLength(1);
  });

  it("a single failing write does not abort the scan — later issues still recorded, failedWrites counted", async () => {
    const rows = [
      row({ id: 1, sourceDealId: "D1", procoreProjectId: "X" }),
      row({ id: 2, sourceDealId: "D2", portfolioProjectId: "X" }),
      row({ id: 3, sourceDealId: "D3", procoreProjectId: "Y" }),
      row({ id: 4, sourceDealId: "D4", portfolioProjectId: "Y" }),
    ];
    const { deps, calls } = fakeDeps(rows, new Set(["X", "Y"]), { failAuditOnce: true });
    const report = await runSyncMappingsReconcile(deps, { commit: true });
    expect(report.failedWrites).toBe(1); // the first issue's audit write threw
    expect(calls.audit.length).toBe(1); // the second issue still got its audit write
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

  it("re-run against REAL tables: manual_review de-dupes to ONE row (upsert); audit re-alerts each run (persistent drift)", async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE sync_mappings (id SERIAL PRIMARY KEY, source_system text, source_deal_id text, procore_project_id text, portfolio_project_id text, bidboard_project_id text, procore_project_number text);
      CREATE TABLE procore_projects (procore_id text);
      CREATE TABLE manual_review_queue (id SERIAL PRIMARY KEY, project_number text NOT NULL, project_name text NOT NULL, current_stage text NOT NULL, cycle_id text NOT NULL, reason text NOT NULL, details jsonb, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), resolved_at timestamp, UNIQUE(project_number, cycle_id));
      CREATE TABLE audit_logs (id SERIAL PRIMARY KEY, action text, status text, details jsonb, created_at timestamp DEFAULT now());
      INSERT INTO sync_mappings (source_system, source_deal_id, procore_project_id, procore_project_number) VALUES ('hubspot','D1','X','DFW-1');
      INSERT INTO sync_mappings (source_system, source_deal_id, portfolio_project_id) VALUES ('hubspot','D2','X');
      INSERT INTO procore_projects (procore_id) VALUES ('X');
    `);
    // Storage backed by the real upsert semantics (onConflict (project_number, cycle_id) DO UPDATE WHERE resolved_at IS NULL).
    const storage = {
      createAuditLog: async (r: any) => { await pg.query(`INSERT INTO audit_logs (action, status, details) VALUES ($1,$2,$3)`, [r.action, r.status, JSON.stringify(r.details)]); return r; },
      createManualReviewQueueEntry: async (d: any) => {
        await pg.query(
          `INSERT INTO manual_review_queue (project_number, project_name, current_stage, cycle_id, reason, details)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (project_number, cycle_id) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now() WHERE manual_review_queue.resolved_at IS NULL`,
          [d.projectNumber, d.projectName, d.currentStage, d.cycleId, d.reason, JSON.stringify(d.details)],
        );
        return d;
      },
    };
    const deps = defaultReconcilerDeps(pg as any, storage);
    await runSyncMappingsReconcile(deps, { commit: true });
    await runSyncMappingsReconcile(deps, { commit: true }); // second run
    const reviewCount = Number(((await pg.query(`SELECT count(*)::int AS n FROM manual_review_queue`)).rows[0] as any).n);
    const auditCount = Number(((await pg.query(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0] as any).n);
    expect(reviewCount).toBe(1); // upsert on (project_number, cycle_id) → single triage row across both runs
    expect(auditCount).toBe(2); // persistent unresolved drift intentionally re-alerts each run
  });
});
