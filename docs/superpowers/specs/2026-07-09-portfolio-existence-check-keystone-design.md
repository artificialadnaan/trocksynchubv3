# Portfolio Existence-Check Keystone — Design

**Goal:** Make "does a Procore portfolio already exist for this deal?" an authoritative, Procore-truth-backed
question, and use it as the create-gate in the Bid Board → Portfolio automation — so the automation can never
create a duplicate portfolio, and self-heals the DB when a portfolio already exists but wasn't recorded.

**Architecture:** A pure resolver (cache-first, live-confirm) returns a discriminated existence result; the
Phase-1 create path gates the "Add to Portfolio" action on it (skip + heal / create / fail-closed to manual
review); a self-heal write-back records the found portfolio id.

**Tech stack:** TypeScript, Playwright automation (`server/playwright/portfolio-automation.ts`), Drizzle/
Postgres (`server/storage.ts`, `procore_projects` + `sync_mappings`), Procore REST v1.0, vitest.

---

## Why (the root cause)

Every recent problem in this area flows from one gap: **nothing can authoritatively answer "does this deal
already have a Procore portfolio?"**

- The automation's only pre-create guard is `isProjectAlreadyInPortfolio` (`portfolio-automation.ts:910`), a
  Procore **UI** button-visibility check. It uses a stricter selector (`.first()`) than the click path
  (`findMenuItem`, broader selector, iterates all, different casing), so on any DOM/casing/render drift it
  wrongly returns "not in portfolio" → the click still finds "Add" → **duplicate Procore project**.
- There is **no Procore API existence check** before creating (`server/procore.ts` has fetch-by-id and a bulk
  active-projects list, but no by-number resolver).
- `wait_portfolio_creation`'s catch does not re-throw, so a portfolio can **exist in Procore but be null in our
  DB** — a state where the only guard (the UI check) is the sole defense.

This is also why the census over-counted: the DB "no portfolio" signal is split across two columns
(`portfolio_project_id`, `procore_project_id`) written by different paths, and `sync_mappings.procore_project_
number` is non-unique (fans out up to 25×), so "does a portfolio exist" is a `bool_or` guess.

This is item **#1** of the ordered complete fix: **#1 existence-check/create-gate (this spec)**, then #2
canonical DB truth, #3 reconciler, #4 backfill. #1 is the keystone every later item depends on.

## Locked decisions (from design review)

1. **Fail-closed on an indeterminate check.** If we cannot confirm whether a portfolio exists (Procore API
   error / indeterminate), the automation **does not create** — it aborts and routes the deal to manual review
   + alert. A stranded create (visible + retryable) is strictly safer than an invisible duplicate. Matches the
   #50 loud-guard philosophy.
2. **Exact project-number matching only.** Match a deal to an existing Procore project on an **exact**
   `procore_project_number` equality. No fuzzy/name matching — a false-positive match would wrongly skip a
   legitimate create (deal never gets its portfolio). A portfolio whose number drifted simply falls through to
   the create path, where the existing post-create identity/quarantine guard
   (`validatePortfolioProjectIdentityOrThrow`) still protects against a wrong link.

## Components

### 1. Resolver — `resolveExistingPortfolioProject`
A pure, independently-testable function (no Playwright dependency).

```
resolveExistingPortfolioProject(input: {
  companyId: string;
  procoreProjectNumber: string;
}, deps?: { … storage / procore fetch injectable for tests }): Promise<PortfolioExistenceResult>

type PortfolioExistenceResult =
  | { exists: true; portfolioProjectId: string; source: "cache" | "live" }
  | { exists: false }
  | { exists: "unknown"; reason: string };   // fail-closed downstream
```

Logic:
1. **Cache first:** look up `procore_projects` by exact number via a new
   `storage.getActiveProcoreProjectByNumber(companyId, procoreProjectNumber)`. Hit → `{ exists: true, source:
   "cache" }`.
2. **Cache miss → one live confirm** (the dangerous case is a stale-negative → duplicate): query Procore's
   active company projects for that number. Authoritatively found → `{ exists: true, source: "live" }`.
   Authoritatively not found → `{ exists: false }`. API error / indeterminate → `{ exists: "unknown" }`.
3. The resolver **never throws** — it reports uncertainty as `"unknown"` so the caller decides policy.

Guardrails:
- A blank/empty `procoreProjectNumber` → `{ exists: "unknown", reason: "no project number" }` (fail-closed;
  we cannot match without the canonical key).
- `procore_project_number` is the deal's canonical Procore number; it is expected to carry from the Bid Board
  project to the Portfolio project. If verification during implementation shows it does not always carry,
  that is documented as a known limitation and those deals fall through to create + the post-create guard.

### 2. Create-gate — in `runPhase1BidBoardActions` (before the add-to-portfolio click, `~:1013`)
Call the resolver, then:
- `exists: true` → **skip the create**; run the self-heal write-back (Component 3); continue Phase 1 using the
  existing portfolio (the code already has a `shouldSkipAddToPortfolio` path that recovers the existing id).
- `exists: false` → **create** as today. Keep the existing UI `isProjectAlreadyInPortfolio` check as a cheap
  secondary belt-and-suspenders (both must say "doesn't exist" to click Add).
- `exists: "unknown"` → **fail-closed**: do not click Add; abort the create with a distinct non-success
  outcome so `runPhase1WithRetry` / verification does **not** mark it "done" (it stays retryable).
  - **Alert (primary loud signal):** the gate writes an `audit_logs` row with `status='error'` directly — the
    automation already writes `audit_logs` for phase results (`~:2585`), so this is in-layer and is exactly
    what the 15-min failure digest (`cron/alertScheduler.ts`) scans. This is the required loud signal.
  - **Manual-review row (layering note):** #50's `handlePortfolioTriggerSkip` lives in the stage-sync layer
    and its `manual_review_queue` dedup is keyed on `(projectNumber, cycleId)`; `runPhase1BidBoardActions`
    (Playwright layer) has no stage-sync `cycleId`. The plan must resolve this rather than reach across layers.
    Default: write the `audit_logs` alert here, and enqueue the `manual_review_queue` row with a synthetic,
    stable key (e.g. `cycleId = "existence-check"`) via the cross-cycle-unresolved dedup added in #50
    (`getUnresolvedManualReviewQueueEntry` — already cycle-independent), so a stuck deal produces one review
    row, not one per attempt. If that proves awkward, the fallback is audit-alert-only (still loud + retryable)
    and the reconciler (#3) owns the queue row — decide in the plan.

### 3. Self-heal write-back
When the resolver returns `exists: true`, write `portfolio_project_id` onto the bidboard-bearing sync mapping
if unset (mirrors the existing write-back at `portfolio-automation.ts:1213-1224`, which only writes
`portfolio_project_id`). This heals "exists-in-Procore-but-null-in-DB" rows during normal operation. The
canonical multi-column write (also stamping `procore_project_id` / `sent_to_portfolio_at` / `project_phase`)
is deliberately **deferred to #2** to keep this change focused.

## Data flow

```
transition / backfill
  → runPhase1WithRetry → runPhase1BidBoardActions
      → resolveExistingPortfolioProject(companyId, procoreProjectNumber)
          exists:true    → self-heal write-back → skip Add → continue Phase 1
          exists:false   → (UI check) → click Add → create → write-back
          exists:unknown → abort → manual_review_queue + audit_logs error alert (fail-closed)
```

## Error handling

- Resolver: total-function — every failure path maps to `false` or `"unknown"`, never an uncaught throw.
- Gate: `"unknown"` is the only fail-closed branch; it must NOT create, must record a manual-review + alert,
  and must return a non-success outcome so retries/verification treat it as unresolved.
- The live confirm is subject to Procore rate limiting; reuse the existing `fetchWithRateLimitRetry` /
  rate-limit-tracker path (as `fetchPortfolioProjectIdentity` does).

## Testing

- **Resolver unit tests** (vitest, storage + procore-fetch mocked): cache hit → true/cache; cache miss + live
  hit → true/live; cache miss + live not-found → false; cache miss + live error → unknown; blank number →
  unknown.
- **Gate tests**: `exists:true` → no Add click + write-back called; `exists:false` → proceeds to create;
  `exists:"unknown"` → no Add click + manual-review row + `status='error'` audit written + non-success result.
- Mirror the existing `tests/bidboard-to-portfolio.test.ts` storage-mock harness.

## Boundaries / isolation

- The resolver is a self-contained unit: input (companyId + number + injectable deps), output (discriminated
  result), no Playwright/browser dependency — fully unit-testable.
- The gate is the single integration point inside `runPhase1BidBoardActions`.
- The self-heal write-back is a one-liner reusing the existing `updateSyncMapping` pattern.

## Scope

**In #1:** the resolver, the create-gate (skip/create/fail-closed), the self-heal write-back of
`portfolio_project_id`, `storage.getActiveProcoreProjectByNumber`, and tests.

**Deferred:** #2 canonical multi-column DB truth + `sync_mappings` dedup; #3 reconciler job; #4 the 2-deal
backfill. Each is its own spec → plan → PR.

## Risks / open items

- **Number carry-over:** confirm during implementation that `procore_project_number` is the same on the Bid
  Board project and its Portfolio project. If not always, the mismatched ones fall through to create + the
  existing post-create identity/quarantine guard (acceptable, documented).
- **Live-confirm cost:** fetching active projects to confirm a single number is heavier than a keyed lookup;
  prefer a keyed/filtered Procore query if available, else bounded fetch. The create is infrequent, so this is
  acceptable; note it in the plan.
- **Prod-critical path:** this changes the automation's create gate. Ship behind the same rigor as #50
  (pre-PR adversarial review; SyncHub has no CI gate but CodeRabbit/Macroscope auto-run + Codex on trigger).
  Adnaan merges.
