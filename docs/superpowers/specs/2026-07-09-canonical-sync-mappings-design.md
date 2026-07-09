# Canonical `sync_mappings` — Design (#2 of the SyncHub complete-fix)

**Status:** approved (Adnaan, 2026-07-09) · **Follows:** #1 existence gate (PR #51, merged/live) · **Precedes:** #3 reconciler, #4 backfill

## Objective

Make `sync_mappings` a table the rest of SyncHub can trust:

1. **Remove the ~153 legacy junk-duplicate rows** (the "Dedupe legacy sync_mappings rows" backlog item explicitly deferred in migration `0015`).
2. **DB-enforce the real 1:1 invariants** — a partial unique index on `procore_project_id` and on `portfolio_project_id`.
3. **Make the write path idempotent** so the new constraint never throws on a re-insert, and **make the by-key getters deterministic** so they stop returning an arbitrary row.

This directly fulfils the backlog note in `migrations/0015_add_source_identity_to_rfp_and_sync_mappings.sql` (lines 84–91).

## Why (grounded in prod census, 2026-07-09)

`sync_mappings`: **1312 rows / 976 distinct deals**.

| Fact | Value | Consequence |
|---|---|---|
| `bidboard_project_id` | 483, all distinct, already partial-unique (idx from 0015) | clean — untouched |
| `portfolio_project_id` | 99, all distinct, **all on their bidboard row**, 0 double-mapped | clean; add a constraint to keep it that way |
| `procore_project_id` | 818 rows / **665 distinct**; 58 ids on >1 row; **largest cluster = 22 identical rows**; 211 rows in dupe clusters | `getSyncMappingByProcoreProjectId` returns an arbitrary row — called in **~15 places** (emails, change-orders, closeout, companycam, webhooks) |
| dupe clusters touching a bb/pf row | **0** | dedup is provably safe — it cannot corrupt the bid-board→portfolio lineage |
| `procore_project_number` | 148 numbers on >1 row | a number is *legitimately* shared by a bidboard row + its portfolio row → **stays non-unique**; getter just made deterministic |
| `project_phase` | always `'bidboard'` | dead column — left alone (out of scope) |

The gate (#1) resolves existence from the `procore_projects` cache + live Procore and self-heals via the *unique* `bidboard_project_id` key, so it is **not** threatened by this looseness. #2's value is: kill the arbitrary-first-row correctness holes, stop unbounded row growth, and give the reconciler (#3) a clean table.

Root cause of the dupes: `createSyncMapping` is a plain `INSERT` with no conflict handling, and several call sites pre-check on keys that miss (the junk rows have `source_deal_id == procore_project_id`, no bb/pf, `status='pending'`). One DB-level arbiter fixes all of them.

## Components

### 1. Dedup script — `scripts/dedupe-sync-mappings.ts`
Follows the `scripts/migrate-procore-role-dedupe.ts` convention (raw `pg`, run via an npm `db:*` script), with an added **dry-run/`--commit`** gate (Adnaan runs all prod writes; dry-run is the default).

- **Cluster key:** a non-blank `procore_project_id` (`IS NOT NULL AND btrim(...) <> ''` — the **same predicate** as the unique index, so a blank-string id is unconstrained everywhere and can never survive dedup then break `db:push`). Rows with a NULL/blank `procore_project_id` are intentionally left in place — they fall outside the partial index, so there is no truncation risk, and the census shows no such duplicates.
- **Survivor selection (per cluster):** the row bearing a `bidboard_project_id` or `portfolio_project_id` if any exists (there are none today, but the rule keeps the lineage row if a future cluster has one) → else the **lowest `id`**.
- **Ambiguity guard (fail-closed):** if a cluster's rows carry >1 distinct bidboard/portfolio id, OR a bidboard-only row and a portfolio-only row that don't co-reside on one row, the planner throws `AmbiguousClusterError` — those rows are **skipped** (never fused), surfaced in the report, and the CLI exits **non-zero** in `--commit` mode so the migration chain halts before `db:push`.
- **Merge:** `COALESCE` every non-null scalar field from the deleted siblings **into** the survivor (never overwrite a survivor non-null with a sibling value; `metadata` serialised as `jsonb`), then delete the siblings.
- **Safety:** whole run in one transaction; prints a full before/after census + per-cluster plan; writes a JSON snapshot to `.audit/`; `--commit` required to write; re-runnable (idempotent — a deduped table yields 0 changes).
- Registered as `db:migrate-sync-mappings-dedupe` and inserted **before** `db:push` in the documented Dockerfile migration chain.

### 2. Partial unique indexes — `shared/schema.ts`
Add to the `syncMappings` table definition, mirroring the existing `idx_sync_mappings_bidboard_project_id`:
```ts
uniqueIndex("idx_sync_mappings_procore_project_id").on(table.procoreProjectId).where(sql`procore_project_id IS NOT NULL AND btrim(procore_project_id) <> ''`),
uniqueIndex("idx_sync_mappings_portfolio_project_id").on(table.portfolioProjectId).where(sql`portfolio_project_id IS NOT NULL AND btrim(portfolio_project_id) <> ''`),
```
The `btrim(...) <> ''` clause matches the dedup filter and the getters' blank-as-absent treatment exactly, so a blank-string id is unconstrained (never triggers a `db:push --force` truncate). Applied in prod by `CI=1 npm run db:push` **after** the dedup script (established ordering). Not created on merge — deploy does not auto-push.

### 3. Read-then-write upsert — `storage.upsertSyncMappingByProcoreProject`
`createSyncMapping` stays a **plain insert** (a conflict on any unique index — the new procore/portfolio indexes AND the `bidboard_project_id` ownership guard — throws, preserving `/api/bidboard/link-deal` semantics). The re-sync writers (CompanyCam matcher × 5, procore-hubspot-sync × 5) instead call the new **read-then-write** helper, because their best-effort 200-row preload can miss an older mapping and would otherwise throw on the new index:

- **Authoritative lookup** via `getSyncMappingByProcoreProjectId` (matches the id in `procore_`/`portfolio_`/`bidboard_project_id`), so it also **collapses the cross-column case** (an id already stamped as `portfolio_project_id`) onto the existing row instead of inserting a second one.
- **Additive fill-only patch** (`buildLinkUpsertPatch`): fills descriptive/companycam/hubspot columns only where blank; refreshes telemetry (`last_sync_*`) only when the caller actually supplies it (a link-only write never downgrades a synced row); migrates `(source_system, source_deal_id)` onto the row when its source is a junk self-reference to any of its own project ids (so a CompanyCam op that carries a HubSpot deal becomes reachable via `getSyncMappingByHubspotDealId`); never overwrites a load-bearing `metadata.proposalId`.
- **Race-safe:** on `23505` it re-reads and patches instead of throwing. Works whether or not the index exists yet (no `ON CONFLICT`, so no `42P10`), so the PR is safe to merge before `db:push`.

### 4. Deterministic, bidboard-first getters — `storage.ts`
Add a canonical `ORDER BY` to `getSyncMappingByProcoreProjectId`, `getSyncMappingByProcoreProjectNumber`, `getSyncMappingBySourceDealId` preferring a **`bidboard_project_id`-bearing** row, then `portfolio_project_id`, then most-recent `last_sync_at`, then lowest `id`. Bidboard-first because the dominant consumers are trigger/creation GUARDS ("does this deal/project already have a BidBoard project?" — hubspot-bidboard-trigger, portfolio-automation), which a portfolio-only duplicate row must never shadow (that would let them create a second BidBoard project). Guards that strictly need the bidboard row use the `getBidboard*` getters (hubspot-bidboard-trigger and the webhook portfolio self-heal do).

## Rollout (single PR + a 2-step manual migration)

1. **Merge the PR.** Safe immediately: getters become deterministic; `createSyncMapping` upserts if the index exists, else falls back to a plain insert. No prod dependency.
2. **You run** (per the prod-write rule): dry-run `db:migrate-sync-mappings-dedupe` → review the plan + `.audit/` snapshot → re-run with `--commit` (removes ~153 rows).
3. **You run** `CI=1 npm run db:push` → creates the two partial unique indexes (safe now that dupes are gone).

Merge order and step order are both non-fatal by construction (fallback + `IF NOT EXISTS` + idempotent dedup).

## Error handling & safety
- Dedup: transactional, dry-run default, `--commit` gate, `.audit/` snapshot, idempotent; fail-CLOSED (skip + report + non-zero exit in `--commit`) on an ambiguous cluster (>1 distinct bidboard/portfolio id, >1 distinct real `(source_system, source_deal_id)`, or an uncohabited bidboard+portfolio pair).
- Upsert: additive fill-only patch; refreshes telemetry only when supplied; race-safe on `23505`; never clobbers lineage/identity/metadata.
- Constraint: `db:push` is manual and preceded by dedup, so it can never truncate live data.

## Testing (vitest + PGlite, mirrors existing suite)
- Dedup: survivor selection (lineage → real-source → lowest id); COALESCE merge never overwrites a survivor non-null; ambiguity guards (lineage, cross-lineage, source, cross-system); idempotent second run = 0 changes; dry-run writes nothing.
- Constraint: a second non-blank `procore_project_id` insert is rejected; null/blank rows unaffected.
- `createSyncMapping` plain insert throws on a dup procore id (ownership); `upsertSyncMappingByProcoreProject` links/fills (companycam, telemetry-preserve, source-migration incl. cross-column, no-index, race).
- Getters: deterministic bidboard-first ordering with multiple candidate rows.
- Regression: full suite shows no NEW failures vs the established baseline.

## Out of scope (deliberate)
- `procore_project_number` uniqueness (legitimately shared by bb + pf rows).
- Retiring the dead `project_phase` column (unrelated churn).
- **DB-level cross-column uniqueness** (same id in `procore_project_id` on one row and `portfolio_project_id` on another). The write paths now check both columns (the upsert lookup), which covers the CompanyCam/procore-sync writers; a residual path — `transitionToPortfolio()` stamping a portfolio id that duplicates a pre-existing procore-only row — is a cross-row reconciliation concern for **#3** (a generated-column unique index would risk false collisions on legitimately transitioned rows that carry the id in both columns).
- The reconciler (#3) and the 2-deal backfill (#4).
