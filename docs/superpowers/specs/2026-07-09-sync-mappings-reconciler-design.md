# sync_mappings integrity reconciler — Design (#3 of the SyncHub complete-fix)

**Status:** self-approved (Adnaan authorized full autonomy, 2026-07-09) · **Follows:** #2 canonical sync_mappings (shipped) · **Precedes:** #4 backfill

## Objective
A periodic watchdog that reconciles `sync_mappings` against Procore truth and **alerts on integrity drift** — in particular the **cross-column collision** deferred from #2 (the same Procore id as `procore_project_id` on one row and `portfolio_project_id` on another, which the per-column unique indexes can't prevent and `transitionToPortfolio` can create). It mirrors the existing reconciliation engine's *shape* (scan → classify → record) but is otherwise net-new: the existing engine (`server/services/reconciliation/*`) reconciles Procore↔HubSpot↔BidBoard by project **number** and never touches `sync_mappings`.

## Grounding (read-only prod census, 2026-07-09, post-#2)
| Check | Prod count | Decision |
|---|---|---|
| cross-column collision, **different** `source_deal_id` | **1** | **ALERT** (genuine conflict — two deals share a Procore id across columns) |
| cross-column redundancy, **same** `source_deal_id` | **55** | **REPORT (info)** — benign representation; auto-collapse is destructive → deferred |
| orphaned portfolio (`portfolio_project_id` ∉ `procore_projects`) | **0** | **ALERT** (watchdog; a stamped portfolio Procore no longer knows) |

Note: `procore_projects` is **no longer portfolio-only** (was ~99, now 799 rows), so "procore_id in cache ⇒ it's a portfolio" is false — the planned unstamped-portfolio **self-heal was dropped as unsound**. No safe auto-heal remains, so #3 is **detect + alert only**; destructive fixes (auto-collapse) stay Adnaan-run like #2's dedup.

## Components
### 1. Pure checker — `shared/sync-mappings-reconcile.ts`
`findIntegrityIssues(rows: ReconMappingRow[], portfolioCacheIds: Set<string>): Issue[]`, pure/unit-testable, no DB. `Issue = { type: 'cross_column_conflict' | 'orphaned_portfolio' | 'cross_column_redundant', severity: 'error'|'info', projectNumber, mappingIds, procoreId, detail }`.
- **cross_column_conflict / _redundant:** build `procoreId→rows` and `portfolioId→rows` maps; for each id that is a non-blank `procore_project_id` on row A and `portfolio_project_id` on a different row B → `conflict` if `A.source_deal_id ≠ B.source_deal_id` else `redundant`.
- **orphaned_portfolio:** a row whose non-blank `portfolio_project_id` ∉ `portfolioCacheIds`.

### 2. Driver — `server/sync-mappings-reconciler.ts`
`runSyncMappingsReconcile(deps, { commit }): Promise<ReconReport>`. Loads ALL `sync_mappings` (raw SQL over the whole table — NOT `getSyncMappings()`'s 200 cap) + `SELECT procore_id FROM procore_projects`; runs the checker; in `commit` mode, per **error** issue: upserts a `manual_review_queue` entry on `(project_number, cycle_id)` with a stable per-ISSUE `cycleId = sync-integrity:<type>:<procoreId>:<sorted mappingIds>` (so distinct row-pairs sharing a Procore id never collapse), and — **only on FIRST detection** (no already-unresolved review for that cycleId) — writes an `audit_logs status='error'` row that the 15-min `alertScheduler` emails, so persistent still-unresolved drift doesn't re-alert every daily run. Each issue's writes are isolated in a `try/catch` (`failedWrites` counted) so one bad write can't abort the scan. `info` issues are counted only. Dry-run (default) writes nothing. Returns counts + per-issue detail; snapshot to `.audit/`.

### 3. Cron — `server/cron/syncMappingsReconcileScheduler.ts`
Daily `0 3 * * *` America/Chicago, **env-gated `SYNC_MAPPINGS_RECONCILE_ENABLED`** (default OFF → merge is inert; Adnaan flips it), calling the driver in `commit` mode. Registered in `server/index.ts` next to the other schedulers.

### 4. Manual route — `POST /api/reconciliation/sync-mappings-integrity` (auth)
`?commit=true` to write alerts, else dry-run; returns the report. For on-demand runs + verification.

### 5. CLI — `scripts/reconcile-sync-mappings.ts` (dry-run/`--commit`)
Same shape as `dedupe-sync-mappings.ts` so it can be run via `railway run` for read-only checks.

## Error handling & safety
- Detect-only for the genuine findings; **fail-closed** (alert, never auto-mutate) on conflict/orphan.
- Alerts are **deduped** (won't spam the digest) and dry-run-gated.
- Env-gated cron → inert on merge.

## Testing (vitest + PGlite)
- Pure checker: different-deal → conflict(error); same-deal → redundant(info); orphaned portfolio → error; a clean/transitioned single-row deal → no findings; blank ids ignored.
- Driver (PGlite): dry-run writes nothing; commit writes one audit-error + one deduped manual-review per error issue, info-only issues don't alert; re-run doesn't duplicate the manual-review entry.
- Regression: no NEW failures vs baseline; tsc clean.

## Out of scope (deferred)
- **Auto-collapse** of same-deal cross-column redundancy (destructive; a follow-up Adnaan-run dry-run/`--commit` script, reusing #2's dedup survivor/merge/ambiguity rigor).
- A pre-stamp cross-column guard inside `transitionToPortfolio` (prevention; the reconciler catches it after the fact).
- #4 backfill (separate, next).
