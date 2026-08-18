/**
 * Kill switch for the CRM activity-note automation.
 * =================================================
 *
 * DEFAULT OFF. The note step is skipped entirely — no login, no navigation, no selector lookup —
 * unless `BIDBOARD_NOTES_ENABLED=true`.
 *
 * Why this exists: every `precise` selector in PROCORE_SELECTORS.bidboard.newUi.notes is written from
 * Procore's published documentation, not from observed DOM. In production they miss, so the step
 * declines — but it declines only AFTER navigating to the project and spending up to
 * SECTION_TIMEOUT_MS looking for a Notes card, and it does that while holding the GLOBAL browser lock.
 * Every Bid Board create pays that cost, and exports, other creates and the portfolio automation queue
 * behind it. "Inert" has to mean zero work, not "wasteful and then declines".
 *
 * Intended sequence:
 *   1. run POST /api/testing/playwright/bidboard-project-note against a real project (the prober);
 *   2. substitute the real `aid-*` / `data-qa` hooks it reports into selectors.ts;
 *   3. set BIDBOARD_NOTES_ENABLED=true.
 *
 * The PROBER IS DELIBERATELY NOT GATED BY THIS FLAG — it is how step 1 happens, and gating it would
 * make the flag unflippable. That asymmetry is the point: the prober is human-invoked, deliberate, and
 * one project at a time; the automation runs unattended on every create.
 *
 * This lives in its own module so `bidboard.ts` can import it statically. `bidboard-notes.ts` imports
 * `navigateToProject` from `bidboard.ts`, so importing the flag from there would close an import cycle
 * — which is also why the note module itself is loaded via a dynamic import at the call site.
 *
 * Mirrors the CRM side, where the Bid Board due-date read-back ships behind
 * BID_BOARD_DUE_DATE_READBACK (default OFF) for the same reason, and the repo's existing
 * SYNC_MAPPINGS_RECONCILE_ENABLED idiom.
 *
 * @module playwright/bidboard-notes-flag
 */

export const BIDBOARD_NOTES_ENABLED_ENV = "BIDBOARD_NOTES_ENABLED";

/**
 * True only for an explicit "true". Takes `env` as a parameter for testability, matching the CRM's
 * feature-flag helpers.
 */
export function isBidBoardNotesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BIDBOARD_NOTES_ENABLED_ENV] === "true";
}
