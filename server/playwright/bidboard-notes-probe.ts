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
 * resolveEditorScopes, findVisibleMatch, findVisibleRoleMatch, actableCandidates, readNoteTextsDetailed,
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
  readNoteTextsDetailed,
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
  /** Number of matching nodes, or null when the query itself failed (NOT the same as zero). */
  count: number | null;
  /** True/false, or null when it could not be determined. Never optimistically false. */
  visible: boolean | null;
  /** Index of the first VISIBLE match. > 0 means the earlier matches are hidden duplicates. */
  visibleIndex: number | null;
  /** Which editor container this row was probed in, for the post-add rows. */
  scope?: string;
};

export type NotesProbeResult = {
  url: string | null;
  overviewTabVisible: boolean | null;
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
  /** True when the add control could not be clicked — the editor probe is then NOT run. */
  addClickFailed: boolean;
  overviewTabClickFailed: boolean;
  /**
   * Everything that could not be determined. Non-empty means parts of this report are unknown rather
   * than negative — read it before concluding a selector is absent.
   */
  problems: string[];
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

  const problems: string[] = [];
  const overviewTab = page.locator(PROCORE_SELECTORS.bidboard.projectOverviewTab).first();
  const overviewTabVisible = await overviewTab.isVisible().catch(() => null);
  let overviewTabClickFailed = false;
  if (overviewTabVisible) {
    const clicked = await overviewTab
      .click({ timeout: 10000 })
      .then(() => true)
      .catch((err: any) => {
        // Everything below inspects a page that may not be showing Overview. Say so rather than
        // reporting the resulting absences as if they were selector facts.
        problems.push(`Overview tab click failed: ${err?.message ?? err}`);
        return false;
      });
    overviewTabClickFailed = !clicked;
    await randomDelay(1500, 2500);
  }

  // Per-candidate match report: the whole point of the route. It says WHICH tier is (or isn't)
  // carrying each step instead of a single yes/no for a CSS union, and `actable` says whether the
  // automation is allowed to use it at all.
  const probe = async (
    tiers: { precise: string[]; scopedOnly?: string[]; loose?: string[] } | string[],
    scope: { locator: (s: string) => any } = page,
    scopeLabel = "",
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
        // The SAME walk the automation uses, and it now returns the count and the probe-failure flag
        // too — so this no longer runs its own count() alongside it, and no longer loses the
        // distinction the walk made internally.
        const match = await findVisibleMatch(scope as any, selector);
        // `probeFailed` with no hit means UNKNOWN, not "absent". Reporting false there would read as
        // "this hook isn't on the page" and send the operator hunting for a replacement, when the
        // truth is "re-run, an SPA rerender interrupted us".
        const unknown = match.hit === null && match.probeFailed;
        if (unknown) {
          problems.push(`Could not determine visibility for ${selector}${scopeLabel ? ` in the ${scopeLabel}` : ""}`);
        }
        rows.push({
          selector,
          tier,
          actable: actableSet.has(selector),
          count: match.count,
          visible: unknown ? null : match.hit !== null,
          visibleIndex: match.hit?.index ?? null,
        });
      }
    }
    return rows;
  };

  /** The Create button's role fallback, probed exactly as production resolves it. */
  const probeCreateRole = async (scope: ProbePage): Promise<NotesProbeRow> => {
    // `count` is the NUMBER OF MATCHES, taken from the locator — not `hit.index + 1`, which is the
    // POSITION of the first visible one, and which reported 0 when every match was hidden. "Zero
    // matches" and "three matches, all hidden" are opposite diagnoses: the first says the role
    // fallback is wrong, the second says it is right but the page renders hidden duplicates.
    const match = await findVisibleRoleMatch(scope as any, CREATE_BUTTON_ROLE);
    const unknown = match.hit === null && match.probeFailed;
    if (unknown) problems.push(`Could not determine visibility for the Create role fallback`);
    return {
      selector: ROLE_MATCH_LABEL,
      tier: "roleFallback",
      actable: true,
      // The NUMBER OF MATCHES from the shared walk — not the position of the first visible one.
      count: match.count,
      visible: unknown ? null : match.hit !== null,
      visibleIndex: match.hit?.index ?? null,
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
    } catch (err: any) {
      sectionHtml = null;
      problems.push(`Notes-section HTML capture failed: ${err?.message ?? err}`);
    }
  }
  // readNoteTextsDetailed, not allTextContents: the idempotency guard reads the union of the item selectors
  // AND the container's own text, so anything else would report texts the guard never sees.
  const noteRead = sectionLocator ? await readNoteTextsDetailed(sectionLocator) : { texts: [], failed: false };
  const noteTexts = noteRead.texts;
  if (noteRead.failed) problems.push("Could not fully read the existing notes; markerAlreadyPresent is unknown");
  // Would production SKIP this project as already-noted? That distinguishes "the automation is working
  // and has nothing to do" from "the selectors are broken", which look identical from the outside.
  // A failed read reports UNKNOWN, never `false` — false means "safe to post", the favourable answer.
  const markerAlreadyPresent = !sectionLocator || noteRead.failed ? null : hasMarkerNote(noteTexts);

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
    } catch (err: any) {
      buttons = [];
      // An empty button dump reads as "this page has no buttons", which would be a bizarre and
      // misleading finding on a Procore project page.
      problems.push(`Button dump failed: ${err?.message ?? err}`);
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
  const matchedAddButton = candidates.addButtonInSection.find((row) => row.visible === true && row.actable)?.selector ?? null;

  let editorScopeLabels: string[] = [];
  let inputWouldBeRefused: boolean | null = null;
  let editorOpened = false;
  let editorScreenshotPath: string | null = null;

  let addClickFailed = false;
  if (openEditor && sectionLocator && matchedAddButton) {
    // Click the node the WALK found, not `.first()`.
    const addTarget = (await findVisibleMatch(sectionLocator as any, matchedAddButton)).hit;
    if (!addTarget) {
      addClickFailed = true;
      problems.push("The add control vanished between probing and clicking; the editor was not opened");
    } else {
      const clicked = await addTarget.locator
        .click({ timeout: 10000 })
        .then(() => true)
        .catch((err: any) => {
          problems.push(`Add-control click failed: ${err?.message ?? err}`);
          return false;
        });
      addClickFailed = !clicked;
    }
    await randomDelay(1500, 2500);
  }

  // STOP if the click did not land. Carrying on would inspect a section/dialog that never opened an
  // editor, where pre-existing editor-shaped controls get reported as though they were the notes
  // editor — and those rows are what an operator substitutes into the automation. A prober that says
  // "here's the editor" when no editor opened is worse than one that says nothing.
  if (openEditor && sectionLocator && matchedAddButton && !addClickFailed) {
    // resolveEditorScopes applies production's dialog rule: visible AND uncontaminated, with the
    // section retained as a second scope. Probing a dialog production would REJECT (or skipping the
    // inline section because a dialog happens to be visible) is the exact inverse of this route's job.
    const editorScopes = await resolveEditorScopes(page as any, sectionLocator as any);
    editorScopeLabels = editorScopes.map((scope) => scope.label);
    candidates.inputAfterAdd = [];
    candidates.createButtonAfterAdd = [];
    for (const { label, scope } of editorScopes) {
      const inputRows = (await probe(NOTES.input, scope as any, label)).map((row) => ({ ...row, scope: label }));
      const createRows = [...(await probe(NOTES.createButton, scope as any, label)), await probeCreateRole(scope as any)].map((row) => ({
        ...row,
        scope: label,
      }));
      candidates.inputAfterAdd.push(...inputRows);
      candidates.createButtonAfterAdd.push(...createRows);
    }
    editorOpened = candidates.inputAfterAdd.some((row) => row.visible === true && row.actable);

    // Would the fill be refused by the description guard? Report it, rather than leaving the operator
    // to discover it only when a real post declines.
    const resolvedInput = candidates.inputAfterAdd.find((row) => row.visible === true && row.actable);
    let resolvedInputLocator: any = null;
    if (resolvedInput) {
      const scopeForInput = editorScopes.find((scope) => scope.label === resolvedInput.scope);
      const inputHit = scopeForInput ? (await findVisibleMatch(scopeForInput.scope as any, resolvedInput.selector)).hit : null;
      resolvedInputLocator = inputHit?.locator ?? null;
      inputWouldBeRefused = inputHit ? await isForbiddenFillTarget(inputHit.locator) : null;
    }

    editorScreenshotPath = await takeScreenshot(page as any, `${prefix}-editor`).catch(() => null);
    // Leave the page clean for whatever runs next under the browser lock — the same helper production
    // uses on every post-fill exit, and with the editor locator so the close is VERIFIED rather than
    // assumed from the keypress (Procore's mention picker eats the first Escape).
    const cancel = await cancelEditor(page as any, resolvedInputLocator ?? undefined);
    if (cancel.closed !== true) {
      const state = cancel.closed === false ? "is still open" : "could not be confirmed closed";
      problems.push(`The note editor ${state} after ${cancel.attempts} cancel attempt(s) — the shared page may not be clean`);
    }
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
    addClickFailed,
    overviewTabClickFailed,
    problems,
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
          : addClickFailed
            ? "the add control could not be clicked, so the editor never opened — the input/Create rows below are NOT selector evidence"
            : null,
    screenshotPath,
    editorScreenshotPath,
  };
}
