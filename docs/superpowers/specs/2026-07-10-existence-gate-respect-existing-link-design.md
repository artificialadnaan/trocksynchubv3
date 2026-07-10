# Existence gate: respect an existing portfolio link — Design

**Status:** approved by Adnaan (2026-07-10) · **Follows:** #56 top-N live-confirm

## Why

The existence gate resolves by **exact project number** (cache → live). It cannot see a portfolio recorded under a **different** number — i.e. a **rebuild** (the same real project re-bid under a new number). Real case: `District at Boynton` (`DFW-1-14126-ag`) is a rebuild of `The District Boynton` (`DBTDBPAINT`, portfolio `598134326608331`); the gate returns `create` and would build a duplicate. We manually linked it (`sync_mappings.portfolio_project_id`). This change makes that manual link — and every prior self-heal — **durable going forward**: a re-trigger must not re-create.

Adnaan's call: **no fuzzy secondary duplicate check** (name/customer/value). Just honor an existing link.

## Change (one place, `handlePortfolioCreateGate`)

Before the number-based resolve, look up the deal's mapping; if `portfolio_project_id` is already set (non-blank), **short-circuit to `skip`** with that id and `existence.source: "mapping"` — the stored link is authoritative. The mapping lookup is reused for the existing self-heal write (one lookup, not two). `PortfolioExistenceResult`'s `exists:true` source gains `"mapping"`.

Everything else is unchanged: not-yet-linked deals still resolve by number (cache/live), self-heal on same-number hits, create on genuine absence, fail closed on uncertainty. The runner (`portfolio-automation.ts`) needs no change — it already treats `skip` as "don't add to portfolio."

## Safety
- Strictly *reduces* duplicate risk: an already-linked deal can no longer be re-created.
- A blank/whitespace `portfolio_project_id` does NOT short-circuit (falls through to the resolve).
- A mapping-lookup error is swallowed here and falls through to the Procore resolve; the runner already fails closed on its own lookup error upstream, so the create is still gated.
- Edge (accepted): a linked deal with a *blank* `procore_project_number` fails closed at the runner's pre-gate blank-number check before reaching this guard — safe (no create), just not a clean skip. Rare; linked deals carry a number.

## Testing (vitest)
- New: already-linked mapping → `skip` via the guard WITHOUT calling the Procore resolve (`getProcoreProjectsByNumber`/`liveConfirmByNumber` not called), `source: "mapping"`, no redundant self-heal write.
- New: blank `portfolio_project_id` → falls through → `create`.
- Existing self-heal / create / abort / matcher tests unchanged. Full suite + tsc at baseline.
