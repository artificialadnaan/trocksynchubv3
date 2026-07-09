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

- **Cluster key:** `procore_project_id` (non-null). Plus exact-duplicate clusters where `procore_project_id IS NULL` but every identity field is identical (defensive; expected count ~0).
- **Survivor selection (per cluster):** the row bearing a `bidboard_project_id` or `portfolio_project_id` if any exists (there are none today, but the rule keeps the lineage row if a future cluster has one) → else the **lowest `id`**.
- **Merge:** `COALESCE` every non-null scalar field from the deleted siblings **into** the survivor (never overwrite a survivor non-null with a sibling value), then delete the siblings.
- **Safety:** whole run in one transaction; prints a full before/after census + per-cluster plan; writes a JSON snapshot to `.audit/`; `--commit` required to write; re-runnable (idempotent — a deduped table yields 0 changes).
- Registered as `db:migrate-sync-mappings-dedupe` and inserted **before** `db:push` in the documented Dockerfile migration chain.

### 2. Partial unique indexes — `shared/schema.ts`
Add to the `syncMappings` table definition, mirroring the existing `idx_sync_mappings_bidboard_project_id`:
```ts
uniqueIndex("idx_sync_mappings_procore_project_id").on(table.procoreProjectId).where(sql`procore_project_id IS NOT NULL`),
uniqueIndex("idx_sync_mappings_portfolio_project_id").on(table.portfolioProjectId).where(sql`portfolio_project_id IS NOT NULL`),
```
Applied in prod by `CI=1 npm run db:push` **after** the dedup script (established ordering). Not created on merge — deploy does not auto-push.

### 3. Idempotent insert — `storage.createSyncMapping`
Switch the plain `insert` to `onConflictDoUpdate`, arbiter = the partial `procore_project_id` unique index (`target: procoreProjectId`, `targetWhere: sql\`procore_project_id IS NOT NULL\``). The `SET` updates only the sync-owned fields (name, number, `procore_company_id`, `last_sync_*`, `metadata`); it never overwrites `bidboard_project_id` / `portfolio_project_id`.

- Rows with `procore_project_id IS NULL` (e.g. fresh bidboard rows) fall outside the partial index → insert unchanged, so the `bidboard_project_id` ownership-guard throw at `bidboard.ts:2148` is **preserved**.
- **Order-independence (no-babysit safety):** if the arbiter index does not yet exist, Postgres raises `42P10`. `createSyncMapping` catches `42P10` **once** and falls back to a plain insert (prior behaviour). So the PR is safe to merge before `db:push` runs — idempotency simply activates the moment the index exists.

### 4. Deterministic getters — `storage.ts`
Add a canonical `ORDER BY` to `getSyncMappingByProcoreProjectId`, `getSyncMappingByProcoreProjectNumber`, `getSyncMappingBySourceDealId` (and the bidboard-filtered number getter): prefer a row bearing `portfolio_project_id`, then `bidboard_project_id`, then most-recent `last_sync_at`, then lowest `id`. Deterministic even during the pre-dedup window and for the permanently-non-unique number key.

## Rollout (single PR + a 2-step manual migration)

1. **Merge the PR.** Safe immediately: getters become deterministic; `createSyncMapping` upserts if the index exists, else falls back to a plain insert. No prod dependency.
2. **You run** (per the prod-write rule): dry-run `db:migrate-sync-mappings-dedupe` → review the plan + `.audit/` snapshot → re-run with `--commit` (removes ~153 rows).
3. **You run** `CI=1 npm run db:push` → creates the two partial unique indexes (safe now that dupes are gone).

Merge order and step order are both non-fatal by construction (fallback + `IF NOT EXISTS` + idempotent dedup).

## Error handling & safety
- Dedup: transactional, dry-run default, `--commit` gate, `.audit/` snapshot, idempotent, fail-loud if a cluster's survivor is ambiguous.
- Insert: `42P10` fallback; never clobbers lineage ids.
- Constraint: `db:push` is manual and preceded by dedup, so it can never truncate live data.

## Testing (vitest + PGlite, mirrors existing suite)
- Dedup: survivor selection (lineage row wins, else lowest id); COALESCE merge never overwrites a survivor non-null; idempotent second run = 0 changes; dry-run writes nothing.
- Constraint: a second non-null `procore_project_id` insert is rejected; null `procore_project_id` rows are unaffected.
- Insert: upserts on conflict (merges sync fields, preserves bb/pf); `42P10` → plain-insert fallback.
- Getters: deterministic ordering with multiple candidate rows.
- Regression: full suite shows no NEW failures vs the established baseline.

## Out of scope (deliberate)
- `procore_project_number` uniqueness (legitimately shared by bb + pf rows).
- Retiring the dead `project_phase` column (unrelated churn).
- The reconciler (#3) and the 2-deal backfill (#4).
