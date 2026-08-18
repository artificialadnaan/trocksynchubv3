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

/** How much of the note's tail must be found again for the body to count as intact. */
const TAIL_FINGERPRINT_CHARS = 60;

/**
 * The normalized tail of what we typed — the part that can only be present if the WHOLE body survived.
 *
 * ensureNoteMarker deliberately puts the marker on the FIRST line, so "the rendered note contains the
 * marker" is satisfied by a note Procore accepted and then truncated. The payload is capped at 8 KB
 * precisely because Procore's own limit is undocumented, which makes truncation a live possibility
 * rather than a hypothetical, and a truncated note would otherwise be recorded as fully posted.
 *
 * Normalized (whitespace collapsed, dashes unified, lowercased) rather than compared byte-for-byte,
 * because Procore re-renders the text — auto-linking URLs, reflowing whitespace.
 */
export function noteTailFingerprint(note: string): string {
  const normalized = normalizeForMarkerMatch(note);
  return normalized.slice(-TAIL_FINGERPRINT_CHARS);
}

/** True when the rendered text still contains the tail of what we typed. */
export function hasNoteTail(renderedTexts: Array<string | null | undefined>, note: string): boolean {
  const tail = noteTailFingerprint(note);
  if (!tail) return false;
  return renderedTexts.some((text) => normalizeForMarkerMatch(text ?? "").includes(tail));
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
 * The candidates the automation may ACT on.
 *
 * `loose` is never included — it is prober diagnostics only. `scopedOnly` always is, because every
 * actable lookup in this module is now confined to a VALIDATED container (the resolved, uncontaminated
 * Notes section or an open dialog that passed the same check). That invariant replaced the old
 * page-wide fallback; if a lookup ever gains a page-wide scope again, this function's contract breaks.
 */
export function actableCandidates(tiers: CandidateTiers): string[] {
  return [...tiers.precise, ...(tiers.scopedOnly ?? [])];
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
export type VisibleMatch = {
  /** The first visible node, or null when none is visible OR it could not be determined. */
  hit: { locator: Locator; index: number } | null;
  /** Number of matching nodes, or null when the count query itself failed (NOT the same as zero). */
  count: number | null;
  /**
   * True when a query threw. `hit: null` then means UNKNOWN, not "no such element".
   *
   * Returned rather than swallowed, and deliberately NOT hidden behind a convenience wrapper that
   * discards it — that exact shape (a wrapper dropping a failure flag) caused the duplicate-note bug.
   * Production declines on `hit: null` either way, which is its safe direction; the PROBER must tell
   * the two apart, because "discard this selector" and "re-run, we could not tell" lead an operator to
   * opposite conclusions.
   */
  probeFailed: boolean;
};

export async function findVisibleMatch(scope: Scope, selector: string): Promise<VisibleMatch> {
  let all: Locator;
  try {
    all = scope.locator(selector);
  } catch (err: any) {
    // A selector Playwright can't even parse must not take the whole step down.
    log(`[bidboard-notes] selector rejected by Playwright: ${selector} (${err?.message ?? err})`, "playwright");
    return { hit: null, count: null, probeFailed: true };
  }
  const count = await all.count().catch(() => null);
  if (count === null) return { hit: null, count: null, probeFailed: true };
  let probeFailed = false;
  for (let index = 0; index < Math.min(count, MAX_NODES_PER_SELECTOR); index++) {
    const node = all.nth(index);
    const visible = await node.isVisible().catch(() => null);
    if (visible === null) probeFailed = true;
    else if (visible) return { hit: { locator: node, index }, count, probeFailed };
  }
  return { hit: null, count, probeFailed };
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
/**
 * The accessible-name match used for the Create button when no CSS candidate hits. Anchored, so unlike
 * `button:has-text("Create")` it cannot match "Create New Project" / "Create New Customer". Exported so
 * the prober reports whether THIS fallback would fire, not just the CSS tiers.
 */
export const CREATE_BUTTON_ROLE = { role: "button" as const, name: /^create$/i };

/** How the shared resolver reports a role match, so callers can label it in `matched`. */
export const ROLE_MATCH_LABEL = "role=button[name=/^create$/i]";

export type ResolveAttempt = {
  scope: Scope;
  candidates?: string[];
  /** Role fallback for this scope, tried after the CSS candidates on every poll pass. */
  role?: { role: "button"; name: RegExp };
};

/**
 * First VISIBLE match by accessible role/name — the role-fallback twin of findVisibleMatch.
 *
 * Same walk, same reason: `.first()` here would wait on a hidden responsive/template copy of "Create"
 * and reject the fallback, and by that point the note is ALREADY TYPED — so the outcome is that we
 * cancel a composed note instead of submitting it.
 */
export async function findVisibleRoleMatch(
  scope: Scope,
  role: { role: "button"; name: RegExp },
): Promise<VisibleMatch> {
  if (typeof scope.getByRole !== "function") return { hit: null, count: null, probeFailed: true };
  let all: Locator;
  try {
    all = scope.getByRole(role.role, { name: role.name });
  } catch {
    return { hit: null, count: null, probeFailed: true };
  }
  const count = await all.count().catch(() => null);
  if (count === null) return { hit: null, count: null, probeFailed: true };
  let probeFailed = false;
  for (let index = 0; index < Math.min(count, MAX_NODES_PER_SELECTOR); index++) {
    const node = all.nth(index);
    const visible = await node.isVisible().catch(() => null);
    if (visible === null) probeFailed = true;
    else if (visible) return { hit: { locator: node, index }, count, probeFailed };
  }
  return { hit: null, count, probeFailed };
}

/**
 * Try each attempt in order and return the first VISIBLE match, polling until `timeoutMs`.
 *
 * Polls the whole attempt list rather than waiting on a union of it: the union wait had the same
 * hidden-first-node blind spot as `.first()` (it would sit on a hidden node for the full timeout and
 * then report nothing), and a per-candidate wait would spend the whole timeout on every wrong guess in
 * turn. One cheap pass over everything, repeated until the deadline, gives the SPA time to render
 * without either failure mode. The role fallback rides in the SAME loop so it gets the same polling
 * and the same visible-match walk as the CSS candidates.
 */
export async function firstVisibleAcross(
  attempts: ResolveAttempt[],
  timeoutMs: number,
): Promise<{ locator: Locator; selector: string; attemptIndex: number } | null> {
  if (attempts.every((attempt) => (attempt.candidates?.length ?? 0) === 0 && !attempt.role)) return null;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    // All attempts are tried on EVERY pass, in preference order. Exhausting the whole timeout on the
    // preferred scope before even looking at the fallback would burn the budget waiting for something
    // that is never going to appear there (and, with the overall deadline, starve the later steps).
    for (const [attemptIndex, attempt] of attempts.entries()) {
      // Production declines on `hit: null` whether that means "absent" or "could not tell" — both are
      // reasons not to act. The distinction is preserved on the result for the prober's benefit.
      for (const selector of attempt.candidates ?? []) {
        const { hit } = await findVisibleMatch(attempt.scope, selector);
        if (hit) return { locator: hit.locator, selector, attemptIndex };
      }
      if (attempt.role) {
        const { hit } = await findVisibleRoleMatch(attempt.scope, attempt.role);
        if (hit) return { locator: hit.locator, selector: ROLE_MATCH_LABEL, attemptIndex };
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
export async function readNoteTextsDetailed(section: Locator): Promise<{ texts: string[]; failed: boolean }> {
  const texts: string[] = [];
  let failed = false;
  for (const selector of PROCORE_SELECTORS.bidboard.newUi.notes.item) {
    const items = section.locator(selector);
    const count = await items.count().catch(() => -1);
    if (count < 0) {
      failed = true;
      continue;
    }
    if (count > 0) {
      const got = await items.allTextContents().catch(() => null);
      if (got === null) failed = true;
      else texts.push(...got);
    }
  }
  const sectionText = await section.innerText().catch(() => null);
  if (sectionText === null) failed = true;
  else if (sectionText) texts.push(sectionText);
  // `failed` exists so a caller can tell "this project has no CRM note" from "we could not read the
  // notes". They are the same empty array, and only one of them means it is safe to post.
  return { texts, failed };
}

// NOTE: there is deliberately NO `readNoteTexts(): string[]` convenience wrapper. One existed, it
// dropped the `failed` flag, and a caller then read an empty array as "no CRM note here, safe to post"
// — producing a duplicate 8 KB note on a transient SPA rerender. Every caller must handle `failed`.


/**
 * Reject a "Notes section" that is really a page-sized wrapper. If the container also holds the
 * Project Description field or a Create New Project button, then every scoped search below it —
 * including "the Create button next to the editor" — is unscoped in practice.
 */
async function isPlausibleNotesSection(section: Locator): Promise<boolean> {
  // FAIL CLOSED. `.catch(() => 0)` here used to mean "the contamination query blew up, therefore the
  // container is clean" — an unknown converted into the favourable answer, on the check that decides
  // whether it is safe to act inside this element at all. An unreadable container is not a safe one.
  const contaminated = await section
    .locator(PROCORE_SELECTORS.bidboard.newUi.notes.sectionContamination)
    .count()
    .catch(() => -1);
  return contaminated === 0;
}

/**
 * The ONE place that decides whether a usable Notes container exists, and why not when it doesn't.
 *
 * Shared with the prober deliberately. The prober's entire value is telling a human which selectors are
 * real; if it resolved the section by a parallel rule it could validate hooks production would never
 * use, or report a working inline selector as absent — in either direction the human then substitutes
 * the wrong hooks into an automation that touches live Procore projects. One implementation, one
 * verdict.
 */
export type NotesSectionResolution =
  | { ok: true; locator: Locator; selector: string }
  | { ok: false; reason: "not-found" | "loose-only" | "contaminated"; selector: string | null; message: string };

/**
 * How many levels above the "+" anchor the Notes card may sit. Bounded on purpose: an unbounded climb
 * ends at <body>, which is precisely the page-sized wrapper this whole mechanism exists to avoid. Eight
 * covers the observed nesting (button > span > div > … > card) with slack for a layout change.
 */
const ANCHOR_CLIMB_LIMIT = 8;
/** Bound on how many "+" controls are considered, so a page full of icon buttons cannot spin. */
const ANCHOR_CANDIDATE_LIMIT = 12;

/**
 * Does this container carry an exact-text "Notes" label? Fails CLOSED — an unreadable container is not
 * a labelled one, same posture as isPlausibleNotesSection.
 */
async function holdsNotesLabel(container: Locator): Promise<boolean> {
  const count = await container
    .locator(PROCORE_SELECTORS.bidboard.newUi.notes.sectionLabel)
    .count()
    .catch(() => -1);
  return count > 0;
}

/**
 * Resolve the Notes card structurally, by climbing from the "+" control rather than guessing a class.
 *
 * Why this exists: every `section.precise` candidate was an educated guess at Procore's markup, and a
 * live project (2026-08-18) has none of them — so production fell through to `loose` and refused. More
 * guesses would only move the next failure, because the guessed hooks (`aid-notes`, styled-components
 * hashes) are exactly the things Procore churns.
 *
 * The rule: take the INNERMOST ancestor of a "+" button that (a) carries an exact-text "Notes" label and
 * (b) passes the contamination check. Innermost is the whole point — `:has-text()` yields the OUTERMOST
 * ancestor, which is how the loose tier ends up holding most of the page.
 *
 * The climb stops at the first ancestor that is labelled but CONTAMINATED, rather than continuing: once
 * a container has grown large enough to swallow the description field, every wider one does too, so
 * continuing could only produce a worse match than the one just rejected.
 */
export async function resolveNotesSectionByAnchor(
  page: Scope,
): Promise<{ locator: Locator; selector: string } | null> {
  const anchorSelector = PROCORE_SELECTORS.bidboard.newUi.notes.sectionAnchor;
  const anchors = page.locator(anchorSelector);
  const total = await anchors.count().catch(() => 0);
  for (let i = 0; i < Math.min(total, ANCHOR_CANDIDATE_LIMIT); i += 1) {
    const anchor = anchors.nth(i);
    if (!(await anchor.isVisible().catch(() => false))) continue;
    let node: Locator = anchor;
    for (let depth = 1; depth <= ANCHOR_CLIMB_LIMIT; depth += 1) {
      node = node.locator("xpath=..");
      if (!(await holdsNotesLabel(node))) continue;
      if (!(await isPlausibleNotesSection(node))) break;
      return { locator: node, selector: `${anchorSelector} ⇑${depth} + exact-text "Notes"` };
    }
  }
  return null;
}

export async function resolveNotesSection(
  page: Scope,
  options?: { timeoutMs?: number; projectLabel?: string },
): Promise<NotesSectionResolution> {
  const selectors = PROCORE_SELECTORS.bidboard.newUi.notes;
  const where = options?.projectLabel ? ` on project ${options.projectLabel}` : "";
  const precise = await firstVisible(page, selectors.section.precise, options?.timeoutMs ?? SECTION_TIMEOUT_MS);
  if (!precise) {
    // Before reporting a refusal, try the structural anchor. It is attempted only AFTER the precise
    // tier so a real hook (if Procore ever ships one) still wins on speed, and it is validated by the
    // same contamination check as everything else — it is a different way to FIND the card, not a
    // weaker standard for accepting one.
    const anchored = await resolveNotesSectionByAnchor(page);
    if (anchored) {
      return { ok: true, locator: anchored.locator, selector: anchored.selector };
    }
    // Distinguish "nothing matched" from "only the loose text-shaped guesses matched". Production
    // refuses either way, but the operator needs to know which — the second means the docs-shaped
    // guess is on the page and a real structural hook has to be found to replace it.
    const loose = await firstVisibleAcross([{ scope: page, candidates: selectors.section.loose ?? [] }], 0);
    if (loose) {
      return {
        ok: false,
        reason: "loose-only",
        selector: loose.selector,
        message: `Only the loose (text-shaped) Notes-section candidates matched${where} — refusing to act, because \`:has-text()\` returns the OUTERMOST ancestor, which can be most of the page`,
      };
    }
    return {
      ok: false,
      reason: "not-found",
      selector: null,
      message: `Notes section not found${where} — no structural (aid-*/data-qa) match; the selectors need validating with the prober before this can run`,
    };
  }
  if (!(await isPlausibleNotesSection(precise.locator))) {
    return {
      ok: false,
      reason: "contaminated",
      selector: precise.selector,
      message: `Resolved "Notes section"${where} (${precise.selector}) also contains the Project Description or a Create New Project button — refusing to act inside a page-level wrapper`,
    };
  }
  return { ok: true, locator: precise.locator, selector: precise.selector };
}

/**
 * The ONE place that decides which containers the editor may be looked for in, and in what order.
 *
 * A dialog is accepted only when it is visible AND passes the same contamination check as the section;
 * an unrelated modal (or a mis-resolved one wrapping the page) would otherwise re-open every scoping
 * hazard the section check just closed. When a dialog is usable the section stays as a second scope,
 * because the editor may still be inline. Shared with the prober so it probes exactly the scopes
 * production would use — probing a dialog production would reject is worse than not probing at all.
 */
export async function resolveEditorScopes(
  page: Scope,
  section: Locator,
): Promise<Array<{ label: string; scope: Scope }>> {
  const dialog = page.locator('[role="dialog"], .MuiDialog-root, dialog').last();
  // An unreadable dialog is treated as unusable, so the search falls back to the validated section —
  // the narrower, pessimistic scope.
  const dialogUsable = (await dialog.isVisible().catch(() => false)) && (await isPlausibleNotesSection(dialog));
  return dialogUsable
    ? [{ label: "dialog", scope: dialog }, { label: "section", scope: section }]
    : [{ label: "section", scope: section }];
}

/**
 * The post-Add phase, shared verbatim between the automation and the prober.
 *
 * This is the step that has now produced the same review finding three times in different clothes —
 * the prober approximating production's timing, its scope fixing, or its actable filtering, and
 * therefore reporting that a selector combination works when production could not use it. So the
 * automation and the prober call THIS, and the prober reports what it returned rather than deriving
 * an equivalent.
 *
 * Two calls rather than one, because ORDER matters and must not be flattened: the Create control is
 * resolved only AFTER the note is typed, since a Procore editor may not render (or may disable) Create
 * until the body is non-empty. Resolving both up front would look tidier and would quietly change what
 * production does.
 */
export type NoteEditorResolution = {
  scopes: Array<{ label: string; scope: Scope }>;
  /** The input the automation would type into, with the container it was found in. */
  input: { locator: Locator; selector: string; scopeLabel: string } | null;
  /** The scope the Create search is then FIXED to — the one the input was found in, never both. */
  editorScope: Scope | null;
  editorScopeLabel: string | null;
};

export async function resolveNoteEditorInput(
  page: Scope,
  section: Locator,
  timeoutMs: number,
): Promise<NoteEditorResolution> {
  const scopes = await resolveEditorScopes(page, section);
  const input = await firstVisibleAcross(
    scopes.map(({ scope }) => ({ scope, candidates: actableCandidates(PROCORE_SELECTORS.bidboard.newUi.notes.input) })),
    timeoutMs,
  );
  if (!input) return { scopes, input: null, editorScope: null, editorScopeLabel: null };
  const resolved = scopes[input.attemptIndex];
  return {
    scopes,
    input: { locator: input.locator, selector: input.selector, scopeLabel: resolved.label },
    editorScope: resolved.scope,
    editorScopeLabel: resolved.label,
  };
}

/** Resolve the Create control INSIDE the already-fixed editor scope. Polled, like every other lookup. */
export async function resolveNoteCreateControl(
  editorScope: Scope,
  timeoutMs: number,
): Promise<{ locator: Locator; selector: string } | null> {
  const hit = await firstVisibleAcross(
    [
      {
        scope: editorScope,
        candidates: actableCandidates(PROCORE_SELECTORS.bidboard.newUi.notes.createButton),
        role: CREATE_BUTTON_ROLE,
      },
    ],
    timeoutMs,
  );
  return hit ? { locator: hit.locator, selector: hit.selector } : null;
}

/**
 * Last line of defence before typing: refuse any element whose own attributes say "description".
 * Independent of which selector matched, so it still holds if a candidate is edited carelessly later.
 */
export async function isForbiddenFillTarget(locator: Locator): Promise<boolean> {
  // FAIL CLOSED. A read error is NOT "the attribute is absent": if we cannot tell what this element is,
  // we must not type 8 KB into it. The sentinel keeps a genuine null (attribute absent) distinct from
  // an unreadable one, so only the latter refuses.
  const UNREADABLE = Symbol("unreadable");
  const attrs = await Promise.all(
    ["name", "id", "aria-label", "placeholder", "data-qa"].map((attr) =>
      locator.getAttribute(attr).catch(() => UNREADABLE as unknown as string | null),
    ),
  );
  if (attrs.some((value) => (value as unknown) === UNREADABLE)) return true;
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
export type CancelEditorResult = {
  /** true = verified gone, false = still there, null = could not be verified. */
  closed: boolean | null;
  attempts: number;
  /** True when the draft text was wiped as a last resort. */
  cleared: boolean;
  detail?: string;
};

/** How many times to press Escape before giving up. */
const CANCEL_MAX_ATTEMPTS = 3;

/**
 * Close a half-typed editor and CONFIRM it closed.
 *
 * Delivering the keypress is not the same as changing the state. The concrete case: this module's own
 * docs note that Procore treats "@" as a mention trigger, and activity bodies are rep-authored free
 * text, so a note containing "@" can leave the mention picker open — the first Escape then dismisses
 * the PICKER, not the editor. Reporting success off the keypress would skip the warning and let
 * document sync proceed on a page with an ~8 KB draft still open.
 *
 * Pass the editor locator to get verification; without one the result is `closed: null` (unknown),
 * never an optimistic true.
 */
export async function cancelEditor(page: Page, editor?: Locator): Promise<CancelEditorResult> {
  let attempts = 0;
  let lastError: string | undefined;

  /** The most recent visibility reading: true = still open, false = gone, null = could not tell. */
  let lastReading: boolean | null = null;

  for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      await page.keyboard.press("Escape");
      await randomDelay(300, 600);
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      log(`[bidboard-notes] could not press Escape to cancel the note editor: ${lastError}`, "playwright");
      break;
    }
    if (!editor) continue;
    lastReading = await editor.isVisible().catch(() => null);
    // ONLY a confirmed "gone" ends the loop. An indeterminate reading must not: returning here would
    // consume the remaining Escape attempts and skip the clear fallback — i.e. an unknown would defeat
    // the very retry it sits inside. Unknown means "keep trying, and if we run out, warn and clear".
    if (lastReading === false) return { closed: true, attempts, cleared: false };
  }

  if (!editor) {
    return { closed: null, attempts, cleared: false, detail: lastError ?? "no editor locator to verify against" };
  }

  // Last resort: empty the field. If the editor cannot be closed, a blank draft is materially safer
  // than an ~8 KB one — Procore blur-saves this field, which is why the description-verify path
  // presses Tab to commit. This targets the same locator already vetted by isForbiddenFillTarget.
  const cleared = await editor
    .fill("")
    .then(() => true)
    .catch(() => false);
  return {
    // An indeterminate final reading is reported as UNKNOWN, not as a confirmed "still open" — but it
    // takes the same warning-and-clear path, because both mean "we cannot promise the page is clean".
    closed: lastReading === null ? null : false,
    attempts,
    cleared,
    detail:
      lastError ??
      (lastReading === null
        ? `editor visibility could not be read after ${attempts} Escape attempt(s)`
        : `editor still open after ${attempts} Escape attempt(s)`),
  };
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
  /** The editor we typed into, so a cancel can be VERIFIED against it rather than assumed. */
  let typedEditor: Locator | undefined;
  const deadlineAt = Date.now() + (options?.overallTimeoutMs ?? OVERALL_TIMEOUT_MS);
  const outOfTime = () => Date.now() > deadlineAt;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
  /** Every lookup is clamped to what's left of the overall budget, not just its own step timeout. */
  const stepBudget = (stepTimeoutMs: number) => Math.min(options?.stepTimeoutMs ?? stepTimeoutMs, remainingMs());
  const find = (scope: Scope, candidates: string[], stepTimeoutMs: number) =>
    firstVisible(scope, candidates, stepBudget(stepTimeoutMs));
  /**
   * Timeout for an ACTION (click/fill), clamped to what's left of the overall budget.
   *
   * A lookup can legitimately consume nearly the whole budget and still return a control just before
   * expiry; starting a fresh full-length click after that is how the step overruns the global browser
   * lock it is supposed to be bounded by. Floored at 1ms because Playwright reads `timeout: 0` as "no
   * timeout at all" — the same trap as the navigation bound.
   */
  const actBudget = () => Math.max(1, Math.min(CONTROL_TIMEOUT_MS, remainingMs()));
  let hasTyped = false;

  /** Single exit for every failure: cancels a half-typed editor, then reports. Never throws. */
  const fail = async (message: string, screenshotName?: string): Promise<PostBidBoardNoteResult> => {
    if (screenshotName) {
      const path = await takeScreenshot(page, screenshotName).catch(() => "");
      if (path) message = `${message}; screenshot: ${path}`;
    }
    if (hasTyped) {
      const cancel = await cancelEditor(page, typedEditor);
      if (cancel.closed !== true) {
        // Anything other than a VERIFIED close is reported. The page is shared: document sync runs on
        // it next under the same browser lock.
        const state = cancel.closed === false ? "is still open" : "could not be confirmed closed";
        const cleared = cancel.cleared ? " (its text was cleared as a fallback)" : "";
        message = `${message}; WARNING: the note editor ${state} after ${cancel.attempts} cancel attempt(s)${cleared}`;
      }
    }
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
    // Both defaults here mean "we may not be on the Overview tab", which makes the section lookup below
    // fail and the whole step decline. Safe direction, but see the prober, which reports the click
    // failure explicitly because an operator would otherwise read the resulting absences as facts.
    if (await overviewTab.isVisible().catch(() => false)) {
      await overviewTab.click({ timeout: actBudget() }).catch(() => {});
      await randomDelay(1000, 2000);
    }

    if (outOfTime()) return await fail(`Timed out before locating the Notes section on project ${projectId}`);

    // Section resolution, contamination and the loose-only refusal all live in resolveNotesSection, so
    // the prober reaches the identical verdict by calling the same function.
    const section = await resolveNotesSection(page, {
      timeoutMs: stepBudget(SECTION_TIMEOUT_MS),
      projectLabel: projectId,
    });
    if (!section.ok) {
      return await fail(
        section.message,
        section.reason === "contaminated" ? "bidboard-note-section-implausible" : "bidboard-note-section-not-found",
      );
    }
    matched.section = section.selector;

    // FAIL CLOSED. An unreadable notes list is NOT an empty one: reading [] as "no marker present"
    // means "safe to post", and the cost of being wrong is another ~8 KB duplicate on the project,
    // repeated on every retry and on every adopt.
    const existingNotes = await readNoteTextsDetailed(section.locator);
    if (existingNotes.failed) {
      return await fail(
        `Could not read the existing notes on project ${projectId} — refusing to post in case a CRM activity note is already there`,
        "bidboard-note-read-failed",
      );
    }
    if (hasMarkerNote(existingNotes.texts)) {
      log(`[bidboard-notes] project ${projectId} already has a CRM activity note — skipping`, "playwright");
      return { posted: false, skipped: true, matched };
    }

    if (outOfTime()) return await fail(`Timed out before opening the note editor on project ${projectId}`);

    const addButton = await find(section.locator, actableCandidates(selectors.addButton), CONTROL_TIMEOUT_MS);
    if (!addButton) {
      return await fail(
        `Add-note control not found on project ${projectId} (selectors may need updating)`,
        "bidboard-note-add-control-not-found",
      );
    }
    matched.addButton = addButton.selector;

    if (outOfTime()) return await fail(`Timed out before opening the note editor on project ${projectId}`);
    await addButton.locator.click({ timeout: actBudget() });
    await randomDelay(800, 1500);

    // The editor may open inline in the Notes section or in a dialog. resolveEditorScopes decides which
    // containers are usable and in what order — shared with the prober so it probes the same ones.
    //
    // The editor is looked for ONLY inside those validated containers. There is deliberately NO
    // page-wide fallback.
    //
    // ⚠️ DO NOT ADD ONE. A page-wide scope is the single root cause behind a whole class of hazards:
    // the anchored `getByRole('button', { name: /^create$/i })` fallback below bypasses the selector
    // tiers entirely and would click any unrelated "Create" on the page; and
    // `[role="textbox"][contenteditable="true"]` carries no Notes-specific identity, so a rich-text
    // Project Description would satisfy it — the very corruption isForbiddenFillTarget already had to
    // catch once. Every candidate we might add re-opens the same question.
    //
    // The rule this module follows everywhere else applies here too: when it cannot POSITIVELY
    // identify the Notes editor, it declines. That costs nothing real — it already declines on
    // loose-only sections, contaminated containers, cross-deal mappings and deadline exhaustion — and
    // a note that doesn't post is a non-event, while filling the wrong field on a live Procore project
    // is not.
    const editor = await resolveNoteEditorInput(page, section.locator, stepBudget(CONTROL_TIMEOUT_MS));
    const input = editor.input;
    if (!input) {
      return await fail(
        `Note editor not found inside the ${editor.scopes.map((s) => s.label).join(" or ")} on project ${projectId} after clicking add — declining rather than widening the search to the page (selectors may need updating)`,
        "bidboard-note-input-not-found",
      );
    }
    // The Create button is searched in the SAME validated container the editor was found in.
    const editorScope = editor.editorScope!;
    matched.editorScope = editor.editorScopeLabel!;
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
    typedEditor = input.locator;
    await input.locator.fill(clamped, { timeout: actBudget() });
    await randomDelay(300, 700);

    // Resolved only NOW, after the body is typed — a Procore editor may not render or enable Create
    // until the note is non-empty. Same shared helper the prober calls, so the scope fixing and the
    // polling cannot drift apart.
    const createButton = await resolveNoteCreateControl(editorScope, stepBudget(CONTROL_TIMEOUT_MS));
    if (!createButton) {
      return await fail(
        `Note Create button not found on project ${projectId} (selectors may need updating)`,
        "bidboard-note-create-button-not-found",
      );
    }
    matched.createButton = createButton.selector;

    if (outOfTime()) {
      // The note is already typed, so this exit cancels the editor rather than leaving a draft behind.
      return await fail(`Timed out before submitting the note on project ${projectId}`);
    }
    await createButton.locator.click({ timeout: actBudget() });
    await randomDelay(1500, 2500);

    // Verify the note actually rendered. Procore's Notes have no documented length limit, so a silently
    // rejected over-long note is a real possibility — without this check we would report success for a
    // note that never landed.
    //
    // The editor-still-open check has to come FIRST: readNoteTexts unions the container's own text,
    // which includes the text still sitting in an open editor — i.e. an uncommitted note would
    // "verify" itself.
    // Clamped to the overall deadline, not a fresh window: after a slow navigation this would otherwise
    // hold the GLOBAL browser lock for another full verify window on top of an already-spent budget.
    const verifyDeadline = Math.min(Date.now() + (options?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS), deadlineAt);
    let editorStillOpen = true;
    let markerSeen = false;
    do {
      // `catch(() => false)` here would mean "the visibility probe threw, therefore the editor closed",
      // and the marker check below reads the container's text — which INCLUDES an open editor's
      // content. An unknown would therefore let our own unsaved draft verify itself as saved. Unknown
      // counts as STILL OPEN.
      const editorVisible = await input.locator.isVisible().catch(() => null);
      editorStillOpen = editorVisible !== false;
      const rendered = editorStillOpen ? null : await readNoteTextsDetailed(section.locator);
      // A failed verify read is not "not there yet" and not "there" — keep polling, and if the window
      // expires the step reports unverified, which is the pessimistic answer.
      if (rendered && !rendered.failed) {
        // TWO conditions. The marker alone is satisfied by a note Procore accepted and TRUNCATED,
        // because ensureNoteMarker puts the marker on the first line; the tail can only be there if the
        // whole body survived. Tracking markerSeen separately turns "truncated" into its own diagnosis
        // instead of a generic "could not be verified".
        if (hasMarkerNote(rendered.texts)) {
          markerSeen = true;
          if (hasNoteTail(rendered.texts, clamped)) {
            log(`[bidboard-notes] posted the CRM activity note on project ${projectId} (${clamped.length} chars)`, "playwright");
            return { posted: true, skipped: false, matched };
          }
        }
      }
      await randomDelay(800, 1200);
    } while (Date.now() < verifyDeadline);

    return await fail(
      `Note was submitted on project ${projectId} but ${
        editorStillOpen
          ? "the note editor is still open, so the save did not commit"
          : markerSeen
            ? `only its opening line rendered — the body appears to have been TRUNCATED by Procore (posted ${clamped.length} chars; consider lowering the CRM's MAX_NOTE_CHARS)`
            : "it could not be verified on the page"
      }`,
      "bidboard-note-not-verified",
    );
  } catch (err: any) {
    // Belt and braces: nothing in here may throw at the caller, which is mid-create. fail() also
    // cancels the editor, so a throw after fill() cannot strand a half-typed draft on the shared page.
    return await fail(err?.message ?? String(err), "bidboard-note-error");
  }
}
