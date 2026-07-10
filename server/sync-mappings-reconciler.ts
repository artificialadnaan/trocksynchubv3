/**
 * sync_mappings integrity reconciler (#3) — DB driver + alert orchestration.
 *
 * Loads the WHOLE sync_mappings table (raw SQL — not getSyncMappings()'s 200 cap) + the procore_projects
 * cache ids, runs the pure checker (shared/sync-mappings-reconcile.ts), and in commit mode writes each
 * ERROR issue to the existing loud-guard channel: an audit_logs status='error' row (scanned by the 15-min
 * alertScheduler) + a deduped manual_review_queue entry (upsert on project_number+cycle_id, only-if-
 * unresolved). INFO issues (same-deal cross-column redundancy) are counted, never alerted. Dry-run
 * (default) writes nothing. Detect + alert only — it never mutates sync_mappings.
 */
import {
  findIntegrityIssues,
  partitionIssues,
  type Issue,
  type IssueType,
  type ReconMappingRow,
} from "../shared/sync-mappings-reconcile";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ReconcilerDeps {
  loadRows(): Promise<ReconMappingRow[]>;
  loadPortfolioCacheIds(): Promise<Set<string>>;
  writeAuditError(row: {
    action: string;
    entityType: string;
    entityId: string | null;
    source: string;
    status: string;
    category: string;
    errorMessage: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
  upsertManualReview(entry: {
    projectNumber: string;
    projectName: string;
    currentStage: string;
    cycleId: string;
    reason: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface ReconReport {
  totalRows: number;
  cacheSize: number;
  counts: Record<IssueType, number>;
  alertsWritten: number;
  failedWrites: number;
  committed: boolean;
  issues: Issue[];
}

export async function runSyncMappingsReconcile(
  deps: ReconcilerDeps,
  opts: { commit: boolean },
): Promise<ReconReport> {
  const rows = await deps.loadRows();
  // A cache-load failure must NOT drop the cross-column checks (which don't need the cache). Fall back to
  // an empty set → the checker's empty-cache fail-safe skips ONLY the orphan check.
  let cacheIds: Set<string>;
  try {
    cacheIds = await deps.loadPortfolioCacheIds();
  } catch (err) {
    console.error("[sync-mappings-reconcile] procore_projects cache load failed; skipping orphan checks:", err instanceof Error ? err.message : err);
    cacheIds = new Set();
  }
  const issues = findIntegrityIssues(rows, cacheIds);
  const { alerts } = partitionIssues(issues);

  const counts: Record<IssueType, number> = {
    cross_column_conflict: 0,
    cross_column_redundant: 0,
    orphaned_portfolio: 0,
  };
  for (const i of issues) counts[i.type]++;

  let alertsWritten = 0;
  let failedWrites = 0;
  if (opts.commit) {
    for (const issue of alerts) {
      // Per-issue try/catch: a single failed write must not abort the scan and drop every later alert.
      try {
        const projectNumber = issue.projectNumber ?? `sync-mapping-${issue.mappingIds.join("-")}`;
        // Stable per-ISSUE identity (id + the exact row pair) → the manual_review upsert de-dupes across
        // runs but never collapses two DISTINCT issues that happen to share a procore id.
        const cycleId = `sync-integrity:${issue.type}:${issue.procoreId ?? "_"}:${issue.mappingIds.join("-")}`;
        const details = { type: issue.type, mappingIds: issue.mappingIds, procoreId: issue.procoreId, projectNumber: issue.projectNumber };

        // Alert FIRST (audit_logs status='error' → the 15-min alertScheduler emails it), THEN queue for
        // triage. No first-detection gate: persistent unresolved drift intentionally re-alerts each run
        // (it is still broken), while the manual_review_queue upsert on (project_number, cycle_id) keeps the
        // triage surface de-duped so it never grows. Audit-before-review means a row in the queue always
        // corresponds to an issue that was (attempted-)alerted.
        await deps.writeAuditError({
          action: `sync_mappings_integrity_${issue.type}`,
          entityType: "sync_mapping",
          entityId: String(issue.mappingIds[0]),
          source: "sync_mappings_reconciler",
          status: "error",
          category: "sync",
          errorMessage: issue.detail,
          details,
        });
        await deps.upsertManualReview({
          projectNumber,
          projectName: `sync_mappings integrity: ${issue.type}`,
          currentStage: "integrity_reconcile",
          cycleId,
          reason: issue.detail,
          details,
        });
        alertsWritten++;
      } catch (err) {
        failedWrites++;
        console.error(
          `[sync-mappings-reconcile] failed to record issue ${issue.type} rows=[${issue.mappingIds.join(",")}]:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return {
    totalRows: rows.length,
    cacheSize: cacheIds.size,
    counts,
    alertsWritten,
    failedWrites,
    committed: opts.commit && alerts.length > 0,
    issues,
  };
}

const LOAD_ROWS_SQL = `
  SELECT id, source_system, source_deal_id, procore_project_id, portfolio_project_id,
         bidboard_project_id, procore_project_number
  FROM sync_mappings
`;

function mapRow(r: Record<string, any>): ReconMappingRow {
  return {
    id: Number(r.id),
    sourceSystem: r.source_system ?? null,
    sourceDealId: r.source_deal_id ?? null,
    procoreProjectId: r.procore_project_id ?? null,
    portfolioProjectId: r.portfolio_project_id ?? null,
    bidboardProjectId: r.bidboard_project_id ?? null,
    procoreProjectNumber: r.procore_project_number ?? null,
  };
}

/** Default deps: raw SQL loads via the pool (one pooled connection per query) + storage alert writers. */
export function defaultReconcilerDeps(
  client: Queryable,
  storage: {
    createAuditLog(row: any): Promise<unknown>;
    createManualReviewQueueEntry(data: any): Promise<unknown>;
  },
): ReconcilerDeps {
  return {
    loadRows: async () => (await client.query(LOAD_ROWS_SQL)).rows.map(mapRow),
    // The FULL procore_projects cache (all active Procore projects — no longer portfolio-only), trimmed
    // the same way the checker normalizes mapping-side ids so a padded cache id can't false-flag orphans.
    loadPortfolioCacheIds: async () => {
      const res = await client.query(`SELECT procore_id FROM procore_projects WHERE procore_id IS NOT NULL`);
      return new Set(res.rows.map((r) => String(r.procore_id).trim()).filter((s) => s !== ""));
    },
    writeAuditError: (row) => storage.createAuditLog(row),
    upsertManualReview: (entry) => storage.createManualReviewQueueEntry(entry as any),
  };
}
