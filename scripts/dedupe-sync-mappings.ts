#!/usr/bin/env -S npx tsx
/**
 * Dedupe legacy sync_mappings rows (#2 of the SyncHub complete-fix) — fulfils the "Dedupe legacy
 * sync_mappings rows" backlog item deferred in migration 0015.
 *
 * Collapses duplicate rows that share a non-null procore_project_id, keeping one survivor per cluster
 * and COALESCE-merging the deleted siblings' non-null fields into it (see server/sync-mappings-dedupe.ts).
 *
 * DRY-RUN by default: prints the plan + writes a JSON snapshot to .audit/, writes NOTHING to the DB.
 * Pass --commit to apply. Must run BEFORE `CI=1 npm run db:push` (which adds the unique indexes).
 *
 *   DATABASE_URL=... npx tsx scripts/dedupe-sync-mappings.ts            # dry-run
 *   DATABASE_URL=... npx tsx scripts/dedupe-sync-mappings.ts --commit   # apply
 *   npm run db:migrate-sync-mappings-dedupe -- --commit
 */
import pg from "pg";
import { writeFileSync, mkdirSync } from "fs";
import { runSyncMappingsDedupe } from "../server/sync-mappings-dedupe";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  const commit = process.argv.includes("--commit");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let report;
  try {
    report = await runSyncMappingsDedupe(client, { commit });

    console.log(`[dedupe] mode: ${commit ? "COMMIT" : "DRY-RUN"}`);
    console.log(`[dedupe] rows before: ${report.totalRowsBefore}`);
    console.log(`[dedupe] clusters to collapse: ${report.clusters}`);
    console.log(`[dedupe] rows to delete: ${report.rowsToDelete}`);
    console.log(`[dedupe] survivors updated (field merges): ${report.survivorsToUpdate}`);

    if (report.ambiguous.length > 0) {
      console.log(`[dedupe] ⚠ ${report.ambiguous.length} AMBIGUOUS cluster(s) SKIPPED — manual review:`);
      for (const a of report.ambiguous) {
        console.log(
          `   procore_project_id=${a.procoreProjectId} bidboard=[${a.bidboardIds.join(", ")}] portfolio=[${a.portfolioIds.join(", ")}]`,
        );
      }
    }
    for (const c of report.perCluster) {
      console.log(
        `   pj=${c.procoreProjectId} keep id=${c.survivorId} delete=[${c.deletedIds.join(", ")}] merge=${JSON.stringify(Object.keys(c.updates))}`,
      );
    }

    mkdirSync(".audit", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = `.audit/sync-mappings-dedupe-${commit ? "commit" : "dryrun"}-${stamp}.json`;
    writeFileSync(snapshotPath, JSON.stringify(report, null, 2));
    console.log(`[dedupe] snapshot: ${snapshotPath}`);
    console.log(
      report.committed
        ? `[dedupe] COMMITTED — removed ${report.rowsToDelete} row(s)`
        : `[dedupe] NO CHANGES WRITTEN (${commit ? "nothing to dedupe" : "dry-run — re-run with --commit to apply"})`,
    );
  } finally {
    client.release();
    await pool.end();
  }
  // Fail-closed: ambiguous clusters are left in place (their duplicate procore_project_id rows still
  // exist), so exit non-zero in --commit mode. In the Dockerfile `&& ... && CI=1 npm run db:push` chain
  // this HALTS before db:push builds the unique index on still-duplicated data.
  if (commit && report.ambiguous.length > 0) {
    console.error(
      `[dedupe] ABORTING: ${report.ambiguous.length} ambiguous cluster(s) need manual review before db:push builds the unique index.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[dedupe] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
