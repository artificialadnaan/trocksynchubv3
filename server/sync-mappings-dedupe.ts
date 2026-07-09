/**
 * Canonical sync_mappings dedup (#2 of the SyncHub complete-fix).
 *
 * Collapses duplicate rows that share a non-null procore_project_id. The 2026-07-09 prod census
 * found 58 such clusters (largest = 22 identical rows, 211 rows total) and — critically — ZERO of
 * them touch a bidboard/portfolio row, so this can never corrupt the bid-board→portfolio lineage.
 *
 * Keeps ONE survivor per cluster and COALESCE-merges the deleted siblings' non-null fields into it,
 * so no data is lost. Fulfils the "Dedupe legacy sync_mappings rows" backlog item deferred in
 * migration 0015. Mirrors the scripts/migrate-procore-role-dedupe.ts convention; the decision logic
 * is a pure function (planClusterDedupe) unit-tested without a database.
 */

/** One sync_mappings row, in camelCase, carrying only the fields the dedup reads/merges. */
export interface DedupeMappingRow {
  id: number;
  sourceSystem: string | null;
  sourceDealId: string | null;
  hubspotDealId: string | null;
  hubspotCompanyId: string | null;
  hubspotDealName: string | null;
  procoreProjectId: string | null;
  procoreCompanyId: string | null;
  procoreProjectName: string | null;
  procoreProjectNumber: string | null;
  companyCamProjectId: string | null;
  bidboardProjectId: string | null;
  bidboardProjectName: string | null;
  portfolioProjectId: string | null;
  portfolioProjectName: string | null;
  sentToPortfolioAt: Date | string | null;
  lastSyncAt: Date | string | null;
  lastSyncStatus: string | null;
  lastSyncDirection: string | null;
  metadata: unknown;
}

export interface ClusterDedupePlan {
  survivorId: number;
  /** Fields to write onto the survivor — only those it lacked and a sibling supplied. */
  updates: Partial<Record<keyof DedupeMappingRow, unknown>>;
  deleteIds: number[];
}

/** A cluster whose rows disagree on a lineage id — never auto-merged; surfaced for manual review. */
export class AmbiguousClusterError extends Error {
  constructor(
    public readonly procoreProjectId: string | null,
    public readonly bidboardIds: string[],
    public readonly portfolioIds: string[],
  ) {
    super(
      `Ambiguous sync_mappings cluster for procore_project_id=${procoreProjectId}: ` +
        `distinct bidboard ids=[${bidboardIds.join(", ")}], portfolio ids=[${portfolioIds.join(", ")}]`,
    );
    this.name = "AmbiguousClusterError";
  }
}

/**
 * Fields COALESCE-merged from deleted siblings into the survivor. Deliberately EXCLUDES the
 * identity keys (sourceSystem, sourceDealId, procoreProjectId) — those key the cluster, so the
 * survivor's own values are authoritative.
 */
export const MERGE_FIELDS: (keyof DedupeMappingRow)[] = [
  "hubspotDealId",
  "hubspotCompanyId",
  "hubspotDealName",
  "procoreCompanyId",
  "procoreProjectName",
  "procoreProjectNumber",
  "companyCamProjectId",
  "bidboardProjectId",
  "bidboardProjectName",
  "portfolioProjectId",
  "portfolioProjectName",
  "sentToPortfolioAt",
  "lastSyncAt",
  "lastSyncStatus",
  "lastSyncDirection",
  "metadata",
];

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Pure planner for ONE cluster (all rows share a procore_project_id). Returns the survivor, the
 * non-null fields to merge onto it, and the sibling ids to delete. Never mutates its input.
 *
 * Survivor = the row bearing a lineage id (bidboard/portfolio) if any, else the lowest id.
 * Throws AmbiguousClusterError if rows disagree on a lineage id (would risk merging two real
 * projects — the 2026-07 census shows zero such clusters, so this is a fail-closed guard).
 */
export function planClusterDedupe(rows: DedupeMappingRow[]): ClusterDedupePlan {
  if (rows.length === 0) throw new Error("planClusterDedupe: empty cluster");

  const distinct = (key: keyof DedupeMappingRow): string[] =>
    Array.from(new Set(rows.map((r) => r[key]).filter((v) => !isBlank(v)) as string[]));
  const bidboardIds = distinct("bidboardProjectId");
  const portfolioIds = distinct("portfolioProjectId");
  if (bidboardIds.length > 1 || portfolioIds.length > 1) {
    throw new AmbiguousClusterError(rows[0].procoreProjectId, bidboardIds, portfolioIds);
  }

  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const survivor =
    sorted.find((r) => !isBlank(r.bidboardProjectId) || !isBlank(r.portfolioProjectId)) ?? sorted[0];
  const siblings = sorted.filter((r) => r.id !== survivor.id);

  const updates: Partial<Record<keyof DedupeMappingRow, unknown>> = {};
  for (const field of MERGE_FIELDS) {
    if (!isBlank(survivor[field])) continue;
    const donor = siblings.find((r) => !isBlank(r[field]));
    if (donor) updates[field] = donor[field];
  }

  return { survivorId: survivor.id, updates, deleteIds: siblings.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// DB driver (raw SQL). Accepts a SINGLE-connection Queryable so BEGIN/COMMIT
// stay on one connection (a pg PoolClient via pool.connect(), or a PGlite
// instance in tests) — never a pg.Pool directly.
// ---------------------------------------------------------------------------

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** camelCase field -> snake_case column, for the SELECT mapping and the survivor UPDATE. */
const FIELD_TO_COLUMN: Record<keyof DedupeMappingRow, string> = {
  id: "id",
  sourceSystem: "source_system",
  sourceDealId: "source_deal_id",
  hubspotDealId: "hubspot_deal_id",
  hubspotCompanyId: "hubspot_company_id",
  hubspotDealName: "hubspot_deal_name",
  procoreProjectId: "procore_project_id",
  procoreCompanyId: "procore_company_id",
  procoreProjectName: "procore_project_name",
  procoreProjectNumber: "procore_project_number",
  companyCamProjectId: "companycam_project_id",
  bidboardProjectId: "bidboard_project_id",
  bidboardProjectName: "bidboard_project_name",
  portfolioProjectId: "portfolio_project_id",
  portfolioProjectName: "portfolio_project_name",
  sentToPortfolioAt: "sent_to_portfolio_at",
  lastSyncAt: "last_sync_at",
  lastSyncStatus: "last_sync_status",
  lastSyncDirection: "last_sync_direction",
  metadata: "metadata",
};

function mapRow(raw: Record<string, any>): DedupeMappingRow {
  const out = {} as DedupeMappingRow;
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN) as [keyof DedupeMappingRow, string][]) {
    (out as any)[field] = raw[column] ?? null;
  }
  return out;
}

export interface ClusterOutcome {
  procoreProjectId: string;
  survivorId: number;
  deletedIds: number[];
  updates: Partial<Record<keyof DedupeMappingRow, unknown>>;
}

export interface DedupeReport {
  totalRowsBefore: number;
  clusters: number;
  rowsToDelete: number;
  survivorsToUpdate: number;
  committed: boolean;
  perCluster: ClusterOutcome[];
  ambiguous: Array<{ procoreProjectId: string | null; bidboardIds: string[]; portfolioIds: string[] }>;
}

/**
 * Plan (and, when opts.commit, apply) the dedup. Ambiguous clusters are NEVER deleted — they are
 * skipped and surfaced in report.ambiguous for manual review. Clean clusters are collapsed in a
 * single transaction. Idempotent: a deduped table yields 0 clusters.
 */
export async function runSyncMappingsDedupe(
  client: Queryable,
  opts: { commit: boolean },
): Promise<DedupeReport> {
  const totalRes = await client.query(`SELECT count(*)::int AS n FROM sync_mappings`);
  const totalRowsBefore = Number(totalRes.rows[0]?.n ?? 0);

  const clusterRes = await client.query(`
    SELECT * FROM sync_mappings
    WHERE procore_project_id IN (
      SELECT procore_project_id FROM sync_mappings
      WHERE procore_project_id IS NOT NULL AND btrim(procore_project_id) <> ''
      GROUP BY procore_project_id
      HAVING count(*) > 1
    )
    ORDER BY procore_project_id, id
  `);

  const byCluster = new Map<string, DedupeMappingRow[]>();
  for (const raw of clusterRes.rows) {
    const row = mapRow(raw);
    const key = String(row.procoreProjectId);
    (byCluster.get(key) ?? byCluster.set(key, []).get(key)!).push(row);
  }

  const perCluster: ClusterOutcome[] = [];
  const ambiguous: DedupeReport["ambiguous"] = [];
  for (const [procoreProjectId, rows] of byCluster) {
    try {
      const plan = planClusterDedupe(rows);
      if (plan.deleteIds.length === 0) continue;
      perCluster.push({ procoreProjectId, survivorId: plan.survivorId, deletedIds: plan.deleteIds, updates: plan.updates });
    } catch (err) {
      if (err instanceof AmbiguousClusterError) {
        ambiguous.push({ procoreProjectId: err.procoreProjectId, bidboardIds: err.bidboardIds, portfolioIds: err.portfolioIds });
      } else {
        throw err;
      }
    }
  }

  const rowsToDelete = perCluster.reduce((n, c) => n + c.deletedIds.length, 0);
  const survivorsToUpdate = perCluster.filter((c) => Object.keys(c.updates).length > 0).length;

  if (opts.commit && perCluster.length > 0) {
    await client.query("BEGIN");
    try {
      for (const c of perCluster) {
        const updateKeys = Object.keys(c.updates) as (keyof DedupeMappingRow)[];
        if (updateKeys.length > 0) {
          const sets = updateKeys.map((k, i) => `${FIELD_TO_COLUMN[k]} = $${i + 1}`);
          const values = updateKeys.map((k) => c.updates[k] ?? null);
          await client.query(
            `UPDATE sync_mappings SET ${sets.join(", ")} WHERE id = $${updateKeys.length + 1}`,
            [...values, c.survivorId],
          );
        }
        await client.query(`DELETE FROM sync_mappings WHERE id = ANY($1::int[])`, [c.deletedIds]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  return {
    totalRowsBefore,
    clusters: perCluster.length,
    rowsToDelete,
    survivorsToUpdate,
    committed: opts.commit && perCluster.length > 0,
    perCluster,
    ambiguous,
  };
}
