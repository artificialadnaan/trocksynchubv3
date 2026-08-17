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
 * Two invariants:
 *
 * 1. IDEMPOTENT. Every note the CRM sends starts with a marker line
 *    (`CRM Activity Log — <project number> (as of <date>)`). Before adding anything we read the
 *    existing notes and skip when that marker is already there. Without this, a retry, an adopted
 *    pre-existing project, or a duplicate create command stacks four near-identical 8 KB notes on
 *    one project.
 * 2. NEVER THROWS. Every exit is a result object. Posting a note is strictly less important than
 *    creating the project, so the caller can treat any failure as a no-op (see the fail-open wrapper
 *    in createBidBoardProjectFromDeal).
 *
 * @module playwright/bidboard-notes
 */

import type { Locator, Page } from "playwright";
import { PROCORE_SELECTORS } from "./selectors";
import { randomDelay, takeScreenshot } from "./browser";
import { navigateToProject } from "./bidboard";
import { log } from "../index";

/** The stable prefix every CRM-generated activity note starts with (the CRM builds the full line). */
export const CRM_ACTIVITY_NOTE_MARKER_PREFIX = "CRM Activity Log";

// Timeouts are deliberately modest and per-interaction rather than one big wrapper: the note step runs
// inside the browser lock during a create, so it must be bounded, but abandoning an in-flight Playwright
// action (e.g. by racing a timer) would leave the shared page in an unknown state for the document sync
// that runs after. Bounded per-call timeouts give a bounded worst case without abandoning anything.
const SECTION_TIMEOUT_MS = 15000;
const CONTROL_TIMEOUT_MS = 10000;
const VERIFY_TIMEOUT_MS = 10000;

export interface PostBidBoardNoteResult {
  /** True only when the note was typed, saved, and seen on the page afterwards. */
  posted: boolean;
  /** True when an equivalent note already existed (idempotency guard) — NOT a failure. */
  skipped: boolean;
  error?: string;
  /**
   * Which selector candidate matched at each step. Logged and returned so a selector change shows up
   * as "we fell through to the text fallback" instead of silently degrading until it breaks.
   */
  matched?: Record<string, string>;
}

/**
 * The idempotency key we look for in the existing notes.
 *
 * Derived from the note's OWN first line (minus the volatile "(as of <date>)" suffix, which changes
 * between attempts) rather than from `projectNumber` alone. The CRM labels the note with its display
 * number, which can legitimately differ from the Procore project number SyncHub used to create the
 * project (an approver can edit `project_number`, and the CRM falls back to the deal name when it has
 * no number). Keying on the note text means the marker we search for is exactly the marker a previous
 * run would have written; `projectNumber` is only the fallback for a note that has no marker line.
 */
export function noteMarkerFor(note: string, projectNumber?: string | null): string {
  const firstLine = (note || "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const withoutAsOf = firstLine.replace(/\s*\(as of[^)]*\)\s*$/i, "").trim();
  if (withoutAsOf.toLowerCase().startsWith(CRM_ACTIVITY_NOTE_MARKER_PREFIX.toLowerCase())) {
    return withoutAsOf;
  }
  const trimmedNumber = (projectNumber || "").trim();
  return trimmedNumber
    ? `${CRM_ACTIVITY_NOTE_MARKER_PREFIX} — ${trimmedNumber}`
    : CRM_ACTIVITY_NOTE_MARKER_PREFIX;
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
 * True when any of the rendered note texts already carries the marker.
 *
 * Deliberately a CONTAINS check, not a starts-with: a rendered note row usually wraps the body in
 * author/date chrome, so the marker rarely sits at character 0 of the row's text. The asymmetry is
 * intentional — a false positive (skipping a note we should have posted) costs one missing note, while
 * a false negative stacks another 8 KB duplicate on the project every retry. The marker string is
 * distinctive enough ("CRM Activity Log — DFW-2-12345-ab") that a coincidental match is not a real risk.
 */
export function hasMarkerNote(existingTexts: Array<string | null | undefined>, marker: string): boolean {
  const needle = normalizeForMarkerMatch(marker);
  if (!needle) return false;
  return existingTexts.some((text) => normalizeForMarkerMatch(text ?? "").includes(needle));
}

type Scope = Pick<Page, "locator"> & Partial<Pick<Page, "getByRole">>;

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
 * Try each candidate selector in order; return the first visible match and the selector that found it.
 *
 * Waits ONCE on the union of the candidates, then identifies which one matched with zero-wait probes.
 * Waiting `timeoutMs` per candidate instead would spend the full timeout on every wrong guess in turn —
 * with 7 candidates that is over a minute burned inside the browser lock before we conclude "not found".
 */
async function firstVisible(
  scope: Scope,
  candidates: string[],
  timeoutMs: number,
): Promise<{ locator: Locator; selector: string } | null> {
  try {
    await isVisible(scope.locator(candidates.join(", ")).first(), timeoutMs);
  } catch {
    // A union Playwright can't parse/wait on must not veto the individual probes below.
  }

  for (const selector of candidates) {
    let locator: Locator;
    try {
      locator = scope.locator(selector).first();
    } catch (err: any) {
      // A selector Playwright can't even parse must not take the whole step down.
      log(`[bidboard-notes] selector rejected by Playwright: ${selector} (${err?.message ?? err})`, "playwright");
      continue;
    }
    if (await locator.isVisible().catch(() => false)) {
      return { locator, selector };
    }
  }
  return null;
}

async function readNoteTexts(section: Locator): Promise<string[]> {
  for (const selector of PROCORE_SELECTORS.bidboard.newUi.notes.item) {
    const items = section.locator(selector);
    const count = await items.count().catch(() => 0);
    if (count > 0) {
      const texts = await items.allTextContents().catch(() => [] as string[]);
      if (texts.length > 0) return texts;
    }
  }
  // No note-row selector matched (an empty Notes section, or the row markup differs from every guess).
  // Fall back to the section's whole text so the marker check still works — for idempotency, one blob
  // of text is as good as a list.
  const sectionText = await section.innerText().catch(() => "");
  return sectionText ? [sectionText] : [];
}

/**
 * Post `note` as a Note on Bid Board project `projectId`.
 *
 * Never throws: returns `{ posted }`, `{ skipped }` (marker already present) or `{ error }`.
 */
export async function postBidBoardProjectNote(
  page: Page,
  projectId: string,
  note: string,
  projectNumber?: string | null,
  /** Test seam (same spirit as createProject/findExistingProject in bidboard.ts) — keeps suites fast. */
  options?: { verifyTimeoutMs?: number },
): Promise<PostBidBoardNoteResult> {
  const matched: Record<string, string> = {};
  const selectors = PROCORE_SELECTORS.bidboard.newUi.notes;

  if (!note || !note.trim()) {
    // Nothing to say. Treated as a skip, not an error — an activity-free deal is normal.
    return { posted: false, skipped: true, matched };
  }

  try {
    const navigated = await navigateToProject(page, projectId);
    if (!navigated) {
      return { posted: false, skipped: false, error: `Could not navigate to Bid Board project ${projectId}`, matched };
    }

    // navigateToProject lands on …/tools/bid-board/project/{id}/details, which is where the Overview
    // content lives; click the Overview tab only if it is actually there (a no-op on /details).
    const overviewTab = page.locator(PROCORE_SELECTORS.bidboard.projectOverviewTab).first();
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click({ timeout: CONTROL_TIMEOUT_MS }).catch(() => {});
      await randomDelay(1000, 2000);
    }

    const section = await firstVisible(page, selectors.section, SECTION_TIMEOUT_MS);
    if (!section) {
      const screenshotPath = await takeScreenshot(page, "bidboard-note-section-not-found").catch(() => "");
      return {
        posted: false,
        skipped: false,
        error: `Notes section not found on project ${projectId} (selectors may need updating)${screenshotPath ? `; screenshot: ${screenshotPath}` : ""}`,
        matched,
      };
    }
    matched.section = section.selector;

    const marker = noteMarkerFor(note, projectNumber);
    const existingTexts = await readNoteTexts(section.locator);
    if (hasMarkerNote(existingTexts, marker)) {
      log(`[bidboard-notes] project ${projectId} already has a "${marker}" note — skipping`, "playwright");
      return { posted: false, skipped: true, matched };
    }

    const addButton = await firstVisible(section.locator, selectors.addButton, CONTROL_TIMEOUT_MS);
    if (!addButton) {
      const screenshotPath = await takeScreenshot(page, "bidboard-note-add-control-not-found").catch(() => "");
      return {
        posted: false,
        skipped: false,
        error: `Add-note control not found on project ${projectId} (selectors may need updating)${screenshotPath ? `; screenshot: ${screenshotPath}` : ""}`,
        matched,
      };
    }
    matched.addButton = addButton.selector;

    await addButton.locator.click({ timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(800, 1500);

    // The editor may open inline in the Notes section or in a dialog. Prefer a dialog when one is open
    // (that also scopes the Create button away from the rest of the page), else stay inside the section,
    // and only then widen to the page.
    const dialog = page.locator('[role="dialog"], .MuiDialog-root, dialog').last();
    const dialogOpen = await dialog.isVisible().catch(() => false);
    let editorScope: Scope = dialogOpen ? dialog : section.locator;
    let editorScopeIsPage = false;
    let input = await firstVisible(editorScope, selectors.input, CONTROL_TIMEOUT_MS);
    if (!input) {
      input = await firstVisible(page, selectors.input, CONTROL_TIMEOUT_MS);
      if (input) {
        // The editor rendered outside our section/dialog guess, so its Create button is outside too —
        // move the scope with it (and see the narrowed candidate list below).
        editorScope = page;
        editorScopeIsPage = true;
      }
    }
    if (!input) {
      const screenshotPath = await takeScreenshot(page, "bidboard-note-input-not-found").catch(() => "");
      return {
        posted: false,
        skipped: false,
        error: `Note editor not found on project ${projectId} after clicking add (selectors may need updating)${screenshotPath ? `; screenshot: ${screenshotPath}` : ""}`,
        matched,
      };
    }
    matched.input = input.selector;

    await input.locator.fill(note, { timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(300, 700);

    // Scoped to the notes container/dialog, every candidate is safe. Searching the whole PAGE is not:
    // `button:has-text("Create")` also matches "Create New Project" / "Create New Customer", and
    // `button[type="submit"]` matches any other form on the page. Drop those when the scope widened.
    const createCandidates = editorScopeIsPage
      ? selectors.createButton.filter((selector) => !selector.includes(":has-text") && !selector.includes('[type="submit"]'))
      : selectors.createButton;
    let createButton = await firstVisible(editorScope, createCandidates, CONTROL_TIMEOUT_MS);
    if (!createButton && typeof editorScope.getByRole === "function") {
      // Role/text fallback, matching the layered strategy the selectors module documents. Anchored
      // /^create$/i so it can't match "Create New Project" or "Create Customer".
      const byRole = editorScope.getByRole("button", { name: /^create$/i }).first();
      if (await isVisible(byRole, CONTROL_TIMEOUT_MS)) {
        createButton = { locator: byRole, selector: 'role=button[name=/^create$/i]' };
      }
    }
    if (!createButton) {
      const screenshotPath = await takeScreenshot(page, "bidboard-note-create-button-not-found").catch(() => "");
      return {
        posted: false,
        skipped: false,
        error: `Note Create button not found on project ${projectId} (selectors may need updating)${screenshotPath ? `; screenshot: ${screenshotPath}` : ""}`,
        matched,
      };
    }
    matched.createButton = createButton.selector;

    await createButton.locator.click({ timeout: CONTROL_TIMEOUT_MS });
    await randomDelay(1500, 2500);

    // Verify the note actually rendered. Procore's Notes have no documented length limit, so a silently
    // rejected over-long note is a real possibility — without this check we would report success for a
    // note that never landed, and the next run's marker check would then post it again.
    //
    // The editor-still-open check has to come FIRST: when no note-row selector matches, readNoteTexts
    // falls back to the section's whole text, which would include the text still sitting in the open
    // editor — i.e. an uncommitted note would "verify" itself.
    const verifyDeadline = Date.now() + (options?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);
    let editorStillOpen = true;
    do {
      editorStillOpen = await input.locator.isVisible().catch(() => false);
      if (!editorStillOpen && hasMarkerNote(await readNoteTexts(section.locator), marker)) {
        log(`[bidboard-notes] posted the CRM activity note on project ${projectId} (${note.length} chars)`, "playwright");
        return { posted: true, skipped: false, matched };
      }
      await randomDelay(800, 1200);
    } while (Date.now() < verifyDeadline);

    const screenshotPath = await takeScreenshot(page, "bidboard-note-not-verified").catch(() => "");
    const reason = editorStillOpen
      ? "the note editor is still open, so the save did not commit"
      : "it could not be verified on the page";
    return {
      posted: false,
      skipped: false,
      error: `Note was submitted on project ${projectId} but ${reason}${screenshotPath ? `; screenshot: ${screenshotPath}` : ""}`,
      matched,
    };
  } catch (err: any) {
    // Belt and braces: nothing in here may throw at the caller, which is mid-create.
    const message = err?.message ?? String(err);
    await takeScreenshot(page, "bidboard-note-error").catch(() => "");
    return { posted: false, skipped: false, error: message, matched };
  }
}
