# Existence gate: respect an existing portfolio link — Design

**Status:** approved by Adnaan (2026-07-10) · **Follows:** #56 top-N live-confirm

## Why

The existence gate resolves by **exact project number** (cache → live). It cannot see a portfolio recorded under a **different** number — i.e. a **rebuild** (the same real project re-bid under a new number). Real case: `District at Boynton` (`DFW-1-14126-ag`) is a rebuild of `The District Boynton` (`DBTDBPAINT`, portfolio `598134326608331`); the gate returns `create` and would build a duplicate. We manually linked it (`sync_mappings.portfolio_project_id`). This change makes that manual link — and every prior self-heal — **durable going forward**: a re-trigger must not re-create.

Adnaan's call: **no fuzzy secondary duplicate check** (name/customer/value). Just honor an existing link.

## Change (one place, `handlePortfolioCreateGate`)

Before the number-based resolve, look up the deal's mapping; if `portfolio_project_id` is already set (non-blank), **short-circuit to `skip`** with that id and `existence.source: "mapping"` — the stored link is authoritative. The self-heal path (only reached when the top lookup was unlinked) **re-reads the mapping fresh** before writing, so a link set concurrently during the networked resolve is never clobbered; if that fresh read is now linked, its value is returned as authoritative. So there are two reads on the resolve-then-self-heal path, by design. `PortfolioExistenceResult`'s `exists:true` source gains `"mapping"`.

Everything else is unchanged: not-yet-linked deals still resolve by number (cache/live), self-heal on same-number hits, create on genuine absence, fail closed on uncertainty. The runner (`portfolio-automation.ts`) needs no change — it already treats `skip` as "don't add to portfolio."

## Safety
- Strictly *reduces* duplicate risk: an already-linked deal can no longer be re-created.
- A blank/whitespace `portfolio_project_id` does NOT short-circuit (falls through to the resolve).
- A mapping-lookup error **fails closed**: existence → `unknown` → `abort` + the existing audit alert, WITHOUT falling through to the number-based resolve (which could create a duplicate for an already-linked rebuild whose only signal is the stored link). Does not rely on the runner's separate upstream lookup.
- Self-heal re-reads the mapping fresh before writing, so a concurrently-set `portfolio_project_id` is never clobbered.
- **Phase-2 identity check (companion fix in `detectPortfolioIdentityMismatch`) — durable marker, not plumbing:** Phase 2 re-validates the resolved portfolio's NUMBER against the deal/trigger number, which would `quarantine` + throw on a cross-number rebuild (the linked portfolio's number intentionally differs). Fix: skip the number/name/hubspot checks **only when** the reached portfolio is the mapping's explicit link (`expectedPortfolioProjectId === actual`) **AND** the mapping carries a durable `metadata.manualPortfolioOverride` marker. `buildExpectedPortfolioIdentity` reads that marker (it already loads the mapping) into `expected.portfolioFromExistingLink`, so **every** Phase-2 consumer — direct chain, both webhook branches, and the orphan failsafe — derives it identically with **no per-caller plumbing**. The marker is set ONLY by a deliberate manual cross-number link (the Boynton backfill; a future manual-link UI). A fresh create, a same-number **self-heal**, and a **concurrently-linked** row never carry it, so their number/name/hubspot checks still fire and catch a wrong portfolio. (Supersedes an earlier plumbed `portfolioFromExistingLink` flag that was too broad — it treated self-heal + concurrent links as authoritative and had to be threaded to each consumer.)
- Edge (accepted): a linked deal with a *blank* `procore_project_number` fails closed at the runner's pre-gate blank-number check before reaching this guard — safe (no create), just not a clean skip. Rare; linked deals carry a number.

## Testing (vitest)
- New: already-linked mapping → `skip` via the guard WITHOUT calling the Procore resolve (`getProcoreProjectsByNumber`/`liveConfirmByNumber` not called), `source: "mapping"`, no redundant self-heal write.
- New: blank `portfolio_project_id` → falls through → `create`.
- Existing self-heal / create / abort / matcher tests unchanged. Full suite + tsc at baseline.
