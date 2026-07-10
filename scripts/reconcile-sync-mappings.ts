#!/usr/bin/env -S npx tsx
/**
 * sync_mappings integrity reconciler (#3) — DRY-RUN report CLI (read-only).
 * Loads the whole sync_mappings table + procore_projects cache and prints the integrity findings.
 * Alerting (writes to audit_logs + manual_review_queue) happens via the cron / API route, not here.
 *   DATABASE_URL=... npx tsx scripts/reconcile-sync-mappings.ts
 */
import pg from "pg";
import { writeFileSync, mkdirSync } from "fs";
import { runSyncMappingsReconcile, defaultReconcilerDeps } from "../server/sync-mappings-reconciler";

const noopStorage = {
  createAuditLog: async () => ({}),
  createManualReviewQueueEntry: async () => ({}),
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const report = await runSyncMappingsReconcile(defaultReconcilerDeps(pool, noopStorage), { commit: false });
    console.log(`[reconcile] rows=${report.totalRows} portfolio_cache=${report.cacheSize}`);
    console.log(
      `[reconcile] ALERTS: cross_column_conflict=${report.counts.cross_column_conflict} orphaned_portfolio=${report.counts.orphaned_portfolio}` +
        ` | INFO: cross_column_redundant=${report.counts.cross_column_redundant}`,
    );
    for (const i of report.issues.filter((x) => x.severity === "error")) {
      console.log(`   [${i.type}] rows=[${i.mappingIds.join(",")}] id=${i.procoreId} — ${i.detail}`);
    }
    mkdirSync(".audit", { recursive: true });
    const path = `.audit/sync-mappings-reconcile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`[reconcile] snapshot: ${path}`);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[reconcile] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
