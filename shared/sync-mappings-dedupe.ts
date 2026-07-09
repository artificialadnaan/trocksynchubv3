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

/** A cluster whose rows disagree on a lineage/deal identity — never auto-merged; surfaced for review. */
export class AmbiguousClusterError extends Error {
  constructor(
    public readonly procoreProjectId: string | null,
    public readonly bidboardIds: string[],
    public readonly portfolioIds: string[],
    public readonly sourceDealIds: string[] = [],
  ) {
    super(
      `Ambiguous sync_mappings cluster for procore_project_id=${procoreProjectId}: ` +
        `distinct bidboard ids=[${bidboardIds.join(", ")}], portfolio ids=[${portfolioIds.join(", ")}], ` +
        `source deal ids=[${sourceDealIds.join(", ")}]`,
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
 * Survivor = the row bearing a lineage id (bidboard/portfolio) if any, else a row carrying a real
 * HubSpot deal identity, else the lowest id. Throws AmbiguousClusterError if rows disagree on a lineage
 * id OR carry two distinct HubSpot deals (would risk merging two real deals/projects — the 2026-07
 * census shows zero such clusters, so this is a fail-closed guard).
 */
export function planClusterDedupe(rows: DedupeMappingRow[]): ClusterDedupePlan {
  if (rows.length === 0) throw new Error("planClusterDedupe: empty cluster");

  const procoreId = rows[0].procoreProjectId;
  const distinct = (key: keyof DedupeMappingRow): string[] =>
    Array.from(new Set(rows.map((r) => r[key]).filter((v) => !isBlank(v)) as string[]));
  const bidboardIds = distinct("bidboardProjectId");
  const portfolioIds = distinct("portfolioProjectId");
  // "Real" source identities = source_deal_id values that are NOT the junk self-reference (== the procore
  // id). migration 0015 made (source_system, source_deal_id) authoritative even without a hubspot_deal_id,
  // so a divergent source_deal_id — not just a divergent hubspot_deal_id — makes the cluster ambiguous.
  const realSourceIds = Array.from(
    new Set(rows.map((r) => r.sourceDealId).filter((v) => !isBlank(v) && v !== procoreId) as string[]),
  );
  // Fail-closed guard: never FUSE two distinct identities into one survivor.
  //  - >1 distinct bidboard/portfolio id OR >1 distinct real source_deal_id → two real projects/deals
  //    share this procore id; refuse.
  //  - one bidboard + one portfolio on SEPARATE rows (no single row carries BOTH) → a bidboard-only row
  //    and a portfolio-only row would be fused; refuse. A legitimately transitioned row carries both keys.
  const coResident = rows.some((r) => !isBlank(r.bidboardProjectId) && !isBlank(r.portfolioProjectId));
  if (
    bidboardIds.length > 1 ||
    portfolioIds.length > 1 ||
    realSourceIds.length > 1 ||
    (bidboardIds.length === 1 && portfolioIds.length === 1 && !coResident)
  ) {
    throw new AmbiguousClusterError(procoreId, bidboardIds, portfolioIds, realSourceIds);
  }

  const sorted = [...rows].sort((a, b) => a.id - b.id);
  // Prefer a lineage-bearing row, then a row carrying a real (non-junk) source identity — so the survivor
  // stays reachable by getSyncMappingBySourceDealId / getSyncMappingByHubspotDealId — then the lowest id.
  const survivor =
    sorted.find((r) => !isBlank(r.bidboardProjectId) || !isBlank(r.portfolioProjectId)) ??
    sorted.find((r) => !isBlank(r.sourceDealId) && r.sourceDealId !== procoreId) ??
    sorted[0];
  const siblings = sorted.filter((r) => r.id !== survivor.id);

  const updates: Partial<Record<keyof DedupeMappingRow, unknown>> = {};
  for (const field of MERGE_FIELDS) {
    if (!isBlank(survivor[field])) continue;
    const donor = siblings.find((r) => !isBlank(r[field]));
    if (donor) updates[field] = donor[field];
  }

  // Migrate the source identity when the survivor's is a junk self-reference (source_deal_id ==
  // procore_project_id, the legacy no-HubSpot marker) but a sibling carries a real external deal key —
  // otherwise deleting that sibling leaves the mapping unreachable by (source_system, source_deal_id).
  const survivorSourceIsJunk = !isBlank(survivor.sourceDealId) && survivor.sourceDealId === procoreId;
  if (survivorSourceIsJunk) {
    const donor = siblings.find((r) => !isBlank(r.sourceDealId) && r.sourceDealId !== procoreId);
    if (donor) {
      updates.sourceSystem = donor.sourceSystem;
      updates.sourceDealId = donor.sourceDealId;
    }
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
  ambiguous: Array<{ procoreProjectId: string | null; bidboardIds: string[]; portfolioIds: string[]; sourceDealIds: string[] }>;
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
        ambiguous.push({ procoreProjectId: err.procoreProjectId, bidboardIds: err.bidboardIds, portfolioIds: err.portfolioIds, sourceDealIds: err.sourceDealIds });
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
          const sets = updateKeys.map((k, i) =>
            k === "metadata" ? `${FIELD_TO_COLUMN[k]} = $${i + 1}::jsonb` : `${FIELD_TO_COLUMN[k]} = $${i + 1}`,
          );
          const values = updateKeys.map((k) => {
            const v = c.updates[k] ?? null;
            // jsonb: serialise explicitly so a top-level array can't be coerced to a Postgres array literal.
            return k === "metadata" && v != null ? JSON.stringify(v) : v;
          });
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
