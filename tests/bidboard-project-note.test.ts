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
} = await import("../server/playwright/bidboard-notes.ts");

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

function makeLocator(dom: FakeDom, resolve: () => FakeNode[]): any {
  const locator: any = {
    first: () => makeLocator(dom, () => resolve().slice(0, 1)),
    last: () => makeLocator(dom, () => resolve().slice(-1)),
    nth: (index: number) => makeLocator(dom, () => resolve().slice(index, index + 1)),
    // count() includes hidden nodes, as the real DOM does — that is what makes probing only .first()
    // able to miss a usable control.
    count: async () => resolve().length,
    isVisible: async () => resolve().some((n) => !n.hidden),
    waitFor: async () => {
      if (!resolve().some((n) => !n.hidden)) throw new Error("Timeout waiting for selector");
    },
    allTextContents: async () => resolve().map((n) => textOf(dom, n)),
    innerText: async () => resolve().map((n) => textOf(dom, n)).join("\n"),
    getAttribute: async (attr: string) => resolve()[0]?.attrs?.[attr] ?? null,
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
    locator: (nested: string) => makeLocator(dom, () => matchNodes(dom, nested, resolve().map((n) => n.id))),
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
    locator: (selector: string) => makeLocator(dom, () => matchNodes(dom, selector, null)),
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

  it("does not fall back to a loose page-level Create button when the editor is found page-wide", async () => {
    // The widening branch: the editor renders outside the section, so the scope becomes the PAGE and
    // the generic `button:has-text("Create")` tier is dropped — it would match "Create New Project".
    const dom = notesFixture({ editorOutsideSection: true, createButtonPageLevelLooseOnly: true });
    const result = await postBidBoardProjectNote(makePage(dom), "9001", NOTE, "DFW-2-12345-ab", FAST);

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/create button not found/i);
    expect(dom.actions).not.toContain("click:createBtn");
    // …and the half-typed note is cleaned up rather than left on the shared page.
    expect(dom.keys).toContain("Escape");
    expect(node(dom, "editor")).toBeUndefined();
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
