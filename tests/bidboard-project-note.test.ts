import { beforeEach, describe, expect, it, vi } from "vitest";

// bidboard-notes imports navigateToProject from bidboard.ts (which pulls db/storage at import time) and
// the browser helpers — stub them so the module loads and the delays don't slow the suite. The REAL
// createBidBoardProjectFromDeal fail-open wiring is covered separately in bidboard-note-fail-open.test.ts,
// which mocks the other direction.
const navigateToProjectMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../server/playwright/bidboard.ts", () => ({ navigateToProject: navigateToProjectMock }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({
  randomDelay: vi.fn(async () => {}),
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
  resolveEditorScopes,
  findVisibleRoleMatch,
  actableCandidates,
  isForbiddenFillTarget,
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
  };
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
    isVisible: async () => resolve().some((n) => !n.hidden),
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
    locator: (nested: string) => makeLocator(dom, () => matchNodes(dom, nested, resolve().map((n) => n.id)), nested),
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
        dom.keys.push(key);
        // Escape closes Procore's editor; model it so "leave the page clean" is observable.
        if (key === "Escape") removeNode(dom, "editor");
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
} = {}): FakeDom {
  const createRenders = opts.createRenders ?? true;
  const createClosesEditor = opts.createClosesEditor ?? true;

  const saveNote = (dom: FakeDom) => {
    const editor = node(dom, "editor");
    if (createRenders && editor) {
      dom.nodes.push({
        id: `note-${dom.nodes.length}`,
        parent: "notesSection",
        matches: ['div.aid-note'],
        text: `Colby Burling · Aug 17, 2026\n${editor.text ?? ""}`,
      });
    }
    if (createClosesEditor) removeNode(dom, "editor");
  };

  const openEditor = (dom: FakeDom) => {
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
      const hit = await findVisibleRoleMatch(makePage(dom), CREATE_BUTTON_ROLE);
      expect(hit?.index).toBe(1);
    });

    it("returns null when the scope cannot do role queries", async () => {
      const hit = await findVisibleRoleMatch({ locator: () => ({}) } as any, CREATE_BUTTON_ROLE);
      expect(hit).toBeNull();
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
