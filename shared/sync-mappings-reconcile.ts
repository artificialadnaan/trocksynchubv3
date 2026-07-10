/**
 * sync_mappings integrity reconciler (#3 of the SyncHub complete-fix) — PURE checker.
 *
 * Detects the integrity drift that the per-column unique indexes (#2) cannot prevent, chiefly the
 * deferred CROSS-COLUMN collision: the same Procore id appearing as `procore_project_id` on one row and
 * `portfolio_project_id` on a DIFFERENT row (transitionToPortfolio can create this). Detect + alert only
 * — every genuine finding is ambiguous/destructive to auto-fix, so the driver fails closed (alerts,
 * never mutates). No DB here; the driver feeds rows + the portfolio-cache id set.
 */

export interface ReconMappingRow {
  id: number;
  sourceSystem: string | null;
  sourceDealId: string | null;
  procoreProjectId: string | null;
  portfolioProjectId: string | null;
  bidboardProjectId: string | null;
  procoreProjectNumber: string | null;
}

export type IssueType = "cross_column_conflict" | "cross_column_redundant" | "orphaned_portfolio";
export type IssueSeverity = "error" | "info";

export interface Issue {
  type: IssueType;
  severity: IssueSeverity;
  projectNumber: string | null;
  mappingIds: number[];
  procoreId: string | null;
  detail: string;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}
function norm(v: unknown): string | null {
  return isBlank(v) ? null : String(v).trim();
}
/**
 * (source_system, source_deal_id) identity — two rows are the "same deal" iff BOTH the deal id AND the
 * system are present and equal. Fail-loud: if either system is blank we do NOT treat them as the same
 * deal (so a genuine cross-deal collision stays an error rather than being downgraded to info).
 */
function sameDeal(a: ReconMappingRow, b: ReconMappingRow): boolean {
  const ad = norm(a.sourceDealId);
  const as = norm(a.sourceSystem);
  return ad !== null && ad === norm(b.sourceDealId) && as !== null && as === norm(b.sourceSystem);
}

export function findIntegrityIssues(rows: ReconMappingRow[], portfolioCacheIds: Set<string>): Issue[] {
  const issues: Issue[] = [];

  // --- cross-column: id X is a procore_project_id on row A and a portfolio_project_id on a DIFFERENT row B.
  const portfolioIdToRows = new Map<string, ReconMappingRow[]>();
  for (const r of rows) {
    const pf = norm(r.portfolioProjectId);
    if (pf) (portfolioIdToRows.get(pf) ?? portfolioIdToRows.set(pf, []).get(pf)!).push(r);
  }
  const seenPairs = new Set<string>();
  for (const a of rows) {
    const procore = norm(a.procoreProjectId);
    if (!procore) continue;
    for (const b of portfolioIdToRows.get(procore) ?? []) {
      if (b.id === a.id) continue; // same row (procore==portfolio) is a benign transitioned row, not cross-ROW
      // Key on the colliding id TOO — the same row-pair can collide on two different ids (A has
      // procore=X/portfolio=Y, B has procore=Y/portfolio=X), and both are distinct drift to report.
      const key = `${procore}:${[a.id, b.id].sort((x, y) => x - y).join(":")}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const same = sameDeal(a, b);
      issues.push({
        type: same ? "cross_column_redundant" : "cross_column_conflict",
        severity: same ? "info" : "error",
        projectNumber: norm(a.procoreProjectNumber) ?? norm(b.procoreProjectNumber),
        mappingIds: [a.id, b.id].sort((x, y) => x - y),
        procoreId: procore,
        detail: same
          ? `Procore id ${procore} is procore_project_id on row ${a.id} and portfolio_project_id on row ${b.id} for the SAME deal (${norm(a.sourceSystem)}:${norm(a.sourceDealId)}) — redundant rows (dedup candidate)`
          : `Procore id ${procore} collides ACROSS DIFFERENT deals: procore_project_id on row ${a.id} (${norm(a.sourceSystem)}:${norm(a.sourceDealId)}) vs portfolio_project_id on row ${b.id} (${norm(b.sourceSystem)}:${norm(b.sourceDealId)})`,
      });
    }
  }

  // --- orphaned portfolio: a stamped portfolio_project_id absent from the Procore cache. Skip entirely if
  // the cache didn't load (empty) — never flag every row on a fetch failure.
  if (portfolioCacheIds.size > 0) {
    for (const r of rows) {
      const pf = norm(r.portfolioProjectId);
      if (pf && !portfolioCacheIds.has(pf)) {
        issues.push({
          type: "orphaned_portfolio",
          severity: "error",
          projectNumber: norm(r.procoreProjectNumber),
          mappingIds: [r.id],
          procoreId: pf,
          detail: `Row ${r.id} portfolio_project_id ${pf} is not in the procore_projects cache — the portfolio project may have been deleted/archived in Procore`,
        });
      }
    }
  }

  return issues;
}

/** Split issues by how the driver should act. */
export function partitionIssues(issues: Issue[]): { alerts: Issue[]; info: Issue[] } {
  return {
    alerts: issues.filter((i) => i.severity === "error"),
    info: issues.filter((i) => i.severity === "info"),
  };
}
