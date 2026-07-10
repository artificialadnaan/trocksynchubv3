# Existence gate live-confirm: relevance-ranked top-N — Design

**Status:** approved by Adnaan (chose top-N, 2026-07-10) · **Supersedes** the paginate-to-completeness approach (PR #55) · **Follows:** #54 v1.0 fix

## Why (deadlock found re-triggering after #55)

PR #55 (paginate the fuzzy `filters[search]` to completeness) was correct in principle but **infeasible in prod**: Procore's `filters[search]=DFW-1-14126-ag` is fuzzy and returns **>2500** loose matches (it matches the `DFW` token across the whole company). The scan hit the 25-page bound, so the matcher honestly returned "incomplete → unknown" and the gate fail-closed — reason `search exceeded 25-page bound`. Net: the create is still blocked for **every** Dallas deal (any `DFW-*` number floods the same way), just with an honest reason instead of a false one. Completeness cannot be reached against a search that returns thousands.

## Fix — read the relevance-ranked top-N, exact-match within it

Procore's `filters[search]` is **relevance-ranked**: an exact `project_number` match ranks at the top. The codebase already relies on this — the sibling matcher at `bidboard.ts:1860` reads only the **top 5** and exact-matches to find a project. The live-confirm adopts the same, with a wide safety margin:

- `liveConfirmByNumber`: a **single** fetch of the top-N — `filters[search]=<number>&per_page=LIVE_SEARCH_TOP_N` (`300`) — then `matchLiveProjects`. No pagination loop (enumeration is infeasible). Timeout race + fail-closed on non-ok / non-array / error / timeout unchanged.
- `matchLiveProjects(projects, number, excludeId)` — the 4th `complete` param from #55 is **removed**. Logic: non-array → unknown; `>1` distinct exact ids (excl. bidboard id) → unknown (ambiguous); exactly 1 → `exists:true`; **0 → `exists:false`** (not in the top-N relevance window → does not exist → create).

## Tradeoff (accepted)

`0 exact in top-N → create` trusts that Procore ranks an existing exact match into the top-N. If it ranked one below N=300, a duplicate could be created. This is the **same assumption the codebase already makes** (`bidboard.ts:1860`, top-5); N=300 is a 60× margin. It's the deliberate, Adnaan-approved trade to unblock creates, replacing the correct-but-unusable completeness requirement. Every *other* uncertain path still fails closed (>1 exact, non-ok, non-array, error, timeout), and the archived-inclusive `procore_projects` cache path (checked first) is untouched.

## Testing (vitest)
- Matcher: exact-in-top-N → true; **wide fuzzy window with no exact → false** (the fix); one exact amid 300 fuzzy → true; `>1` distinct exact → unknown; exclude-bidboard / same-id / non-array / `number`-field preserved. (24/24.)
- Resolver + gate tests unchanged (mock `liveConfirmByNumber`).
- Regression: no NEW failures vs baseline; tsc clean.

## Out of scope
- A precise Procore exact-number filter (none exists in this API surface today) — would retire the ranking assumption; revisit if Procore adds one.
- The last stuck deal `DFW-1-14126-ag` (District at Boynton) resolves by re-triggering once this deploys.
