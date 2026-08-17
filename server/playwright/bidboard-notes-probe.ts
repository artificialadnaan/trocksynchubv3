/**
 * BidBoard Notes selector prober — the diagnostic twin of bidboard-notes.ts
 * ========================================================================
 *
 * Reports, for a Bid Board project page, exactly what the note automation WOULD do: which Notes
 * section it would resolve (and why it would refuse), which selector tier is carrying each step,
 * whether the project already has a CRM note, which containers it would look for the editor in, and
 * whether the fill target would be refused as a description field.
 *
 * Why this lives in its own module rather than inline in the route:
 *
 * Its output is the basis for a human decision — an operator reads it and substitutes real Procore
 * hooks into an automation that types into live projects. Every safety property of that automation
 * (the selector tiers, the contamination check, the refusal posture) rests on those hooks being right,
 * which rests on this report being accurate. An unverified diagnostic gating a risky decision is the
 * weakest link in the chain, so it is extracted to a plain function over a page-LIKE object and driven
 * by the scope-aware fake DOM in tests/bidboard-project-note.test.ts. The Express route keeps only
 * HTTP, auth, the browser lock, navigation and the audit row.
 *
 * Every decision here is delegated to the shared resolvers in bidboard-notes.ts — resolveNotesSection,
 * resolveEditorScopes, findVisibleMatch, findVisibleRoleMatch, actableCandidates, readNoteTexts,
 * hasMarkerNote, isForbiddenFillTarget, cancelEditor. Nothing about "what the automation would do" is
 * re-derived locally; if it were, this report could confidently describe behaviour production does not
 * have. The ONE deliberate difference is deadlines: production runs inside the global browser lock and
 * declines rather than wait, while this is human-invoked and interactive, so it waits as long as the
 * page takes.
 *
 * @module playwright/bidboard-notes-probe
 */

import { PROCORE_SELECTORS } from "./selectors";
import { randomDelay, takeScreenshot } from "./browser";
import {
  CREATE_BUTTON_ROLE,
  ROLE_MATCH_LABEL,
  actableCandidates,
  cancelEditor,
  findVisibleMatch,
  findVisibleRoleMatch,
  hasMarkerNote,
  isForbiddenFillTarget,
  readNoteTexts,
  resolveEditorScopes,
  resolveNotesSection,
  type NotesSectionResolution,
} from "./bidboard-notes";

const MAX_HTML_CHARS = 20000;
const MAX_BUTTONS_DUMPED = 120;

/** The slice of Playwright's Page this prober actually uses — so a fake DOM can stand in for it. */
export type ProbePage = {
  locator: (selector: string) => any;
  getByRole?: (role: any, options?: any) => any;
  keyboard?: { press: (key: string) => Promise<void> };
  url?: () => string;
};

export type NotesProbeRow = {
  selector: string;
  tier: string;
  /** Whether the AUTOMATION would act on this selector — from actableCandidates(), not a local rule. */
  actable: boolean;
  count: number;
  visible: boolean;
  /** Index of the first VISIBLE match. > 0 means the earlier matches are hidden duplicates. */
  visibleIndex: number | null;
  /** Which editor container this row was probed in, for the post-add rows. */
  scope?: string;
};

export type NotesProbeResult = {
  url: string | null;
  overviewTabVisible: boolean;
  sectionVerdict:
    | { ok: true; selector: string }
    | { ok: false; reason: NotesSectionResolution extends { ok: false } ? string : string; selector: string | null; message: string };
  matchedSection: string | null;
  looseSectionOnly: boolean;
  sectionContaminated: boolean;
  /** True when production would SKIP this project because a CRM note is already there. */
  markerAlreadyPresent: boolean | null;
  noteTexts: string[];
  sectionHtml: string | null;
  sectionHtmlTruncated: boolean;
  buttons: Array<Record<string, unknown>>;
  candidates: Record<string, NotesProbeRow[]>;
  matchedAddButton: string | null;
  editorScopeLabels: string[];
  editorOpened: boolean;
  /** True when the resolved editor would be rejected by the description guard. */
  inputWouldBeRefused: boolean | null;
  editorProbeSkippedReason: string | null;
  screenshotPath: string | null;
  editorScreenshotPath: string | null;
};

export type ProbeOptions = {
  /** Used only in messages, so the operator sees which project the verdict is about. */
  projectLabel?: string;
  /** Click the "+" to reveal the editor/Create selectors. Never commits — only Create would. */
  openEditor?: boolean;
  /** Passed to resolveNotesSection; keeps test runs fast. */
  sectionTimeoutMs?: number;
  /** Prefix for the two screenshots. Callers must sanitise it — it reaches a file path. */
  screenshotPrefix?: string;
};

/**
 * Probe the Notes UI. Read-only apart from an optional "+" click, which is reverted with Escape.
 * Never throws: every step is defensive, because this runs against a live page.
 */
export async function probeBidBoardNotesUi(page: ProbePage, options: ProbeOptions = {}): Promise<NotesProbeResult> {
  const NOTES = PROCORE_SELECTORS.bidboard.newUi.notes;
  const openEditor = options.openEditor !== false;
  const prefix = options.screenshotPrefix ?? "bidboard-project-note";

  const overviewTab = page.locator(PROCORE_SELECTORS.bidboard.projectOverviewTab).first();
  const overviewTabVisible = await overviewTab.isVisible().catch(() => false);
  if (overviewTabVisible) {
    await overviewTab.click({ timeout: 10000 }).catch(() => {});
    await randomDelay(1500, 2500);
  }

  // Per-candidate match report: the whole point of the route. It says WHICH tier is (or isn't)
  // carrying each step instead of a single yes/no for a CSS union, and `actable` says whether the
  // automation is allowed to use it at all.
  const probe = async (
    tiers: { precise: string[]; scopedOnly?: string[]; loose?: string[] } | string[],
    scope: { locator: (s: string) => any } = page,
  ): Promise<NotesProbeRow[]> => {
    const groups: Array<[string, string[]]> = Array.isArray(tiers)
      ? [["flat", tiers]]
      : [["precise", tiers.precise], ["scopedOnly", tiers.scopedOnly ?? []], ["loose", tiers.loose ?? []]];
    // The actable set comes from the shared function so "would the automation use this?" cannot drift
    // from what the automation actually does.
    const actableSet = new Set(Array.isArray(tiers) ? tiers : actableCandidates(tiers));
    const rows: NotesProbeRow[] = [];
    for (const [tier, candidateList] of groups) {
      for (const selector of candidateList) {
        const count = await scope.locator(selector).count().catch(() => -1);
        // The SAME visible-match walk the automation uses. Probing `.first()` here would report
        // visible:false for a selector whose first match is a hidden responsive/template duplicate —
        // a selector the automation happily uses.
        const hit = count > 0 ? await findVisibleMatch(scope as any, selector) : null;
        rows.push({ selector, tier, actable: actableSet.has(selector), count, visible: hit !== null, visibleIndex: hit?.index ?? null });
      }
    }
    return rows;
  };

  /** The Create button's role fallback, probed exactly as production resolves it. */
  const probeCreateRole = async (scope: ProbePage): Promise<NotesProbeRow> => {
    const hit = await findVisibleRoleMatch(scope as any, CREATE_BUTTON_ROLE);
    return {
      selector: ROLE_MATCH_LABEL,
      tier: "roleFallback",
      actable: true,
      count: hit ? hit.index + 1 : 0,
      visible: hit !== null,
      visibleIndex: hit?.index ?? null,
    };
  };

  const candidates: Record<string, NotesProbeRow[]> = {
    section: await probe(NOTES.section),
    addButton: await probe(NOTES.addButton),
    item: await probe(NOTES.item),
    // Probed page-wide BEFORE the editor is open, so these two are expected to be empty/irrelevant
    // here; the meaningful numbers are the *AfterAdd variants below.
    input: await probe(NOTES.input),
    createButton: await probe(NOTES.createButton),
  };

  // THE verdict — section resolution, the precise-only rule, the loose-only refusal and the
  // contamination check all come from resolveNotesSection, the same call production makes.
  const sectionResolution = await resolveNotesSection(page as any, {
    timeoutMs: options.sectionTimeoutMs,
    projectLabel: options.projectLabel,
  });
  const sectionLocator = sectionResolution.ok ? sectionResolution.locator : null;
  const matchedSection = sectionResolution.ok ? sectionResolution.selector : null;
  const looseSectionOnly = !sectionResolution.ok && sectionResolution.reason === "loose-only";
  const sectionContaminated = !sectionResolution.ok && sectionResolution.reason === "contaminated";

  let sectionHtml: string | null = null;
  if (sectionLocator) {
    try {
      sectionHtml = (((await sectionLocator.evaluate((el: Element) => el.outerHTML)) as string) || "").slice(0, MAX_HTML_CHARS);
    } catch {
      sectionHtml = null;
    }
  }
  // readNoteTexts, not allTextContents: the idempotency guard reads the union of the item selectors
  // AND the container's own text, so anything else would report texts the guard never sees.
  const noteTexts = sectionLocator ? await readNoteTexts(sectionLocator) : [];
  // Would production SKIP this project as already-noted? That distinguishes "the automation is working
  // and has nothing to do" from "the selectors are broken", which look identical from the outside.
  const markerAlreadyPresent = sectionLocator ? hasMarkerNote(noteTexts) : null;

  // When no section matched, dump every button on the page so the operator can spot the real add
  // control (its label/aria-label/class is what the selectors need to become).
  let buttons: Array<Record<string, unknown>> = [];
  if (!matchedSection) {
    try {
      buttons = await page.locator("button").evaluateAll((els: Element[]) =>
        els.slice(0, 120).map((el) => ({
          text: (el.textContent || "").trim().slice(0, 60),
          ariaLabel: el.getAttribute("aria-label"),
          className: (el.getAttribute("class") || "").slice(0, 160),
          dataQa: el.getAttribute("data-qa"),
        })),
      );
    } catch {
      buttons = [];
    }
  }
  buttons = buttons.slice(0, MAX_BUTTONS_DUMPED);

  const screenshotPath = await takeScreenshot(page as any, `${prefix}-probe`).catch(() => null);

  // ONLY probe/click an add control inside a RESOLVED, uncontaminated Notes section. Clicking off the
  // page-wide sweep would let the prober hit the first unrelated "Add"/"+" on a live project —
  // precisely when no Notes section was found, which is the situation this route exists to diagnose —
  // and then report that unrelated widget's textbox and Create button as successful validation. Wrong
  // validation is worse than none, because it is acted on.
  candidates.addButtonInSection = sectionLocator ? await probe(NOTES.addButton, sectionLocator) : [];
  const matchedAddButton = candidates.addButtonInSection.find((row) => row.visible && row.actable)?.selector ?? null;

  let editorScopeLabels: string[] = [];
  let inputWouldBeRefused: boolean | null = null;
  let editorOpened = false;
  let editorScreenshotPath: string | null = null;

  if (openEditor && sectionLocator && matchedAddButton) {
    // Click the node the WALK found, not `.first()`.
    const addTarget = await findVisibleMatch(sectionLocator as any, matchedAddButton);
    await addTarget?.locator.click({ timeout: 10000 }).catch(() => {});
    await randomDelay(1500, 2500);

    // resolveEditorScopes applies production's dialog rule: visible AND uncontaminated, with the
    // section retained as a second scope. Probing a dialog production would REJECT (or skipping the
    // inline section because a dialog happens to be visible) is the exact inverse of this route's job.
    const editorScopes = await resolveEditorScopes(page as any, sectionLocator as any);
    editorScopeLabels = editorScopes.map((scope) => scope.label);
    candidates.inputAfterAdd = [];
    candidates.createButtonAfterAdd = [];
    for (const { label, scope } of editorScopes) {
      const inputRows = (await probe(NOTES.input, scope as any)).map((row) => ({ ...row, scope: label }));
      const createRows = [...(await probe(NOTES.createButton, scope as any)), await probeCreateRole(scope as any)].map((row) => ({
        ...row,
        scope: label,
      }));
      candidates.inputAfterAdd.push(...inputRows);
      candidates.createButtonAfterAdd.push(...createRows);
    }
    editorOpened = candidates.inputAfterAdd.some((row) => row.visible && row.actable);

    // Would the fill be refused by the description guard? Report it, rather than leaving the operator
    // to discover it only when a real post declines.
    const resolvedInput = candidates.inputAfterAdd.find((row) => row.visible && row.actable);
    if (resolvedInput) {
      const scopeForInput = editorScopes.find((scope) => scope.label === resolvedInput.scope);
      const inputHit = scopeForInput ? await findVisibleMatch(scopeForInput.scope as any, resolvedInput.selector) : null;
      inputWouldBeRefused = inputHit ? await isForbiddenFillTarget(inputHit.locator) : null;
    }

    editorScreenshotPath = await takeScreenshot(page as any, `${prefix}-editor`).catch(() => null);
    // Leave the page clean for whatever runs next under the browser lock — the same helper production
    // uses on every post-fill exit.
    await cancelEditor(page as any);
  }

  return {
    url: page.url?.() ?? null,
    overviewTabVisible,
    // The shared resolver's verdict verbatim — the same string production would log.
    sectionVerdict: sectionResolution.ok
      ? { ok: true, selector: sectionResolution.selector }
      : {
          ok: false,
          reason: sectionResolution.reason,
          selector: sectionResolution.selector,
          message: sectionResolution.message,
        },
    matchedSection,
    looseSectionOnly,
    sectionContaminated,
    markerAlreadyPresent,
    noteTexts,
    sectionHtml,
    sectionHtmlTruncated: Boolean(sectionHtml && sectionHtml.length >= MAX_HTML_CHARS),
    buttons,
    candidates,
    matchedAddButton,
    editorScopeLabels,
    editorOpened,
    inputWouldBeRefused,
    editorProbeSkippedReason: !openEditor
      ? null
      : !sectionResolution.ok
        // Verbatim from the shared resolver, so the reason the prober declines is word-for-word the
        // reason production would decline.
        ? `${sectionResolution.message} (the automation would refuse here too)`
        : !matchedAddButton
          ? "no add control matched INSIDE the resolved Notes section"
          : null,
    screenshotPath,
    editorScreenshotPath,
  };
}
