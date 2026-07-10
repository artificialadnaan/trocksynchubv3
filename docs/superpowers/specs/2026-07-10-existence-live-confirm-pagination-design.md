# Existence gate live-confirm: paginate to completeness — Design

**Status:** self-approved (Adnaan authorized full autonomy, 2026-07-10) · **Fixes:** the fuzzy-search page-cap false-abort exposed after PR #54 (v1.0) · **Follows:** #1 existence gate, #54 v1.0 fix

## Problem (observed in prod, 2026-07-10)

PR #54 fixed the original `/rest/v1.1` → `/rest/v1.0` 404 (proven: the gate's abort reason changed from `"procore 404"` to `"search page at cap (20)"`). But that surfaced a **second fail-closed condition** that false-aborts the create path for essentially every Dallas deal:

- The live-confirm calls `/rest/v1.0/companies/{id}/projects?filters[search]=<number>`. Procore's `filters[search]` is a **fuzzy** full-text search, so searching `DFW-1-14126-ag` matches the **`DFW`** token and returns a **full page of 20** (there are ~296 `DFW-*` projects).
- `matchLiveProjects` has a guard: `projects.length >= pageCap (20) → unknown` ("a match could be on a later page"). A saturated fuzzy page trips it, so the gate aborts **even though the exact number has 0 matches** and the correct action is `create`.

Prod evidence: bidboard `562949955804180` (`DFW-1-14126-ag`) aborts with reason `search page at cap (20)`; **0** exact matches in the archived-inclusive `procore_projects` cache; **296** `DFW-*` projects exist.

## Fix — read every page, then decide

Make the live-confirm **authoritative** by paginating the keyed search to completeness instead of guessing from a single truncated page. The page-cap *guess* becomes a completeness *fact*.

### `liveConfirmByNumber` (driver, does I/O)
Mirror the codebase's canonical paginator (`procore.ts:153` `fetchProcorePages`): loop `page=1..`, `per_page=100`, accumulate; stop when a page returns `< per_page` rows (**complete** — last page seen) or empty. Bound the loop at `LIVE_SEARCH_MAX_PAGES = 25` (2500 fuzzy matches — far beyond any real project-number search); if the bound is hit without exhausting, the scan is **incomplete**. The whole operation stays inside the existing `LIVE_CONFIRM_TIMEOUT_MS = 15000` `AbortController` race (now bounds N sequential fetches, not one). Any non-ok / non-array / thrown → `unknown` (unchanged, fail-closed). Pass the accumulated set **and the `complete` flag** to the pure matcher.

### `matchLiveProjects` (pure) — convention shift
Its 4th parameter changes from `pageCap: number` to **`complete: boolean`** (default `true`). New logic, in order:
1. non-array → `unknown`.
2. `> 1` DISTINCT exact-number ids (excluding the source bidboard id) → `unknown` (genuine ambiguity — regardless of completeness).
3. `!complete` → `unknown` (we hit the page bound; an exact match could be on an unread page — can't assert existence *or* uniqueness).
4. exactly 1 → `exists:true` (`source:"live"`).
5. 0 → `exists:false` (safe to create) — **this is the fix**: a complete scan with no exact match no longer fails closed just because the raw (fuzzy) result set is large.

The old `projects.length >= pageCap → unknown` guard is **removed** — completeness now comes from the driver having read every page, not from inferring truncation off one page.

## Safety
- Still **fail-closed** on every uncertain path: >1 exact match, incomplete scan (bound hit), non-ok/non-array/error, timeout.
- The only *new* success path is `0 exact across a complete scan → create` — which is exactly the state that should create.
- Duplicate risk is *lower* than before, not higher: an incomplete scan (the only way to under-count) still fails closed; we only assert `false` after reading every page.
- Cache path (archived-inclusive, `getProcoreProjectsByNumber`) is untouched; live-confirm remains the cache-miss recently-created backstop.

## Testing (vitest, mirrors `tests/portfolio-existence-resolver.test.ts`)
- Pure matcher: full page of fuzzy non-matches + `complete=true` → `false` (the DFW-flood regression); one exact amid fuzzy noise + `complete=true` → `true`; `complete=false` (any count) → `unknown`; `>1` exact → `unknown` even when complete; exclude-bidboard / same-id / non-array / `number`-field fallbacks preserved.
- Resolver + gate tests unchanged (they mock `liveConfirmByNumber`).
- Regression: no NEW failures vs baseline; tsc clean.

## Out of scope
- Pagination of `liveConfirmByNumber`'s own I/O is covered by the matcher's `complete` contract + a thin integration check; no live Procore call in unit tests (env-split; same as today).
- The 8 already-portfolio'd stuck deals (self-heal stamp) — separate backfill, not this PR.
