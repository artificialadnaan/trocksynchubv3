import { beforeEach, describe, expect, it, vi } from "vitest";

// bidboard-notes imports navigateToProject from bidboard.ts (which pulls db/storage at import time) and
// the browser helpers — stub them so the module loads and the delays don't slow the suite. The REAL
// createBidBoardProjectFromDeal fail-open wiring is covered separately in bidboard-note-fail-open.test.ts,
// which mocks the other direction.
const navigateToProjectMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../server/playwright/bidboard.ts", () => ({ navigateToProject: navigateToProjectMock }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({
  // Yields a MACROTASK, not just a microtask. An `async () => {}` mock makes the polling loops spin in
  // microtasks and starve the timer queue, so anything the page renders on a setTimeout (i.e. any
  // simulated async render) could never appear — the loop would look broken when it is not.
  randomDelay: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
  takeScreenshot: vi.fn(async () => ".playwright-storage/shot.png"),
}));

const {
  postBidBoardProjectNote,
  hasMarkerNote,
  clampNoteForProcore,
  CRM_ACTIVITY_NOTE_MARKER,
  NOTE_HARD_CHAR_CAP,
  MIN_NAVIGATION_BUDGET_MS,
  resolveNotesSection,
  resolveNotesSectionByAnchor,
  resolveEditorScopes,
  findVisibleRoleMatch,
  actableCandidates,
  isForbiddenFillTarget,
  cancelEditor,
  CREATE_BUTTON_ROLE,
} = await import("../server/playwright/bidboard-notes.ts");
const { probeBidBoardNotesUi } = await import("../server/playwright/bidboard-notes-probe.ts");

const NOTE = [
  "CRM Activity Log — DFW-2-12345-ab (as of Aug 17, 2026)",
  "",
  "Aug 14, 2026 · Call (connected, 15 min) · Jane Rep",
  "  Owner confirmed scope; wants alternates priced.",
].join("\n");

// ---------------------------------------------------------------------------------------------
// A scope-aware fake DOM.
//
// The previous version of this stub resolved every selector against one flat set and ignored the
// parent locator, which made `firstVisible(section, …)` and `firstVisible(page, …)` identical — so the
// section scoping (the single property that keeps the note out of Procore's Project Description) could
// have been deleted with every test still green. This models real containment instead: a child lookup
// MISSES when the element is not inside the parent.
// ---------------------------------------------------------------------------------------------
type FakeNode = {
  id: string;
  parent?: string;
  /** Selector strings this element matches (use the literal strings from PROCORE_SELECTORS). */
  matches: string[];
  role?: string;
  /** Accessible name, for getByRole. */
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
  /** Present in the DOM but not visible — a responsive/template duplicate, a collapsed panel. */
  hidden?: boolean;
  onClick?: (dom: FakeDom) => void;
};

type FakeDom = {
  nodes: FakeNode[];
  actions: string[];
  fills: Array<{ id: string; value: string }>;
  keys: string[];
  /**
   * Inject query failures, so tests can distinguish "the page says no" from "we could not tell".
   * Those two must never produce the same report.
   */
  fail?: {
    count?: (selector: string) => boolean;
    innerText?: (nodeId: string) => boolean;
    isVisible?: (nodeId: string) => boolean;
    keyboard?: boolean;
  };
  /**
   * How many Escapes it takes to actually close the editor. Procore's mention picker (opened by "@" in
   * the note body) eats the first one, so a delivered keypress is not a closed editor.
   */
  escapesToClose?: number;
};

const node = (dom: FakeDom, id: string) => dom.nodes.find((n) => n.id === id);
const removeNode = (dom: FakeDom, id: string) => {
  dom.nodes = dom.nodes.filter((n) => n.id !== id);
};

function isWithin(dom: FakeDom, candidate: FakeNode, ancestorIds: string[]): boolean {
  let current: FakeNode | undefined = candidate;
  const seen = new Set<string>();
  while (current?.parent && !seen.has(current.parent)) {
    if (ancestorIds.includes(current.parent)) return true;
    seen.add(current.parent);
    current = node(dom, current.parent);
  }
  return false;
}

/** Descendant text, so a container's innerText includes its notes AND any open editor's content. */
function textOf(dom: FakeDom, target: FakeNode): string {
  const parts = [target.text ?? ""];
  for (const candidate of dom.nodes) {
    if (isWithin(dom, candidate, [target.id])) parts.push(candidate.text ?? "");
  }
  return parts.filter(Boolean).join("\n");
}

function matchNodes(dom: FakeDom, selector: string, within: string[] | null): FakeNode[] {
  const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
  return dom.nodes.filter((candidate) => {
    if (!parts.some((part) => candidate.matches.includes(part))) return false;
    return within === null || isWithin(dom, candidate, within);
  });
}

/**
 * Real Playwright's `locator.locator('xpath=..')` evaluates the xpath relative to each node the
 * current locator resolved to, so it returns that node's IMMEDIATE parent element — the standard
 * way to climb one level in a chain (used by resolveNotesSectionByAnchor's ancestor walk). Modelled
 * here rather than approximated: `.parent` already exists on every FakeNode, so this is a faithful
 * one-line translation of the real semantic, not a softened stand-in for it. Deduped, because two
 * resolved nodes sharing one parent must not fan out into two copies of it.
 */
function parentsOf(dom: FakeDom, current: FakeNode[]): FakeNode[] {
  const parentIds = new Set(current.map((n) => n.parent).filter((id): id is string => Boolean(id)));
  return dom.nodes.filter((n) => parentIds.has(n.id));
}

function makeLocator(dom: FakeDom, resolve: () => FakeNode[], selector = ""): any {
  const locator: any = {
    first: () => makeLocator(dom, () => resolve().slice(0, 1), selector),
    last: () => makeLocator(dom, () => resolve().slice(-1), selector),
    nth: (index: number) => makeLocator(dom, () => resolve().slice(index, index + 1), selector),
    // count() includes hidden nodes, as the real DOM does — that is what makes probing only .first()
    // able to miss a usable control.
    count: async () => {
      if (dom.fail?.count?.(selector)) throw new Error("execution context was destroyed");
      return resolve().length;
    },
    isVisible: async () => {
      const nodes = resolve();
      if (nodes.some((n) => dom.fail?.isVisible?.(n.id))) throw new Error("element is detached");
      return nodes.some((n) => !n.hidden);
    },
    waitFor: async () => {
      if (!resolve().some((n) => !n.hidden)) throw new Error("Timeout waiting for selector");
    },
    allTextContents: async () => resolve().map((n) => textOf(dom, n)),
    innerText: async () => {
      const nodes = resolve();
      if (nodes.some((n) => dom.fail?.innerText?.(n.id))) throw new Error("element is detached");
      return nodes.map((n) => textOf(dom, n)).join("\n");
    },
    getAttribute: async (attr: string) => resolve()[0]?.attrs?.[attr] ?? null,
    // Enough of evaluate/evaluateAll for the prober's HTML + button dumps: the callbacks only read
    // outerHTML / textContent / getAttribute.
    evaluate: async (fn: any) => {
      const target = resolve()[0];
      if (!target) throw new Error("evaluate on nothing");
      return fn({ outerHTML: `<div id="${target.id}">${textOf(dom, target)}</div>` });
    },
    evaluateAll: async (fn: any) =>
      fn(
        resolve().map((n) => ({
          textContent: n.text ?? "",
          getAttribute: (attr: string) => n.attrs?.[attr] ?? null,
        })),
      ),
    click: async () => {
      const target = resolve()[0];
      if (!target) throw new Error("click on nothing");
      dom.actions.push(`click:${target.id}`);
      target.onClick?.(dom);
    },
    fill: async (value: string) => {
      const target = resolve()[0];
      if (!target) throw new Error("fill on nothing");
      dom.actions.push(`fill:${target.id}`);
      dom.fills.push({ id: target.id, value });
      target.text = value;
    },
    locator: (nested: string) =>
      nested === "xpath=.."
        ? makeLocator(dom, () => parentsOf(dom, resolve()), nested)
        : makeLocator(dom, () => matchNodes(dom, nested, resolve().map((n) => n.id)), nested),
    getByRole: (role: string, opts?: { name?: RegExp | string }) =>
      makeLocator(dom, () => matchRole(dom, role, opts, resolve().map((n) => n.id))),
  };
  return locator;
}

function matchRole(dom: FakeDom, role: string, opts: { name?: RegExp | string } | undefined, within: string[] | null) {
  return dom.nodes.filter((candidate) => {
    if (candidate.role !== role) return false;
    if (opts?.name instanceof RegExp && !opts.name.test(candidate.name ?? "")) return false;
    if (typeof opts?.name === "string" && candidate.name !== opts.name) return false;
    return within === null || isWithin(dom, candidate, within);
  });
}

function makePage(dom: FakeDom) {
  return {
    url: () => "https://us02.procore.com/webclients/host/companies/1/tools/bid-board/project/9/details",
    locator: (selector: string) => makeLocator(dom, () => matchNodes(dom, selector, null), selector),
    getByRole: (role: string, opts?: { name?: RegExp | string }) => makeLocator(dom, () => matchRole(dom, role, opts, null)),
    keyboard: {
      press: async (key: string) => {
        if (dom.fail?.keyboard) throw new Error("keyboard is unavailable");
        dom.keys.push(key);
        // Escape closes Procore's editor — but only after any mention picker has swallowed its share.
        if (key === "Escape") {
          const remaining = dom.escapesToClose ?? 1;
          dom.escapesToClose = remaining - 1;
          if (remaining - 1 <= 0) removeNode(dom, "editor");
        }
      },
    },
  } as any;
}

/**
 * The realistic page: a Notes card with an add control, and — crucially — Procore's Project
 * Description textarea OUTSIDE it. The description node matches a bare `textarea` and the
 * description selectors, exactly as the real page does (bidboard.ts resolves it with `textarea`),
 * so any loss of scoping or promotion of the loose tier makes it reachable.
 */
function notesFixture(opts: {
  existingNotes?: string[];
  createRenders?: boolean;
  createClosesEditor?: boolean;
  /** Put the add control outside the Notes card (tests that scoping is real). */
  addButtonOutsideSection?: boolean;
  /** Open the editor outside the section and any dialog (forces the page-wide widening branch). */
  editorOutsideSection?: boolean;
  /** The editor node also looks like a description field (tests the hard refusal). */
  editorLooksLikeDescription?: boolean;
  /** Omit the Notes card entirely. */
  withoutSection?: boolean;
  /** Resolve the "section" to a page-level wrapper that also holds the description. */
  contaminatedSection?: boolean;
  /** Only offer a Create button matching the scopedOnly tier, at page level. */
  createButtonPageLevelLooseOnly?: boolean;
  /** Only offer a Create button discoverable by accessible role/name. */
  createButtonRoleOnly?: boolean;
  /** Extra nodes appended to the fixture. */
  extra?: FakeNode[];
  /** Delay before the editor appears after the add click — models a slow SPA render. */
  editorAppearsAfterMs?: number;
  /** Transform the typed text on save — models Procore TRUNCATING an over-long note. */
  renderTransform?: (typed: string) => string;
  /** Put the editor in a clean dialog and the only Create button in the section. */
  editorInDialogCreateInSection?: boolean;
  /**
   * Model the LIVE page reported 2026-08-18: no `aid-notes` class anywhere, just an exact-text
   * "Notes" label a few levels above a `button:has(svg[data-qa="ci-Plus"])` add control. Everything
   * downstream (editor, createBtn, contamination via `contaminatedSection`) is unchanged — only how
   * the same "notesSection" container gets FOUND differs, so this fixture exercises the anchor-climb
   * path with the same behavioural coverage the `aid-notes` fixtures already have.
   */
  anchorOnly?: boolean;
} = {}): FakeDom {
  const createRenders = opts.createRenders ?? true;
  const createClosesEditor = opts.createClosesEditor ?? true;

  const saveNote = (dom: FakeDom) => {
    const editor = node(dom, "editor");
    if (createRenders && editor) {
      const rendered = (opts.renderTransform ?? ((typed: string) => typed))(editor.text ?? "");
      dom.nodes.push({
        id: `note-${dom.nodes.length}`,
        parent: "notesSection",
        matches: ['div.aid-note'],
        text: `Colby Burling · Aug 17, 2026\n${rendered}`,
      });
    }
    if (createClosesEditor) removeNode(dom, "editor");
  };

  const addEditorNodes = (dom: FakeDom) => {
    if (opts.editorInDialogCreateInSection) {
      dom.nodes.push({ id: "dialog", parent: "page", matches: ['[role="dialog"]'], text: "Add note" });
      dom.nodes.push({ id: "editor", parent: "dialog", matches: ['textarea[name="note"]'], attrs: { name: "note" }, text: "" });
      // The only Create lives in the SECTION — production fixes the scope to the dialog, so it must
      // not count.
      dom.nodes.push({ id: "createBtn", parent: "notesSection", matches: ['button.aid-confirmButton'], role: "button", name: "Create", onClick: saveNote });
      return;
    }
    dom.nodes.push({
      id: "editor",
      parent: opts.editorOutsideSection ? "page" : "notesSection",
      // Found by the PRECISE selector either way; the description case differs only in its attributes,
      // which is exactly what the last-line-of-defence attribute check has to catch.
      matches: ['textarea[name="note"]', 'textarea'],
      attrs: opts.editorLooksLikeDescription ? { name: "project_description" } : { name: "note" },
      text: "",
    });
    if (opts.createButtonRoleOnly) {
      dom.nodes.push({
        id: "createBtn",
        parent: opts.editorOutsideSection ? "page" : "notesSection",
        matches: [],
        role: "button",
        name: "Create",
        onClick: saveNote,
      });
    } else if (opts.createButtonPageLevelLooseOnly) {
      dom.nodes.push({
        id: "createBtn",
        parent: "page",
        matches: ['button:has-text("Create")'],
        role: "button",
        name: "Create New Project",
        onClick: saveNote,
      });
    } else {
      dom.nodes.push({
        id: "createBtn",
        parent: opts.editorOutsideSection ? "page" : "notesSection",
        matches: ['button.aid-confirmButton'],
        role: "button",
        name: "Create",
        onClick: saveNote,
      });
    }
  };

  const openEditor = (dom: FakeDom) => {
    if (opts.editorAppearsAfterMs) {
      // The editor renders LATE. A single immediate probe misses it; production polls to a deadline.
      setTimeout(() => addEditorNodes(dom), opts.editorAppearsAfterMs);
      return;
    }
    addEditorNodes(dom);
  };

  const nodes: FakeNode[] = [
    { id: "page", matches: [] },
    // Procore's Project Description — same page, OUTSIDE the Notes card. Matches a bare `textarea`.
    {
      id: "descField",
      parent: opts.contaminatedSection ? "notesSection" : "page",
      matches: ['textarea', 'textarea[name="description"]', '[name*="description" i]'],
      attrs: { name: "description" },
      text: "Existing project description — must never be overwritten",
    },
  ];

  if (!opts.withoutSection) {
    if (opts.anchorOnly) {
      // The card itself carries no class and no text of its own — the "Notes" label is a HEADING
      // node nested inside it, exactly as a real card renders (<div class="card"><h3>Notes</h3>…).
      // holdsNotesLabel does a genuine DESCENDANT search (the only thing Playwright's `.locator()`
      // scoping can do), so self-labelling the container — the first version of this fixture did
      // that — would silently test something no real page produces.
      nodes.push({ id: "notesSection", parent: "page", matches: [], text: "" });
      nodes.push({ id: "notesLabel", parent: "notesSection", matches: [':text-is("Notes")'], text: "Notes" });
      // Two unclassed wrappers between the card and the button — the anchor climb has to pass through
      // them rather than landing on the label in one hop, matching the reported live nesting.
      nodes.push({ id: "notesWrap1", parent: "notesSection", matches: [] });
      nodes.push({ id: "notesWrap2", parent: "notesWrap1", matches: [] });
      nodes.push({
        id: "addBtn",
        parent: opts.addButtonOutsideSection ? "page" : "notesWrap2",
        matches: ['button:has(svg[data-qa="ci-Plus"])'],
        onClick: openEditor,
      });
    } else {
      nodes.push({
        id: "notesSection",
        parent: "page",
        matches: ['div.aid-notes', '[class*="aid-notes"]'],
        text: "Notes",
      });
      nodes.push({
        id: "addBtn",
        parent: opts.addButtonOutsideSection ? "page" : "notesSection",
        matches: ['button.aid-add-note'],
        onClick: openEditor,
      });
    }
  }

  for (const existing of opts.existingNotes ?? []) {
    nodes.push({ id: `existing-${nodes.length}`, parent: "notesSection", matches: ['div.aid-note'], text: existing });
  }
  nodes.push(...(opts.extra ?? []));

  return { nodes, actions: [], fills: [], keys: [] };
}

/** Short windows so the "not verified" paths don't spend the real polling/wall-clock budget. */
const FAST = { verifyTimeoutMs: 50, overallTimeoutMs: 1200, stepTimeoutMs: 20 };

describe("hasMarkerNote", () => {
  it("matches a marker embedded in a rendered note's author/date chrome", () => {
    expect(hasMarkerNote(["Colby Burling  Aug 17, 2026\nCRM Activity Log — DFW-2-12345-ab (as of Aug 17, 2026)"])).toBe(true);
  });

  it("tolerates dash and whitespace re-rendering", () => {
    expect(hasMarkerNote(["CRM Activity Log -  ATL-5-99999-zz (as of ...)"])).toBe(true);
  });

  it("matches ANY CRM activity note in this project, whatever label it carries", () => {
    // Project-scoped by design: Procore's notes are already per-project, so the label adds no
    // discrimination — and keying on it made `DFW-4-16226-a` collide with `DFW-4-16226-ab`, and could
    // never match at all for a deal whose CRM heading falls back to the deal NAME.
    expect(hasMarkerNote(["CRM Activity Log — Some Deal Name Without A Number (as of Aug 1, 2026)"])).toBe(true);
  });

  it("is false for unrelated notes and for an empty list", () => {
    expect(hasMarkerNote(["Walked the roof with the owner today"])).toBe(false);
    expect(hasMarkerNote([])).toBe(false);
  });
});

describe("clampNoteForProcore", () => {
  it("leaves a normal note untouched", () => {
    expect(clampNoteForProcore(NOTE)).toBe(NOTE);
  });

  it("clamps a runaway note but keeps the marker line intact", () => {
    const huge = `${NOTE}\n${"x".repeat(50_000)}`;
    const clamped = clampNoteForProcore(huge);
    expect(clamped.length).toBe(NOTE_HARD_CHAR_CAP);
    expect(clamped.startsWith(CRM_ACTIVITY_NOTE_MARKER)).toBe(true);
    expect(clamped.endsWith("… (truncated)")).toBe(true);
    expect(hasMarkerNote([clamped])).toBe(true);
  });
});

describe("postBidBoardProjectNote", () => {
  beforeEach(() => {
    navigateToProjectMock.mockReset();
    navigateToProjectMock.mockResolvedValue(true);
  });

  it("posts the note when no marker note exists yet", async () => {
    const dom = notesFixture();
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(result.error).toBeUndefined();
    expect(dom.actions).toEqual(["click:addBtn", "fill:editor", "click:createBtn"]);
    expect(dom.fills).toEqual([{ id: "editor", value: NOTE }]);
  });

  it("NEVER fills Procore's Project Description when the note editor cannot be found", async () => {
    // THE data-corruption case. The description textarea is on this page, outside the Notes card, and
    // matches a bare `textarea`. If the loose tier were actable, or the section scoping were dropped,
    // the page-wide widening would resolve to it, `.fill()` would erase the description and the Create
    // click would blur-save 8 KB of activity log over it — with fail-open reporting success.
    const dom = notesFixture();
    node(dom, "addBtn")!.onClick = () => {}; // add control clicks, but no editor appears
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/note editor not found/i);
    expect(dom.fills).toEqual([]);
    expect(node(dom, "descField")!.text).toBe("Existing project description — must never be overwritten");
  });

  it("refuses by ATTRIBUTE when the resolved editor looks like a description field", async () => {
    // Independent of selectors: even if a candidate somehow resolves to a description field, the
    // attribute check immediately before typing must stop it.
    const dom = notesFixture({ editorLooksLikeDescription: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/refusing to type .* into a description field/i);
    expect(dom.fills).toEqual([]);
  });

  it("refuses a page-level wrapper masquerading as the Notes section", async () => {
    // A container that also holds the description field is not the Notes card — acting inside it would
    // make every "scoped" search below it unscoped in practice.
    const dom = notesFixture({ contaminatedSection: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/refusing to act inside a page-level wrapper/i);
    expect(dom.actions).toEqual([]);
    expect(dom.fills).toEqual([]);
  });

  it("reports not-found and fills nothing when the Notes selectors miss entirely", async () => {
    const dom = notesFixture({ withoutSection: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/notes section not found/i);
    expect(dom.actions).toEqual([]);
    expect(dom.fills).toEqual([]);
  });

  it("will not click an add control that lives OUTSIDE the Notes section", async () => {
    // Proves the section scoping is real: the same button, moved out of the card, must not be found.
    const dom = notesFixture({ addButtonOutsideSection: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.error).toMatch(/add-note control not found/i);
    expect(dom.actions).toEqual([]);
  });

  it("SKIPS when a marker note already exists — no add, no fill, no Create", async () => {
    const dom = notesFixture({
      existingNotes: ["Colby Burling · Aug 16, 2026\nCRM Activity Log — DFW-2-12345-ab (as of Aug 16, 2026)"],
    });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(dom.actions).toEqual([]);
    expect(dom.fills).toEqual([]);
  });

  it("finds an existing note through the container text even when an unrelated <li> is present", async () => {
    // The `item` list ends in a bare `li`. If the reader returned on the first candidate that yielded
    // ANY text, this menu item would satisfy it, the container-text fallback would never run, the
    // marker would be missed and a duplicate ~8 KB note posted on every retry.
    const dom = notesFixture({
      extra: [
        { id: "menuItem", parent: "notesSection", matches: ['li'], text: "Edit" },
        { id: "menuItem2", parent: "notesSection", matches: ['li'], text: "Delete" },
        // A previously posted note rendered with markup none of the `item` selectors match.
        { id: "renderedNote", parent: "notesSection", matches: [], text: "CRM Activity Log — DFW-2-12345-ab (as of Aug 16, 2026)" },
      ],
    });

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(dom.fills).toEqual([]);
  });

  it("uses the anchored role fallback when no CSS candidate matches the Create button", async () => {
    const dom = notesFixture({ createButtonRoleOnly: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(result.matched?.createButton).toMatch(/role=button/);
  });

  it("DECLINES when the editor renders outside the Notes section — no page-wide widening", async () => {
    // There is no page-wide fallback by design. A page scope is the root cause behind the whole class:
    // the anchored getByRole('button', {name:/^create$/i}) fallback bypasses the selector tiers and
    // would click any unrelated "Create", and `[role="textbox"][contenteditable="true"]` carries no
    // Notes-specific identity, so a rich-text Project Description would satisfy it. When the module
    // cannot positively identify the editor inside a validated container, it declines.
    const dom = notesFixture({ editorOutsideSection: true, createButtonPageLevelLooseOnly: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/note editor not found inside the section/i);
    expect(result.error).toMatch(/declining rather than widening the search to the page/i);
    // Nothing was typed and nothing was clicked outside the section.
    expect(dom.fills).toEqual([]);
    expect(dom.actions).not.toContain("click:createBtn");
  });

  it("does not fill a page-level rich-text editor even when it matches a precise candidate", async () => {
    // `[role="textbox"][contenteditable="true"]` is precise but Notes-agnostic: a rich-text Project
    // Description matches it. Outside the section it must never be reachable.
    const dom = notesFixture();
    node(dom, "addBtn")!.onClick = (d) => {
      d.nodes.push({
        id: "richTextDescription",
        parent: "page",
        matches: ['[role="textbox"][contenteditable="true"]'],
        attrs: { "aria-label": "Project Description" },
        text: "Existing rich-text description",
      });
    };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/note editor not found/i);
    expect(dom.fills).toEqual([]);
    expect(node(dom, "richTextDescription")!.text).toBe("Existing rich-text description");
  });

  it("cancels the editor when the note cannot be verified after saving", async () => {
    const dom = notesFixture({ createRenders: false });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/could not be verified/i);
    expect(dom.keys).toContain("Escape");
  });

  it("does not report success off the text still sitting in an open editor", async () => {
    const dom = notesFixture({ createClosesEditor: false });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/editor is still open/i);
    expect(dom.keys).toContain("Escape");
  });

  it("cancels the editor when the Create button never appears", async () => {
    const dom = notesFixture();
    node(dom, "addBtn")!.onClick = (d) => {
      // The editor opens but no Create button renders — a half-typed 8 KB note must not be left on
      // the shared page for the document sync that runs next under the same browser lock.
      d.nodes.push({ id: "editor", parent: "notesSection", matches: ['textarea[name="note"]'], attrs: { name: "note" }, text: "" });
    };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/create button not found/i);
    expect(dom.fills).toEqual([{ id: "editor", value: NOTE }]);
    expect(dom.keys).toContain("Escape");
    expect(node(dom, "editor")).toBeUndefined();
  });

  it("clamps a runaway note before it reaches Procore", async () => {
    const dom = notesFixture();
    const huge = `${NOTE}\n${"x".repeat(50_000)}`;
    const result = await postBidBoardProjectNote(makePage(dom), "9001", huge, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(true);
    expect(dom.fills[0].value.length).toBe(NOTE_HARD_CHAR_CAP);
  });

  it("gives up between steps when the overall deadline passes, instead of holding the browser lock", async () => {
    // The deadline is checked BETWEEN steps (never by abandoning an in-flight action), so burn it
    // inside the navigation and assert the next step declines.
    const dom = notesFixture();
    navigateToProjectMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, MIN_NAVIGATION_BUDGET_MS + 80));
      return true;
    });

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", {
      overallTimeoutMs: MIN_NAVIGATION_BUDGET_MS + 20,
      stepTimeoutMs: 20,
    });

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(dom.fills).toEqual([]);
    expect(dom.actions).toEqual([]);
  });

  it("finds a VISIBLE control when the selector's first match is hidden", async () => {
    // Procore's SPA renders responsive/template duplicates. Probing only `.first()` would see the
    // hidden node, reject the selector and decline the whole step — silently, forever.
    const dom = notesFixture();
    const realAdd = node(dom, "addBtn")!;
    dom.nodes = dom.nodes.filter((n) => n.id !== "addBtn");
    dom.nodes.push({ id: "addBtnHidden", parent: "notesSection", matches: ['button.aid-add-note'], hidden: true });
    dom.nodes.push(realAdd);

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(dom.actions).toContain("click:addBtn");
    expect(dom.actions).not.toContain("click:addBtnHidden");
  });

  it("prepends the marker when the CRM sends a body without the heading", async () => {
    // The schema accepts any string. Posting a marker-less body verbatim would create a REAL note that
    // neither the existing-note check nor the verification can see — reported as a failure, and
    // re-submitted as an invisible duplicate on every adopted-project retry.
    const dom = notesFixture();
    const bare = "Aug 14, 2026 · Call · Jane Rep\n  Owner confirmed scope.";

    const result = await postBidBoardProjectNote(makePage(dom), "9001", bare, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    const typed = dom.fills[0].value;
    expect(typed.startsWith("CRM Activity Log — DFW-2-12345-ab")).toBe(true);
    expect(typed).toContain(bare);
    // The guard can now see it, so a re-run skips instead of posting a second copy.
    expect(hasMarkerNote([typed])).toBe(true);
  });

  it("still marks a marker-less body when there is no project number", async () => {
    const dom = notesFixture();
    const result = await postBidBoardProjectNote(makePage(dom), "9001", "just some history", null, FAST);

    expect(result.posted).toBe(true);
    expect(hasMarkerNote([dom.fills[0].value])).toBe(true);
  });

  it("BOUNDS the navigation with the remaining budget instead of abandoning it", async () => {
    // Racing navigateToProject and walking away would leave a `goto` in flight on the SHARED page,
    // which then yanks it out from under the document sync that runs next under the same browser lock.
    // So the budget is passed IN as a timeout — there is never Playwright work we stopped waiting for.
    const dom = notesFixture();
    await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(navigateToProjectMock).toHaveBeenCalledWith(expect.anything(), "9001", {
      timeoutMs: expect.any(Number),
    });
    const passed = (navigateToProjectMock.mock.calls[0] as any[])[2].timeoutMs;
    expect(passed).toBeGreaterThan(0); // never 0 — Playwright reads 0 as "no timeout at all"
    expect(passed).toBeLessThanOrEqual(FAST.overallTimeoutMs);
  });

  it("does not start a navigation it has no budget left to finish", async () => {
    const dom = notesFixture();
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", { overallTimeoutMs: 10 });

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/not enough .* deadline left to navigate/i);
    expect(navigateToProjectMock).not.toHaveBeenCalled();
  });

  it("submits via the role fallback even when a hidden Create precedes the visible one", async () => {
    // The note is ALREADY TYPED by the time the Create button is resolved, so a role fallback that
    // inspects only `.first()` and lands on a hidden responsive/template copy does not merely decline —
    // it cancels a composed note instead of submitting it.
    const dom = notesFixture({
      createButtonRoleOnly: true,
      extra: [{ id: "hiddenCreate", parent: "notesSection", matches: [], role: "button", name: "Create", hidden: true }],
    });

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(result.matched?.createButton).toMatch(/role=button/);
    expect(dom.actions).toContain("click:createBtn");
    expect(dom.actions).not.toContain("click:hiddenCreate");
    expect(dom.keys).not.toContain("Escape"); // the composed note was submitted, not cancelled
  });

  it("clamps post-save verification to the overall deadline, not a fresh window", async () => {
    // A fresh verify window would hold the GLOBAL browser lock for another full period on top of an
    // already-spent budget (e.g. after a slow navigation). Timing assertion with a wide margin: with
    // the clamp this finishes at the overall deadline (~1.3s); without it, it runs the whole 5s verify
    // window on top.
    const dom = notesFixture({ createRenders: false });
    navigateToProjectMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return true;
    });

    const startedAt = Date.now();
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", {
      overallTimeoutMs: MIN_NAVIGATION_BUDGET_MS + 300,
      stepTimeoutMs: 20,
      verifyTimeoutMs: 5000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.posted).toBe(false);
    expect(elapsed).toBeLessThan(3000);
  });

  it("returns an error result (does NOT throw) when navigation fails", async () => {
    navigateToProjectMock.mockResolvedValueOnce(false);
    const result = await postBidBoardProjectNote(makePage(notesFixture()), "9001", NOTE, "DFW-2-12345-ab", FAST);
    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/could not navigate/i);
  });

  it("returns an error result (does NOT throw) when the page blows up", async () => {
    const page: any = { locator: () => { throw new Error("Target page, context or browser has been closed"); } };
    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", FAST);
    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/has been closed/i);
  });

  it("skips an empty note without touching the page", async () => {
    const result = await postBidBoardProjectNote(makePage(notesFixture()), "9001", "   ", "DFW-2-12345-ab", FAST);
    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(navigateToProjectMock).not.toHaveBeenCalled();
  });

  // THE regression test for the live failure reported 2026-08-18: "Only the loose (text-shaped)
  // Notes-section candidates matched … refusing to act". No `aid-notes` class on the page — the note
  // must now post via the structural anchor instead of refusing forever.
  it("posts via the structural anchor when the page has no aid-notes class anywhere", async () => {
    const dom = notesFixture({ anchorOnly: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(dom.fills).toEqual([{ id: "editor", value: NOTE }]);
    expect(dom.actions).toEqual(["click:addBtn", "fill:editor", "click:createBtn"]);
  });

  it("still refuses via the anchor path if the climbed container is contaminated", async () => {
    const dom = notesFixture({ anchorOnly: true, contaminatedSection: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(dom.fills).toEqual([]);
    expect(node(dom, "descField")!.text).toBe("Existing project description — must never be overwritten");
  });
});

// These cover the functions the prober and the production path now SHARE. Testing them directly is the
// point: three review rounds running, the defects were "path A got the rule, path B didn't", so the rule
// is tested once at the shared implementation rather than twice at each caller.
describe("shared resolvers (production and prober call these same functions)", () => {
  const FAST_SECTION = { timeoutMs: 20 };

  describe("resolveNotesSection", () => {
    it("resolves a precise, uncontaminated Notes card", async () => {
      const result = await resolveNotesSection(makePage(notesFixture()), FAST_SECTION);
      expect(result).toMatchObject({ ok: true, selector: "div.aid-notes" });
    });

    it("reports not-found when nothing matches", async () => {
      const result = await resolveNotesSection(makePage(notesFixture({ withoutSection: true })), FAST_SECTION);
      expect(result).toMatchObject({ ok: false, reason: "not-found", selector: null });
    });

    it("reports loose-only when just the text-shaped guesses match", async () => {
      // `:has-text()` returns the OUTERMOST ancestor, so this is a refusal, but the operator needs to
      // know the difference between "nothing there" and "only the docs-shaped guess is there".
      const dom = notesFixture({ withoutSection: true });
      dom.nodes.push({ id: "looseSection", parent: "page", matches: ['section:has-text("Notes")'], text: "Notes" });
      const result = await resolveNotesSection(makePage(dom), FAST_SECTION);
      expect(result).toMatchObject({ ok: false, reason: "loose-only", selector: 'section:has-text("Notes")' });
    });

    it("reports contaminated when the card also holds the Project Description", async () => {
      const result = await resolveNotesSection(makePage(notesFixture({ contaminatedSection: true })), FAST_SECTION);
      expect(result).toMatchObject({ ok: false, reason: "contaminated" });
      expect((result as any).message).toMatch(/page-level wrapper/i);
    });

    // Regression coverage for the live page reported 2026-08-18: NONE of the `aid-notes` guesses
    // exist, so without the anchor fallback this would report "loose-only" and refuse forever.
    it("falls back to the structural anchor when no aid-notes class exists on the page", async () => {
      const result = await resolveNotesSection(makePage(notesFixture({ anchorOnly: true })), FAST_SECTION);
      expect(result).toMatchObject({ ok: true });
      expect((result as any).selector).toContain('svg[data-qa="ci-Plus"]');
    });

    it("still refuses when the anchor path is ALSO contaminated", async () => {
      // Reuses contaminatedSection, which parents descField onto "notesSection" regardless of which
      // tier found that container — proving the contamination check applies identically to a
      // climbed-to container, not just a CSS-matched one.
      const result = await resolveNotesSection(
        makePage(notesFixture({ anchorOnly: true, contaminatedSection: true })),
        FAST_SECTION,
      );
      expect(result).toMatchObject({ ok: false, reason: "not-found" });
    });

    it("prefers a real aid-notes match over the anchor when both exist", async () => {
      // The anchor is a fallback, tried only after `section.precise` misses — if a future Procore
      // build ships a real hook, that hook must still win.
      const dom = notesFixture();
      dom.nodes.push({
        id: "decoyLabel",
        parent: "page",
        matches: [':text-is("Notes")'],
        text: "Notes",
      });
      dom.nodes.push({
        id: "decoyAnchor",
        parent: "decoyLabel",
        matches: ['button:has(svg[data-qa="ci-Plus"])'],
      });
      const result = await resolveNotesSection(makePage(dom), FAST_SECTION);
      expect(result).toMatchObject({ ok: true, selector: "div.aid-notes" });
    });
  });

  describe("resolveNotesSectionByAnchor", () => {
    it("climbs past unclassed wrappers to the labelled, uncontaminated card", async () => {
      const dom = notesFixture({ anchorOnly: true });
      const result = await resolveNotesSectionByAnchor(makePage(dom));
      expect(result).not.toBeNull();
      expect(await result!.locator.getAttribute("data-never-set")).toBeNull(); // it's a real locator
      // The climbed container IS "notesSection" — proven by asking it for the add button it should
      // contain, exactly as production's next step (resolveEditorScopes → click) would.
      const nestedAdd = await result!.locator.locator('button:has(svg[data-qa="ci-Plus"])').count();
      expect(nestedAdd).toBe(1);
    });

    it("skips a decoy '+' button that never climbs to a Notes label, and finds the real one", async () => {
      const dom = notesFixture({ anchorOnly: true });
      // A decoy plus-button elsewhere on the page, inside a DIFFERENT labelled feature ("Internal
      // Notes" is a real, distinct Procore feature — :text-is is an exact match, so it must not
      // collide with "Notes"). The label is a descendant HEADING of the decoy card, same shape as
      // the real one. Pushed FIRST so it is tried before the real anchor.
      dom.nodes.unshift(
        { id: "internalNotesCard", parent: "page", matches: [], text: "" },
        { id: "internalNotesLabel", parent: "internalNotesCard", matches: [':text-is("Internal Notes")'], text: "Internal Notes" },
        { id: "decoyAnchor", parent: "internalNotesCard", matches: ['button:has(svg[data-qa="ci-Plus"])'] },
      );

      const result = await resolveNotesSectionByAnchor(makePage(dom));
      expect(result).not.toBeNull();
      expect(result!.locator).not.toBeNull();
      // It resolved to the REAL card, not the decoy's — proven the same way as the happy-path test.
      const editorHost = await result!.locator.locator('button:has(svg[data-qa="ci-Plus"])').count();
      expect(editorHost).toBe(1);
    });

    it("stops at the FIRST labelled ancestor even if it is contaminated, rather than climbing past it", async () => {
      // A clean, labelled grandparent exists further up — the documented rule says the climb must
      // stop at the nearer labelled-but-contaminated one instead of continuing to find it. Both
      // cards carry their label as a descendant HEADING, not as their own text — the shape a real
      // card renders, and the shape holdsNotesLabel's descendant search actually looks for.
      const dom: FakeDom = {
        nodes: [
          { id: "page", matches: [] },
          { id: "outerCleanCard", parent: "page", matches: [], text: "" },
          { id: "outerCleanLabel", parent: "outerCleanCard", matches: [':text-is("Notes")'], text: "Notes" },
          { id: "outerWrap", parent: "outerCleanCard", matches: [] },
          { id: "innerContaminatedCard", parent: "outerWrap", matches: [], text: "" },
          { id: "innerContaminatedLabel", parent: "innerContaminatedCard", matches: [':text-is("Notes")'], text: "Notes" },
          {
            id: "innerDescField",
            parent: "innerContaminatedCard",
            matches: ['textarea[name="description"]', '[name*="description" i]'],
            attrs: { name: "description" },
          },
          { id: "innerWrap", parent: "innerContaminatedCard", matches: [] },
          { id: "anchorBtn", parent: "innerWrap", matches: ['button:has(svg[data-qa="ci-Plus"])'] },
        ],
        actions: [],
        fills: [],
        keys: [],
      };

      const result = await resolveNotesSectionByAnchor(makePage(dom));
      expect(result).toBeNull();
    });

    it("gives up when the label sits beyond the climb bound", async () => {
      // 10 plain wrappers between the anchor and its label — past ANCHOR_CLIMB_LIMIT (8), so the
      // climb must give up rather than keep going indefinitely. The label is a descendant heading of
      // "farCard", a sibling of the wrapper chain — not an ancestor of any wrapper — so even an
      // unbounded climb could only reach it by reaching farCard itself, which the bound prevents.
      const nodes: FakeNode[] = [
        { id: "page", matches: [] },
        { id: "farCard", parent: "page", matches: [], text: "" },
        { id: "farLabel", parent: "farCard", matches: [':text-is("Notes")'], text: "Notes" },
      ];
      let parent = "farCard";
      for (let i = 0; i < 10; i += 1) {
        const id = `wrap${i}`;
        nodes.push({ id, parent, matches: [] });
        parent = id;
      }
      nodes.push({ id: "anchorBtn", parent, matches: ['button:has(svg[data-qa="ci-Plus"])'] });

      const result = await resolveNotesSectionByAnchor(makePage({ nodes, actions: [], fills: [], keys: [] }));
      expect(result).toBeNull();
    });

    it("returns null when no anchor button exists at all", async () => {
      const result = await resolveNotesSectionByAnchor(makePage(notesFixture({ withoutSection: true })));
      expect(result).toBeNull();
    });
  });

  describe("resolveEditorScopes", () => {
    const sectionOf = (dom: FakeDom) => makePage(dom).locator("div.aid-notes").first();

    it("uses the section alone when no dialog is open", async () => {
      const dom = notesFixture();
      const scopes = await resolveEditorScopes(makePage(dom), sectionOf(dom));
      expect(scopes.map((s: any) => s.label)).toEqual(["section"]);
    });

    it("prefers a clean dialog but KEEPS the section as a fallback scope", async () => {
      const dom = notesFixture();
      dom.nodes.push({ id: "dialog", parent: "page", matches: ['[role="dialog"]'], text: "Add note" });
      const scopes = await resolveEditorScopes(makePage(dom), sectionOf(dom));
      expect(scopes.map((s: any) => s.label)).toEqual(["dialog", "section"]);
    });

    it("REJECTS a contaminated dialog and falls back to the section", async () => {
      // Production applies isPlausibleNotesSection to the dialog too; the prober used to scope purely
      // on "the dialog is visible", so it could validate selectors production would never use.
      const dom = notesFixture();
      dom.nodes.push({ id: "dialog", parent: "page", matches: ['[role="dialog"]'], text: "Some other modal" });
      dom.nodes.push({
        id: "dialogDescription",
        parent: "dialog",
        matches: ['textarea[name="description"]', '[name*="description" i]'],
        attrs: { name: "description" },
      });
      const scopes = await resolveEditorScopes(makePage(dom), sectionOf(dom));
      expect(scopes.map((s: any) => s.label)).toEqual(["section"]);
    });
  });

  describe("findVisibleRoleMatch", () => {
    it("walks past a hidden role match to the visible one", async () => {
      const dom = notesFixture();
      dom.nodes.push({ id: "hiddenCreate", parent: "notesSection", matches: [], role: "button", name: "Create", hidden: true });
      dom.nodes.push({ id: "realCreate", parent: "notesSection", matches: [], role: "button", name: "Create" });
      const match = await findVisibleRoleMatch(makePage(dom), CREATE_BUTTON_ROLE);
      expect(match.hit?.index).toBe(1);
      expect(match.count).toBe(2);
      expect(match.probeFailed).toBe(false);
    });

    it("returns null when the scope cannot do role queries", async () => {
      const match = await findVisibleRoleMatch({ locator: () => ({}) } as any, CREATE_BUTTON_ROLE);
      // Not a determination that there is no Create button — we could not ask.
      expect(match.hit).toBeNull();
      expect(match.probeFailed).toBe(true);
    });
  });

  describe("actableCandidates", () => {
    it("includes precise and scopedOnly, never loose", () => {
      const tiers = { precise: ["a"], scopedOnly: ["b"], loose: ["c"] };
      expect(actableCandidates(tiers)).toEqual(["a", "b"]);
    });
  });
});

// The prober's WIRING, driven by the same fake DOM as production. Its output is what an operator reads
// to choose real Procore hooks, and every safety property downstream rests on those hooks being right —
// so "it calls the shared resolvers correctly" is asserted here rather than left to review. These
// assertions are deliberately about the wiring (does the report reflect the shared verdict?), not about
// the resolvers themselves, which are tested directly above.
describe("probeBidBoardNotesUi (the prober's wiring)", () => {
  const PROBE = { sectionTimeoutMs: 20, projectLabel: "9001" };

  it("happy path: reports the rows an operator would act on, with actable set per row", async () => {
    const dom = notesFixture();
    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.sectionVerdict).toMatchObject({ ok: true, selector: "div.aid-notes" });
    expect(result.matchedSection).toBe("div.aid-notes");
    expect(result.looseSectionOnly).toBe(false);
    expect(result.sectionContaminated).toBe(false);
    expect(result.editorProbeSkippedReason).toBeNull();

    // The add control it would click is the one INSIDE the section, and it is marked actable.
    expect(result.matchedAddButton).toBe("button.aid-add-note");
    const addRow = result.candidates.addButtonInSection.find((row: any) => row.selector === "button.aid-add-note");
    expect(addRow).toMatchObject({ visible: true, actable: true, tier: "precise" });

    // The loose tier is reported but explicitly NOT actable — that distinction is the whole safety model.
    const looseSectionRow = result.candidates.section.find((row: any) => row.tier === "loose");
    expect(looseSectionRow?.actable).toBe(false);

    // The editor opened, and both the CSS rows and the role fallback are reported per scope.
    expect(result.editorOpened).toBe(true);
    expect(result.editorScopeLabels).toEqual(["section"]);
    expect(result.candidates.inputAfterAdd.some((row: any) => row.selector === 'textarea[name="note"]' && row.visible)).toBe(true);
    expect(result.candidates.createButtonAfterAdd.some((row: any) => row.tier === "roleFallback")).toBe(true);
    // …and the "+" click is reverted, so the shared session is left clean.
    expect(dom.keys).toContain("Escape");
  });

  it("loose-only section: reports it and clicks NOTHING", async () => {
    const dom = notesFixture({ withoutSection: true });
    dom.nodes.push({ id: "looseSection", parent: "page", matches: ['section:has-text("Notes")'], text: "Notes" });
    dom.nodes.push({ id: "strayAdd", parent: "page", matches: ['button.aid-add-note'] });

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.looseSectionOnly).toBe(true);
    expect(result.matchedSection).toBeNull();
    expect(result.sectionVerdict).toMatchObject({ ok: false, reason: "loose-only" });
    expect(result.editorProbeSkippedReason).toMatch(/the automation would refuse here too/);
    // The stray page-level add control must NOT be clicked just because it exists.
    expect(result.matchedAddButton).toBeNull();
    expect(dom.actions).toEqual([]);
    expect(result.editorOpened).toBe(false);
  });

  it("contaminated section: reports the rejection and clicks nothing", async () => {
    const result = await probeBidBoardNotesUi(makePage(notesFixture({ contaminatedSection: true })), PROBE);

    expect(result.sectionContaminated).toBe(true);
    expect(result.sectionVerdict).toMatchObject({ ok: false, reason: "contaminated" });
    expect(result.matchedAddButton).toBeNull();
    expect(result.editorProbeSkippedReason).toMatch(/page-level wrapper/i);
  });

  it("contaminated dialog: falls back to the section, matching production's dialog-then-section order", async () => {
    const dom = notesFixture();
    // The add click opens an UNRELATED modal that carries a description field.
    node(dom, "addBtn")!.onClick = (d) => {
      d.nodes.push({ id: "dialog", parent: "page", matches: ['[role="dialog"]'], text: "Unrelated modal" });
      d.nodes.push({
        id: "dialogDescription",
        parent: "dialog",
        matches: ['textarea[name="description"]', '[name*="description" i]'],
        attrs: { name: "description" },
      });
      d.nodes.push({ id: "editor", parent: "notesSection", matches: ['textarea[name="note"]'], attrs: { name: "note" }, text: "" });
    };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    // Production would reject that dialog; the prober must not validate selectors inside it.
    expect(result.editorScopeLabels).toEqual(["section"]);
    expect(result.candidates.inputAfterAdd.every((row: any) => row.scope === "section")).toBe(true);
  });

  it("clean dialog: probes dialog THEN section, in production's order", async () => {
    const dom = notesFixture();
    node(dom, "addBtn")!.onClick = (d) => {
      d.nodes.push({ id: "dialog", parent: "page", matches: ['[role="dialog"]'], text: "Add note" });
      d.nodes.push({ id: "editor", parent: "dialog", matches: ['textarea[name="note"]'], attrs: { name: "note" }, text: "" });
    };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.editorScopeLabels).toEqual(["dialog", "section"]);
  });

  it("marker already present: reports markerAlreadyPresent so 'would skip' is distinguishable from 'broken'", async () => {
    const dom = notesFixture({
      existingNotes: ["Colby Burling · Aug 16, 2026\nCRM Activity Log — DFW-2-12345-ab (as of Aug 16, 2026)"],
    });

    dom.nodes.push({ id: "otherNote", parent: "notesSection", matches: ['div.aid-note'], text: "Walked the roof" });

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.markerAlreadyPresent).toBe(true);
    expect(result.noteTexts.join("\n")).toMatch(/CRM Activity Log/);
    // readNoteTexts returns EACH note plus the container's text, not one blob — reporting the blob
    // would hide which note carries the marker, and would not be what the guard actually reads.
    expect(result.noteTexts.length).toBeGreaterThanOrEqual(3);
  });

  it("no marker present: reports markerAlreadyPresent false", async () => {
    const result = await probeBidBoardNotesUi(makePage(notesFixture()), PROBE);
    expect(result.markerAlreadyPresent).toBe(false);
  });

  it("description-shaped input: reports inputWouldBeRefused", async () => {
    const result = await probeBidBoardNotesUi(makePage(notesFixture({ editorLooksLikeDescription: true })), PROBE);

    expect(result.editorOpened).toBe(true);
    expect(result.inputWouldBeRefused).toBe(true);
  });

  it("normal input: reports inputWouldBeRefused false", async () => {
    const result = await probeBidBoardNotesUi(makePage(notesFixture()), PROBE);
    expect(result.inputWouldBeRefused).toBe(false);
  });

  it("openEditor:false leaves the page untouched", async () => {
    const dom = notesFixture();
    const result = await probeBidBoardNotesUi(makePage(dom), { ...PROBE, openEditor: false });

    expect(dom.actions).toEqual([]);
    expect(result.editorOpened).toBe(false);
    expect(result.editorProbeSkippedReason).toBeNull();
  });

  // Parity check for the anchor fallback: the prober calls resolveNotesSection DIRECTLY (see the
  // "shared resolvers" describe above), so this is really proving the WIRING reports it, not the
  // resolver logic again. What matters operationally: an operator reading this output must see the
  // fix reflected, or they would conclude the automation is still broken when it is not.
  it("reports the anchor fallback the same way it reports a precise match", async () => {
    const dom = notesFixture({ anchorOnly: true });
    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.sectionVerdict.ok).toBe(true);
    expect(result.looseSectionOnly).toBe(false);
    expect(result.sectionContaminated).toBe(false);
    expect(result.matchedSection).toContain('svg[data-qa="ci-Plus"]');
    // The add button is the SAME confirmed hook, now also registered in addButton.precise — the
    // prober's addButtonInSection probe (scoped to the resolved section) must find it too.
    expect(result.matchedAddButton).toBe('button:has(svg[data-qa="ci-Plus"])');
    expect(result.editorOpened).toBe(true);
  });
});

// The prober must never shade toward optimism: a failure, a timeout, an absence or an unknown must
// never be reported as a value an operator would act on. Everything here asserts the pessimistic or
// explicitly-unknown answer, because the whole chain of safety in this feature depends on someone
// reading this output and substituting real Procore hooks from it.
describe("probeBidBoardNotesUi — failures never read as success", () => {
  const PROBE = { sectionTimeoutMs: 20, projectLabel: "9001" };

  it("STOPS probing when the add click fails — no editor rows are reported", async () => {
    const dom = notesFixture();
    // A detached/disabled/covered control: present and visible, but the click throws.
    node(dom, "addBtn")!.onClick = () => {
      throw new Error("element is not enabled");
    };
    // Editor-shaped controls that already exist in the section would otherwise be reported as though
    // the notes editor had opened.
    dom.nodes.push({ id: "preExistingBox", parent: "notesSection", matches: ['textarea[name="note"]'], attrs: { name: "note" } });

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.addClickFailed).toBe(true);
    expect(result.editorOpened).toBe(false);
    expect(result.candidates.inputAfterAdd).toBeUndefined();
    expect(result.candidates.createButtonAfterAdd).toBeUndefined();
    expect(result.editorProbeSkippedReason).toMatch(/could not be clicked/i);
    expect(result.problems.join(" ")).toMatch(/Add-control click failed/);
  });

  it("reports the real role-fallback match count when every match is HIDDEN", async () => {
    // "Zero matches" and "three matches, all hidden" are opposite diagnoses.
    const dom = notesFixture({ createButtonRoleOnly: true });
    node(dom, "addBtn")!.onClick = (d) => {
      d.nodes.push({ id: "editor", parent: "notesSection", matches: ['textarea[name="note"]'], attrs: { name: "note" }, text: "" });
      d.nodes.push({ id: "c1", parent: "notesSection", matches: [], role: "button", name: "Create", hidden: true });
      d.nodes.push({ id: "c2", parent: "notesSection", matches: [], role: "button", name: "Create", hidden: true });
    };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    const roleRow = result.candidates.createButtonAfterAdd.find((row: any) => row.tier === "roleFallback");
    expect(roleRow?.count).toBe(2); // matches exist…
    expect(roleRow?.visible).toBe(false); // …but none is usable
    expect(roleRow?.visibleIndex).toBeNull();
  });

  it("reports UNKNOWN, not zero/false, when a selector query fails", async () => {
    const dom = notesFixture();
    dom.fail = { count: (selector) => selector === "div.aid-note" };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    const row = result.candidates.item.find((r: any) => r.selector === "div.aid-note");
    expect(row?.count).toBeNull();
    expect(row?.visible).toBeNull(); // NOT false — we could not tell
  });

  it("reports markerAlreadyPresent as UNKNOWN when the notes cannot be read", async () => {
    // false would mean "no CRM note here, safe to post" — the favourable answer, from a failed read.
    const dom = notesFixture();
    dom.fail = { innerText: (id) => id === "notesSection" };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.markerAlreadyPresent).toBeNull();
    expect(result.problems.join(" ")).toMatch(/markerAlreadyPresent is unknown/);
  });
});

describe("fail-closed safety checks", () => {
  it("treats an unreadable container as CONTAMINATED, not clean", async () => {
    // The contamination query decides whether it is safe to act inside an element at all; a query
    // failure used to mean "clean".
    const dom = notesFixture();
    dom.fail = { count: (selector) => selector.includes("sectionContamination") || selector.includes('[name*="description" i]') };

    const result = await resolveNotesSection(makePage(dom), { timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
  });

  it("refuses to fill an element whose attributes cannot be read", async () => {
    const unreadable: any = { getAttribute: async () => { throw new Error("detached"); } };
    expect(await isForbiddenFillTarget(unreadable)).toBe(true);
  });

  it("still allows a normal element whose attributes are simply absent", async () => {
    const plain: any = { getAttribute: async () => null };
    expect(await isForbiddenFillTarget(plain)).toBe(false);
  });
});

// The production path's own fail-open sweep. Every case here injects a QUERY FAILURE and asserts the
// pessimistic outcome — these bugs are invisible when everything succeeds, which is exactly why
// inspection kept missing them.
describe("postBidBoardProjectNote — failures never resolve to the favourable branch", () => {
  beforeEach(() => {
    navigateToProjectMock.mockReset();
    navigateToProjectMock.mockResolvedValue(true);
  });

  it("REFUSES to post when the existing notes cannot be read", async () => {
    // An unreadable notes list is not an empty one. Reading [] as "no marker present" means "safe to
    // post", and being wrong costs another 8 KB duplicate — on every retry and every adopt.
    const dom = notesFixture();
    dom.fail = { innerText: (id) => id === "notesSection" };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/could not read the existing notes/i);
    expect(dom.fills).toEqual([]);
    expect(dom.actions).toEqual([]);
  });

  it("does NOT self-verify off an unsaved draft when editor visibility is unknown", async () => {
    // The marker check reads the container's text, which includes an OPEN editor's content. If a
    // visibility error counted as "editor closed", the note would verify itself as saved when it was
    // not. Unknown must count as still open.
    const dom = notesFixture({ createRenders: false, createClosesEditor: false });
    // Fails only AFTER the note is typed, so the editor lookup itself still succeeds — the unknown has
    // to land on the post-Create visibility probe, which is where the self-verification hole was.
    dom.fail = { isVisible: (id) => id === "editor" && dom.fills.length > 0 };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/editor is still open/i);
  });

  it("warns when a composed note could not be cancelled off the shared page", async () => {
    // Escape failing means an ~8 KB draft may still be sitting in the editor that document sync uses
    // next, under the same browser lock. A clean-looking failure would hide that.
    const dom = notesFixture({ createRenders: false });
    dom.fail = { keyboard: true };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/note editor (is still open|could not be confirmed closed)/i);
  });

  it("still posts normally when nothing fails (the guards do not fire spuriously)", async () => {
    const dom = notesFixture();
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);
    expect(result).toMatchObject({ posted: true, skipped: false });
  });
});

// "The action was attempted" is not "the state changed". Both cases here deliver a keypress or a query
// successfully and still must not report the favourable outcome.
describe("attempted vs accomplished", () => {
  beforeEach(() => {
    navigateToProjectMock.mockReset();
    navigateToProjectMock.mockResolvedValue(true);
  });

  it("does not report a cancel as successful when the editor is still open (the @-mention case)", async () => {
    // This module documents that "@" opens Procore's mention picker, and activity bodies are
    // rep-authored free text. Escape then closes the PICKER, not the editor — the keypress lands, the
    // editor stays, and an ~8 KB draft would be left on the page document sync runs on next.
    const dom = notesFixture({ createRenders: false, createClosesEditor: false });
    dom.escapesToClose = 99; // the picker keeps swallowing them

    const result = await postBidBoardProjectNote(makePage(dom), "9001", `${NOTE}\n@colby can you confirm?`, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/WARNING: the note editor is still open after \d+ cancel attempt/i);
    // It retried rather than giving up on the first Escape…
    expect(dom.keys.filter((key) => key === "Escape").length).toBeGreaterThan(1);
    // …and, unable to close it, emptied the draft so a blur-save cannot commit 8 KB.
    expect(result.error).toMatch(/text was cleared as a fallback/i);
    expect(node(dom, "editor")!.text).toBe("");
  });

  it("retries past a picker that swallows the FIRST Escape and then verifies the close", async () => {
    const dom = notesFixture({ createRenders: false, createClosesEditor: false });
    dom.escapesToClose = 2; // the mention picker eats one, the editor takes the next

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).not.toMatch(/WARNING:/);
    expect(dom.keys.filter((key) => key === "Escape").length).toBe(2);
    expect(node(dom, "editor")).toBeUndefined();
  });

  it("reports a VERIFIED cancel without a warning when the editor really closes", async () => {
    const dom = notesFixture({ createRenders: false, createClosesEditor: true });
    // The editor closes on Escape, as it would without a mention picker in the way.
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).not.toMatch(/WARNING:/);
  });

  it("cancelEditor reports UNKNOWN rather than success when it has nothing to verify against", async () => {
    const dom = notesFixture();
    const result = await cancelEditor(makePage(dom));
    expect(result.closed).toBeNull(); // never an optimistic true
  });
});

describe("probeBidBoardNotesUi — unknown visibility is surfaced, not reported as absent", () => {
  const PROBE = { sectionTimeoutMs: 20, projectLabel: "9001" };

  it("reports visible:null AND a problems entry when a visibility probe rejects", async () => {
    // count() succeeds, isVisible() rejects mid-rerender. findVisibleMatch turns that into no-match,
    // which is right for production (decline) but must NOT read as "this selector doesn't match" here:
    // that says "discard the selector", when the truth says "re-run".
    const dom = notesFixture();
    dom.fail = { isVisible: (id) => id === "addBtn" };

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    const row = result.candidates.addButton.find((r: any) => r.selector === "button.aid-add-note");
    expect(row?.count).toBe(1); // the element IS there…
    expect(row?.visible).toBeNull(); // …we just could not tell if it is usable
    expect(result.problems.join(" ")).toMatch(/Could not determine visibility for button\.aid-add-note/);
  });

  it("still reports visible:false when the element is genuinely hidden", async () => {
    // The other side of the same coin: a real determination must not be blurred into "unknown".
    const dom = notesFixture();
    node(dom, "addBtn")!.hidden = true;

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    const row = result.candidates.addButton.find((r: any) => r.selector === "button.aid-add-note");
    expect(row?.visible).toBe(false);
    expect(result.problems.join(" ")).not.toMatch(/Could not determine visibility for button\.aid-add-note/);
  });
});

describe("round-10: retry survives unknowns, and truncation is not success", () => {
  beforeEach(() => {
    navigateToProjectMock.mockReset();
    navigateToProjectMock.mockResolvedValue(true);
  });

  it("keeps retrying Escape when the visibility check is INDETERMINATE, then warns and clears", async () => {
    // An unknown reading must not end the retry loop: doing so consumes the remaining attempts and
    // skips the clear fallback — the unknown-handling would cancel out the retry it sits inside.
    const dom = notesFixture({ createRenders: false, createClosesEditor: false });
    dom.escapesToClose = 99;
    dom.fail = { isVisible: (id) => id === "editor" && dom.fills.length > 0 };

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    // All three attempts ran…
    expect(dom.keys.filter((key) => key === "Escape").length).toBe(3);
    // …the operator is warned it could not be confirmed closed…
    expect(result.error).toMatch(/WARNING: the note editor could not be confirmed closed after 3 cancel attempt/i);
    // …and the draft was emptied rather than left as 8 KB on a shared page.
    expect(result.error).toMatch(/text was cleared as a fallback/i);
    expect(node(dom, "editor")!.text).toBe("");
  });

  it("does NOT report a TRUNCATED note as posted", async () => {
    // ensureNoteMarker puts the marker first, so a marker-only check passes for a note Procore
    // accepted and then cut short. The 8 KB cap exists because Procore's real limit is undocumented,
    // which makes this a live possibility.
    const dom = notesFixture({ renderTransform: (typed) => typed.split("\n")[0] });

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/TRUNCATED/);
    expect(result.error).toMatch(/lowering the CRM's MAX_NOTE_CHARS/);
  });

  it("reports posted when the whole body survives, whitespace re-rendering included", async () => {
    // The tail check must be robust to Procore reflowing the text, not require byte equality.
    const dom = notesFixture({ renderTransform: (typed) => typed.replace(/\s+/g, "  ").toUpperCase() });

    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result).toMatchObject({ posted: true, skipped: false });
  });
});

describe("round-10: the prober runs production's post-Add path", () => {
  const PROBE = { sectionTimeoutMs: 20, projectLabel: "9001", editorTimeoutMs: 1000 };

  it("POLLS for a slow-rendering editor instead of reporting the selectors absent", async () => {
    // A single immediate probe after a fixed delay would call these selectors missing, and an operator
    // would then replace working ones.
    const dom = notesFixture({ editorAppearsAfterMs: 120 });

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.editorOpened).toBe(true);
    expect(result.resolvedInputSelector).toBe('textarea[name="note"]');
    expect(result.resolvedCreateSelector).toBe("button.aid-confirmButton");
  });

  it("probes Create ONLY in the scope the input resolved to", async () => {
    // Input in the dialog, the only Create in the section. Production fixes editorScope to the dialog
    // and would fail; reporting the section's Create as visible+actable would claim a combination
    // production cannot use.
    const dom = notesFixture({ editorInDialogCreateInSection: true });

    const result = await probeBidBoardNotesUi(makePage(dom), PROBE);

    expect(result.resolvedInputScope).toBe("dialog");
    expect(result.candidates.createButtonAfterAdd.every((row: any) => row.scope === "dialog")).toBe(true);
    expect(result.candidates.createButtonAfterAdd.some((row: any) => row.visible === true)).toBe(false);
    // …and the verdict says production would NOT find a usable Create.
    expect(result.resolvedCreateSelector).toBeNull();
  });
});
