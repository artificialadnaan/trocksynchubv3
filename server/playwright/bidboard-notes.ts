/**
 * Playwright BidBoard Notes Module
 * ================================
 *
 * Posts a single Note on a Procore Bid Board project — today that is the CRM activity log the CRM
 * ships with the RFP body (`deal.crmActivityLog` → `dealData.crm_activity_log`), so the estimator
 * opening the project sees the sales history the rep logged in the CRM.
 *
 * Where the note goes:
 * Procore Bid Board projects have a Notes section on the project's OVERVIEW tab — add via a "+"
 * control, plain text (URLs auto-link, "@" opens a mention picker), saved with a "Create" button,
 * edited/deleted via a vertical-ellipsis menu. This is NOT the Project Description field, which
 * keeps carrying the deal description only.
 *
 * ⚠️ The selectors this module drives (PROCORE_SELECTORS.bidboard.newUi.notes) are written from
 * Procore's published documentation, NOT from observed DOM — see the comment on that block. The
 * prober route POST /api/testing/playwright/bidboard-project-note is how they get validated against
 * a real project, and it must be run before this ships.
 *
 * Because the selectors are unverified, the module is written to FAIL CLEAN rather than to try hard.
 * Four invariants:
 *
 * 1. NEVER TOUCH THE WRONG FIELD. The Project Description textarea lives on this same page — the
 *    description-verify retry in bidboard.ts resolves it with a bare `textarea`. So: the automation
 *    acts only on `precise`/`scopedOnly` selector tiers (never the `loose` ones), the resolved Notes
 *    container is rejected if it also contains the description field or a Create New Project button,
 *    and the fill target is re-checked by attribute immediately before typing. Any doubt ⇒ refuse.
 * 2. IDEMPOTENT. Every CRM note starts with the `CRM Activity Log —` marker; the existing notes are
 *    read first and the step skips when the marker is already present in this project's Notes.
 *    Without it a retry, an ADOPTED pre-existing project, or a duplicate create command stacks copies
 *    of the same ~8 KB note.
 * 3. LEAVES THE PAGE CLEAN. Once anything has been typed, every exit path cancels the editor. The
 *    page is shared: the document sync runs on it next, under the same browser lock.
 * 4. NEVER THROWS. Every exit is a result object. Posting a note is strictly less important than
 *    creating the project (see the fail-open wrapper in createBidBoardProjectFromDeal).
 *
 * @module playwright/bidboard-notes
 */

import type { Locator, Page } from "playwright";
import { PROCORE_SELECTORS } from "./selectors";
import { randomDelay, takeScreenshot } from "./browser";
import { navigateToProject } from "./bidboard";
import { log } from "../index";

/**
 * The idempotency marker. PROJECT-SCOPED: Procore's Notes are already per-project, so matching the
 * literal prefix inside THIS project's notes is all the discrimination needed.
 *
 * Deliberately does NOT include the project number. Keying on the number was wrong twice over: a
 * substring compare made `DFW-4-16226-a` match an existing `DFW-4-16226-ab` note (and skip), and the
 * CRM's heading label and the payload's `projectNumber` don't always agree — the CRM falls back to the
 * deal NAME when a deal has no display number, while the payload falls back to a UUID, so a
 * number-keyed guard could never match for HubSpot-imported "Pending" deals and would post a duplicate
 * on every run. The human-readable label stays in the note's heading; the guard just doesn't use it.
 */
export const CRM_ACTIVITY_NOTE_MARKER = "CRM Activity Log —";

// Timeouts are per-interaction rather than one big wrapper, because abandoning an in-flight Playwright
// action (e.g. by racing a timer) would leave the shared page in an unknown state for the document sync
// that runs after. OVERALL_TIMEOUT_MS is the backstop: it is checked BETWEEN steps, so it bounds the
// total time this holds the browser lock without ever abandoning an action mid-flight. The per-call
// timeouts alone sum to minutes on a page where nothing matches.
const SECTION_TIMEOUT_MS = 15000;
const CONTROL_TIMEOUT_MS = 10000;
const VERIFY_TIMEOUT_MS = 10000;
const OVERALL_TIMEOUT_MS = 90000;

/**
 * Defensive cap applied immediately before typing. The CRM already caps the note (MAX_NOTE_CHARS), but
 * this module is the last hop before a real Procore field and does not get to assume the other side
 * behaved — a runaway payload should be truncated here, not pasted into Procore.
 */
export const NOTE_HARD_CHAR_CAP = 10000;

export interface PostBidBoardNoteResult {
  /** True only when the note was typed, saved, and seen on the page afterwards. */
  posted: boolean;
  /** True when an equivalent note already existed (idempotency guard) — NOT a failure. */
  skipped: boolean;
  error?: string;
  /**
   * Which selector candidate matched at each step. Logged and returned so a selector change shows up
   * as "we fell through to the scopedOnly tier" instead of silently degrading until it breaks.
   */
  matched?: Record<string, string>;
}

/** Collapse whitespace and unify dash characters so a marker comparison survives re-rendering. */
function normalizeForMarkerMatch(value: string): string {
  return (value || "")
    .replace(/[‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when any of this project's rendered note texts already carries the marker.
 *
 * A CONTAINS check, not starts-with: a rendered note row wraps the body in author/date chrome, so the
 * marker rarely sits at character 0. The asymmetry is intentional and the caller must preserve it —
 * a false positive costs one missing note, a false negative stacks another ~8 KB duplicate on the
 * project on every retry, and the adopt path re-attempts on every re-run.
 */
export function hasMarkerNote(existingTexts: Array<string | null | undefined>): boolean {
  const needle = normalizeForMarkerMatch(CRM_ACTIVITY_NOTE_MARKER);
  return existingTexts.some((text) => normalizeForMarkerMatch(text ?? "").includes(needle));
}

/** Truncate to the hard cap, keeping the marker line (which is first) intact. */
export function clampNoteForProcore(note: string): string {
  if (note.length <= NOTE_HARD_CHAR_CAP) return note;
  const suffix = "\n… (truncated)";
  return `${note.slice(0, NOTE_HARD_CHAR_CAP - suffix.length)}${suffix}`;
}

/**
 * Guarantee the posted text carries the marker, prepending the heading when it doesn't.
 *
 * The request schema accepts ANY string for `crmActivityLog`, so the CRM (or a future caller, or a
 * hand-made payload) can hand us a body with no heading. Posting that verbatim would create a REAL
 * note that neither the existing-note check nor the post-save verification can see: the submission
 * would be reported as a failure, and every adopted-project retry would submit another invisible
 * duplicate, forever. Marker-bearing text is this module's invariant, so it enforces it rather than
 * trusting the sender.
 */
export function ensureNoteMarker(note: string, projectNumber?: string | null): string {
  if (hasMarkerNote([note])) return note;
  const label = (projectNumber || "").trim();
  const heading = label ? `${CRM_ACTIVITY_NOTE_MARKER} ${label}` : CRM_ACTIVITY_NOTE_MARKER;
  return `${heading}\n\n${note}`;
}

type Scope = Pick<Page, "locator"> & Partial<Pick<Page, "getByRole">>;
type CandidateTiers = { precise: string[]; scopedOnly?: string[]; loose?: string[] };

/**
 * The candidates the automation may ACT on in this scope.
 * `loose` is never included — it is prober diagnostics only. `scopedOnly` is included only inside an
 * already-validated container (a page-wide search must not use generic selectors).
 */
function actableCandidates(tiers: CandidateTiers, scopeIsValidatedContainer: boolean): string[] {
  return scopeIsValidatedContainer && tiers.scopedOnly
    ? [...tiers.precise, ...tiers.scopedOnly]
    : [...tiers.precise];
}

async function isVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  // waitFor() gives the SPA time to render; isVisible() alone is a zero-wait snapshot and races the
  // Procore client-side render that navigateToProject only waits a couple of seconds for.
  const appeared = await locator
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (appeared) return true;
  return locator.isVisible().catch(() => false);
}

/**
 * How many matches of one selector to inspect for a visible node.
 *
 * Probing only `.first()` rejects a selector whenever its first match is a hidden node — a
 * responsive/mobile duplicate, a collapsed panel, an off-screen template — even though a perfectly
 * usable visible control exists a few nodes later. Procore's SPA renders exactly that shape, and the
 * consequence here is silent: the whole step declines and no note is ever posted.
 */
const MAX_NODES_PER_SELECTOR = 10;

/**
 * First VISIBLE node matching `selector` within `scope` — not simply the first node.
 *
 * Exported so the prober route runs the IDENTICAL walk: if it probed `.first()` while the automation
 * walks matches, it would report `visible: false` for a selector the automation uses successfully, and
 * that report is what a human reads to decide which hooks are real. The index is returned because
 * "matched at index 3" is itself the diagnostic — it means the first three matches are hidden.
 */
export async function findVisibleMatch(
  scope: Scope,
  selector: string,
): Promise<{ locator: Locator; index: number } | null> {
  let all: Locator;
  try {
    all = scope.locator(selector);
  } catch (err: any) {
    // A selector Playwright can't even parse must not take the whole step down.
    log(`[bidboard-notes] selector rejected by Playwright: ${selector} (${err?.message ?? err})`, "playwright");
    return null;
  }
  const count = await all.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, MAX_NODES_PER_SELECTOR); index++) {
    const node = all.nth(index);
    if (await node.isVisible().catch(() => false)) return { locator: node, index };
  }
  return null;
}

/**
 * Try each candidate selector in order and return the first VISIBLE match, polling until `timeoutMs`.
 *
 * Polls the whole candidate list rather than waiting on a union of it: the union wait had the same
 * hidden-first-node blind spot as `.first()` (it would sit on a hidden node for the full timeout and
 * then report nothing), and a per-candidate wait would spend the whole timeout on every wrong guess in
 * turn. One cheap pass over all candidates, repeated until the deadline, gives the SPA time to render
 * without either failure mode.
 */
async function firstVisibleAcross(
  attempts: Array<{ scope: Scope; candidates: string[] }>,
  timeoutMs: number,
): Promise<{ locator: Locator; selector: string; attemptIndex: number } | null> {
  if (attempts.every((attempt) => attempt.candidates.length === 0)) return null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    // All attempts are tried on EVERY pass, in preference order. Exhausting the whole timeout on the
    // preferred scope before even looking at the fallback would burn the budget waiting for something
    // that is never going to appear there (and, with the overall deadline, starve the later steps).
    for (const [attemptIndex, attempt] of attempts.entries()) {
      for (const selector of attempt.candidates) {
        const hit = await findVisibleMatch(attempt.scope, selector);
        if (hit) return { locator: hit.locator, selector, attemptIndex };
      }
    }
    if (Date.now() >= deadline) break;
    await randomDelay(250, 500);
  } while (Date.now() < deadline);
  return null;
}

async function firstVisible(
  scope: Scope,
  candidates: string[],
  timeoutMs: number,
): Promise<{ locator: Locator; selector: string } | null> {
  return firstVisibleAcross([{ scope, candidates }], timeoutMs);
}

/**
 * Read every candidate note text in the section, UNIONED with the container's own text.
 *
 * Never early-returns on the first candidate that yields something. The `item` list ends in a bare
 * `li`, so an unrelated list in the card (an empty-state bullet list, a menu, pagination) would
 * otherwise satisfy the loop, return unrelated strings, and suppress the container-text fallback —
 * hiding an existing note and posting a duplicate. Union means a wrong `item` match can only add
 * noise, and the marker is still found through the container's text.
 */
async function readNoteTexts(section: Locator): Promise<string[]> {
  const texts: string[] = [];
  for (const selector of PROCORE_SELECTORS.bidboard.newUi.notes.item) {
    const items = section.locator(selector);
    const count = await items.count().catch(() => 0);
    if (count > 0) {
      texts.push(...(await items.allTextContents().catch(() => [] as string[])));
    }
  }
  const sectionText = await section.innerText().catch(() => "");
  if (sectionText) texts.push(sectionText);
  return texts;
}

/**
 * Reject a "Notes section" that is really a page-sized wrapper. If the container also holds the
 * Project Description field or a Create New Project button, then every scoped search below it —
 * including "the Create button next to the editor" — is unscoped in practice.
 */
async function isPlausibleNotesSection(section: Locator): Promise<boolean> {
  const contaminated = await section
    .locator(PROCORE_SELECTORS.bidboard.newUi.notes.sectionContamination)
    .count()
    .catch(() => 0);
  return contaminated === 0;
}

/**
 * Last line of defence before typing: refuse any element whose own attributes say "description".
 * Independent of which selector matched, so it still holds if a candidate is edited carelessly later.
 */
async function isForbiddenFillTarget(locator: Locator): Promise<boolean> {
  const attrs = await Promise.all(
    ["name", "id", "aria-label", "placeholder", "data-qa"].map((attr) =>
      locator.getAttribute(attr).catch(() => null),
    ),
  );
  return attrs.some((value) => (value ?? "").toLowerCase().includes("description"));
}

/**
 * Below this much remaining budget the navigation is not even attempted. A tiny timeout would only
 * produce a guaranteed-failed `goto` (and Playwright treats 0 as "no timeout", which would be
 * unbounded), so there is nothing to gain by starting one.
 */
export const MIN_NAVIGATION_BUDGET_MS = 1000;

/**
 * Close a half-typed editor. The page is shared with the document sync that runs next under the same
 * browser lock, so an abandoned 8 KB draft must never be left sitting in it.
 */
async function cancelEditor(page: Page): Promise<void> {
  try {
    await page.keyboard.press("Escape");
    await randomDelay(300, 600);
  } catch {
    /* best effort — the caller is already on a failure path */
  }
}

/**
 * Post `note` as a Note on Bid Board project `projectId`.
 *
 * Never throws: returns `{ posted }`, `{ skipped }` (marker already present) or `{ error }`.
 * `projectNumber` is diagnostics only — the idempotency guard is project-scoped and does not key on it.
 */
export async function postBidBoardProjectNote(
  page: Page,
  projectId: string,
  note: string,
  projectNumber?: string | null,
  /**
   * Test seams (same spirit as createProject/findExistingProject in bidboard.ts) — keep suites fast
   * and deterministic. `stepTimeoutMs` overrides how long any single selector lookup polls; without
   * it a not-found path in a test would spin for the whole production budget.
   */
  options?: { verifyTimeoutMs?: number; overallTimeoutMs?: number; stepTimeoutMs?: number },
): Promise<PostBidBoardNoteResult> {
  const matched: Record<string, string> = {};
  const selectors = PROCORE_SELECTORS.bidboard.newUi.notes;
  const deadlineAt = Date.now() + (options?.overallTimeoutMs ?? OVERALL_TIMEOUT_MS);
  const outOfTime = () => Date.now() > deadlineAt;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  /** Every lookup is clamped to what's left of the overall budget, not just its own step timeout. */
  const stepBudget = (stepTimeoutMs: number) => Math.min(options?.stepTimeoutMs ?? stepTimeoutMs, remainingMs());
  const find = (scope: Scope, candidates: string[], stepTimeoutMs: number) =>
    firstVisible(scope, candidates, stepBudget(stepTimeoutMs));
  let hasTyped = false;

  /** Single exit for every failure: cancels a half-typed editor, then reports. Never throws. */
  const fail = async (message: string, screenshotName?: string): Promise<PostBidBoardNoteResult> => {
    if (screenshotName) {
      const path = await takeScreenshot(page, screenshotName).catch(() => "");
      if (path) message = `${message}; screenshot: ${path}`;
    }
    if (hasTyped) await cancelEditor(page);
    return { posted: false, skipped: false, error: message, matched };
  };

  if (!note || !note.trim()) {
    // Nothing to say. Treated as a skip, not an error — an activity-free deal is normal.
    return { posted: false, skipped: true, matched };
  }

  try {
    // Bound the navigation, do NOT race it. navigateToProject can spend 90s waiting for `load`, then
    // retry for another 60s on `domcontentloaded`, so an OPTIONAL note step could otherwise hold the
    // GLOBAL browser lock for 150s+ with the document sync and every other create queued behind it.
    // Racing it and walking away would be worse than the delay: the `goto` would still be in flight on
    // the SHARED page and would yank it out from under whatever runs next under the same lock. So the
    // remaining budget is passed INTO the navigation as its timeout — there is never Playwright work
    // running that we have stopped waiting for.
    if (remainingMs() < MIN_NAVIGATION_BUDGET_MS) {
      return await fail(
        `Not enough of the note step's deadline left to navigate to Bid Board project ${projectId} safely`,
      );
    }
    const navigated = await navigateToProject(page, projectId, { timeoutMs: remainingMs() });
    if (!navigated) {
      return await fail(`Could not navigate to Bid Board project ${projectId} within the note step's deadline`);
    }

    // navigateToProject lands on …/tools/bid-board/project/{id}/details, which is where the Overview
    // content lives; click the Overview tab only if it is actually there (a no-op on /details).
    const overviewTab = page.locator(PROCORE_SELECTORS.bidboard.projectOverviewTab).first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click({ timeout: CONTROL_TIMEOUT_MS }).catch(() => {});
      await randomDelay(1000, 2000);
    }

    if (outOfTime()) return await fail(`Timed out before locating the Notes section on project ${projectId}`);

    // ONLY the precise tier. When the text-shaped guesses are all that match we refuse: `.first()` on
    // `section:has-text("Notes")` returns the outermost ancestor, which can be most of the page.
    const section = await find(page, selectors.section.precise, SECTION_TIMEOUT_MS);
    if (!section) {
      return await fail(
        `Notes section not found on project ${projectId} — no structural (aid-*/data-qa) match; the selectors need validating with the prober before this can run`,
        "bidboard-note-section-not-found",
      );
    }
    if (!(await isPlausibleNotesSection(section.locator))) {
      return await fail(
        `Resolved "Notes section" on project ${projectId} (${section.selector}) also contains the Project Description or a Create New Project button — refusing to act inside a page-level wrapper`,
        "bidboard-note-section-implausible",
      );
    }
    matched.section = section.selector;

    if (hasMarkerNote(await readNoteTexts(section.locator))) {
      log(`[bidboard-notes] project ${projectId} already has a CRM activity note — skipping`, "playwright");
      return { posted: false, skipped: true, matched };
    }

    if (outOfTime()) return await fail(`Timed out before opening the note editor on project ${projectId}`);

    const addButton = await find(section.locator, actableCandidates(selectors.addButton, true), CONTROL_TIMEOUT_MS);
    if (!addButton) {
      return await fail(
        `Add-note control not found on project ${projectId} (selectors may need updating)`,
        "bidboard-note-add-control-not-found",
      );
    }
    matched.addButton = addButton.selector;

    await addButton.locator.click({ timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(800, 1500);

    // The editor may open inline in the Notes section or in a dialog. Prefer a dialog when one is open
    // (that also scopes the Create button away from the rest of the page), else stay inside the section.
    const dialog = page.locator('[role="dialog"], .MuiDialog-root, dialog').last();
    // A dialog is only trusted as a scope if it passes the same contamination check as the section —
    // an unrelated modal (or a mis-resolved one wrapping the page) would otherwise re-open every
    // scoping hazard the section check just closed.
    const dialogOpen = (await dialog.isVisible().catch(() => false)) && (await isPlausibleNotesSection(dialog));
    const containerScope: Scope = dialogOpen ? dialog : section.locator;
    // Preferred: inside the validated container. Fallback: the whole page, but ONLY with the precise
    // tier — this is exactly where a bare `textarea` candidate would resolve to Procore's Project
    // Description, so the generic tiers are dropped when the scope is not a validated container.
    const input = await firstVisibleAcross(
      [
        { scope: containerScope, candidates: actableCandidates(selectors.input, true) },
        { scope: page, candidates: actableCandidates(selectors.input, false) },
      ],
      stepBudget(CONTROL_TIMEOUT_MS),
    );
    const scopeIsValidatedContainer = input?.attemptIndex === 0;
    const editorScope: Scope = scopeIsValidatedContainer ? containerScope : page;
    if (!input) {
      return await fail(
        `Note editor not found on project ${projectId} after clicking add (selectors may need updating)`,
        "bidboard-note-input-not-found",
      );
    }
    if (await isForbiddenFillTarget(input.locator)) {
      // Hard stop. Typing here would erase Procore's Project Description and blur-save the activity
      // log over it, and fail-open would report the create a success.
      return await fail(
        `Refusing to type the CRM activity note into a description field on project ${projectId} (matched ${input.selector})`,
        "bidboard-note-forbidden-target",
      );
    }
    matched.input = input.selector;

    if (outOfTime()) return await fail(`Timed out before typing the note on project ${projectId}`);

    // Marker first, then clamp — so the heading the idempotency guard and the post-save verification
    // both search for is guaranteed present AND survives truncation (the clamp keeps the head).
    const marked = ensureNoteMarker(note, projectNumber);
    const clamped = clampNoteForProcore(marked);
    if (clamped.length !== marked.length) {
      log(`[bidboard-notes] clamped the note from ${marked.length} to ${clamped.length} chars before typing`, "playwright");
    }
    hasTyped = true;
    await input.locator.fill(clamped, { timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(300, 700);

    let createButton = await find(
      editorScope,
      actableCandidates(selectors.createButton, scopeIsValidatedContainer),
      CONTROL_TIMEOUT_MS,
    );
    if (!createButton && typeof editorScope.getByRole === "function") {
      // Role/text fallback. Anchored /^create$/i — an exact accessible-name match, so unlike
      // `button:has-text("Create")` it cannot hit "Create New Project" / "Create New Customer".
      const byRole = editorScope.getByRole("button", { name: /^create$/i }).first();
      if (await isVisible(byRole, CONTROL_TIMEOUT_MS)) {
        createButton = { locator: byRole, selector: 'role=button[name=/^create$/i]' };
      }
    }
    if (!createButton) {
      return await fail(
        `Note Create button not found on project ${projectId} (selectors may need updating)`,
        "bidboard-note-create-button-not-found",
      );
    }
    matched.createButton = createButton.selector;

    await createButton.locator.click({ timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(1500, 2500);

    // Verify the note actually rendered. Procore's Notes have no documented length limit, so a silently
    // rejected over-long note is a real possibility — without this check we would report success for a
    // note that never landed.
    //
    // The editor-still-open check has to come FIRST: readNoteTexts unions the container's own text,
    // which includes the text still sitting in an open editor — i.e. an uncommitted note would
    // "verify" itself.
    const verifyDeadline = Date.now() + (options?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);
    let editorStillOpen = true;
    do {
      editorStillOpen = await input.locator.isVisible().catch(() => false);
      if (!editorStillOpen && hasMarkerNote(await readNoteTexts(section.locator))) {
        log(`[bidboard-notes] posted the CRM activity note on project ${projectId} (${clamped.length} chars)`, "playwright");
        return { posted: true, skipped: false, matched };
      }
      await randomDelay(800, 1200);
    } while (Date.now() < verifyDeadline);

    return await fail(
      `Note was submitted on project ${projectId} but ${
        editorStillOpen ? "the note editor is still open, so the save did not commit" : "it could not be verified on the page"
      }`,
      "bidboard-note-not-verified",
    );
  } catch (err: any) {
    // Belt and braces: nothing in here may throw at the caller, which is mid-create. fail() also
    // cancels the editor, so a throw after fill() cannot strand a half-typed draft on the shared page.
    return await fail(err?.message ?? String(err), "bidboard-note-error");
  }
}
