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

const { postBidBoardProjectNote, noteMarkerFor, hasMarkerNote } = await import("../server/playwright/bidboard-notes.ts");
const { PROCORE_SELECTORS } = await import("../server/playwright/selectors.ts");

const NOTES = PROCORE_SELECTORS.bidboard.newUi.notes;
const SECTION_SEL = "div.aid-notes";
const ITEM_SEL = "div.aid-note";
const ADD_SEL = "button.aid-add-note";
const INPUT_SEL = 'textarea[name="note"]';
const CREATE_SEL = "button.aid-confirmButton";

const NOTE = [
  "CRM Activity Log — DFW-2-12345-ab (as of Aug 17, 2026)",
  "",
  "Aug 14, 2026 · Call (connected, 15 min) · Jane Rep",
  "  Owner confirmed scope; wants alternates priced.",
].join("\n");

type FakeState = {
  present: Set<string>;
  notes: string[];
  actions: string[];
  filled: string[];
  /** When true, clicking Create renders the typed note (the happy path). */
  createRenders: boolean;
  /** When true, clicking Create closes the editor (Procore's real behaviour on a committed save). */
  createClosesEditor: boolean;
  pending: string | null;
};

function classify(parts: string[]): "item" | "add" | "input" | "create" | "section" | "other" {
  if (parts.some((p) => NOTES.item.includes(p))) return "item";
  if (parts.some((p) => NOTES.addButton.includes(p))) return "add";
  if (parts.some((p) => NOTES.input.includes(p))) return "input";
  if (parts.some((p) => NOTES.createButton.includes(p))) return "create";
  if (parts.some((p) => NOTES.section.includes(p))) return "section";
  return "other";
}

/**
 * A hand-rolled stand-in for Playwright's Page/Locator — the same "stub the page object" style the other
 * bidboard-*.test.ts files use. `present` is the set of selectors that exist on the fake page, so a test
 * chooses exactly WHICH layer of the selector cascade matches.
 */
function makePage(state: FakeState) {
  const makeLocator = (selector: string): any => {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    const kind = classify(parts);
    // Resolved lazily on every call, like a real Playwright locator, so the fake reflects a page that
    // changed after a click (the editor closing, a note appearing).
    const present = () => parts.some((p) => state.present.has(p));
    const count = () => (kind === "item" ? (present() ? state.notes.length : 0) : present() ? 1 : 0);

    const locator: any = {
      first: () => locator,
      last: () => locator,
      count: async () => count(),
      isVisible: async () => count() > 0,
      waitFor: async () => {
        if (count() === 0) throw new Error("Timeout waiting for selector");
      },
      allTextContents: async () => (kind === "item" ? [...state.notes] : []),
      innerText: async () => {
        if (kind !== "section") return "";
        // The section's text includes whatever is currently typed into an open editor — which is
        // exactly the false-positive the editor-still-open check has to defend against.
        const open = state.pending && state.present.has(INPUT_SEL) ? [state.pending] : [];
        return [...state.notes, ...open].join("\n");
      },
      click: async () => {
        state.actions.push(`click:${kind}`);
        if (kind === "create") {
          if (state.createRenders && state.pending) {
            // Procore renders the saved note in the list.
            state.notes.push(`Someone · Aug 17, 2026\n${state.pending}`);
          }
          if (state.createClosesEditor) state.present.delete(INPUT_SEL);
        }
      },
      fill: async (value: string) => {
        state.actions.push(`fill:${kind}`);
        state.filled.push(value);
        state.pending = value;
      },
      locator: (nested: string) => makeLocator(nested),
    };
    return locator;
  };

  return {
    url: () => "https://us02.procore.com/webclients/host/companies/1/tools/bid-board/project/9/details",
    locator: (selector: string) => makeLocator(selector),
  } as any;
}

function stateWith(
  present: string[],
  notes: string[] = [],
  overrides: Partial<Pick<FakeState, "createRenders" | "createClosesEditor">> = {},
): FakeState {
  return {
    present: new Set(present),
    notes,
    actions: [],
    filled: [],
    createRenders: overrides.createRenders ?? true,
    createClosesEditor: overrides.createClosesEditor ?? true,
    pending: null,
  };
}

/** Short verify window so the "not verified" paths don't spend the real 10s polling budget. */
const FAST_VERIFY = { verifyTimeoutMs: 50 };

describe("noteMarkerFor", () => {
  it("derives the marker from the note's own first line, without the volatile as-of date", () => {
    expect(noteMarkerFor(NOTE, "DFW-2-12345-ab")).toBe("CRM Activity Log — DFW-2-12345-ab");
  });

  it("prefers the note's own label over the Procore project number when they differ", () => {
    // The CRM labels the note with its DISPLAY number, which an approver's project_number edit can make
    // differ from the number SyncHub created the project under. Keying on the note text means we search
    // for exactly what a previous run would have written.
    expect(noteMarkerFor(NOTE, "SOME-OTHER-NUMBER")).toBe("CRM Activity Log — DFW-2-12345-ab");
  });

  it("falls back to the project number when the note carries no marker line", () => {
    expect(noteMarkerFor("just some text", "DFW-2-12345-ab")).toBe("CRM Activity Log — DFW-2-12345-ab");
  });

  it("falls back to the bare prefix when there is no marker and no project number", () => {
    expect(noteMarkerFor("just some text")).toBe("CRM Activity Log");
  });
});

describe("hasMarkerNote", () => {
  it("matches a marker embedded in a rendered note's author/date chrome", () => {
    const rendered = "Colby Burling  Aug 17, 2026\nCRM Activity Log — DFW-2-12345-ab (as of Aug 17, 2026)\nAug 14 · Call";
    expect(hasMarkerNote([rendered], "CRM Activity Log — DFW-2-12345-ab")).toBe(true);
  });

  it("tolerates dash and whitespace re-rendering", () => {
    expect(hasMarkerNote(["CRM Activity Log -  DFW-2-12345-ab (as of ...)"], "CRM Activity Log — DFW-2-12345-ab")).toBe(true);
  });

  it("does not match a different project's activity note", () => {
    expect(hasMarkerNote(["CRM Activity Log — ATL-5-99999-zz"], "CRM Activity Log — DFW-2-12345-ab")).toBe(false);
  });

  it("is false for an empty notes list", () => {
    expect(hasMarkerNote([], "CRM Activity Log — DFW-2-12345-ab")).toBe(false);
  });
});

describe("postBidBoardProjectNote", () => {
  beforeEach(() => {
    navigateToProjectMock.mockReset();
    navigateToProjectMock.mockResolvedValue(true);
  });

  it("posts the note when no marker note exists yet", async () => {
    const state = stateWith([SECTION_SEL, ITEM_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL]);
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab");

    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(result.error).toBeUndefined();
    expect(state.actions).toEqual(["click:add", "fill:input", "click:create"]);
    expect(state.filled).toEqual([NOTE]);
    // The matched selector is reported so selector rot shows up as "we fell through a layer".
    expect(result.matched).toMatchObject({ section: SECTION_SEL, addButton: ADD_SEL, input: INPUT_SEL, createButton: CREATE_SEL });
  });

  it("SKIPS when a note with the marker already exists — no add, no fill, no Create", async () => {
    // The retry / adopted-project / duplicate-command case: without this guard each run stacks another
    // ~8 KB copy of the same activity log on the project.
    const existing = "Colby Burling · Aug 16, 2026\nCRM Activity Log — DFW-2-12345-ab (as of Aug 16, 2026)\nAug 12 · Site Visit";
    const state = stateWith([SECTION_SEL, ITEM_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL], [existing]);

    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab");

    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(state.actions).toEqual([]);
    expect(state.filled).toEqual([]);
  });

  it("still posts when the existing notes belong to a different project number", async () => {
    const state = stateWith([SECTION_SEL, ITEM_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL], ["CRM Activity Log — ATL-5-99999-zz (as of Aug 1, 2026)"]);
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab");
    expect(result.posted).toBe(true);
  });

  it("returns an error result (does NOT throw) when the add control is missing", async () => {
    const state = stateWith([SECTION_SEL, ITEM_SEL]);
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab");

    expect(result.posted).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.error).toMatch(/add-note control not found/i);
    expect(state.actions).toEqual([]);
  });

  it("returns an error result when the Notes section itself is not found", async () => {
    const result = await postBidBoardProjectNote(makePage(stateWith([])), "9001", NOTE, "DFW-2-12345-ab");
    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/notes section not found/i);
  });

  it("returns an error result when the saved note never renders", async () => {
    // Procore's Notes length limit is undocumented; a silently-rejected note must not report success,
    // or we would log a success for a note that never landed.
    const state = stateWith([SECTION_SEL, ITEM_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL], [], { createRenders: false });
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab", FAST_VERIFY);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/could not be verified/i);
  });

  it("does not report success off the text still sitting in an open editor", async () => {
    // When no note-row selector matches, the marker check falls back to the whole section's text —
    // which includes the open editor's content. An uncommitted note must not verify itself.
    const state = stateWith([SECTION_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL], [], { createClosesEditor: false });
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab", FAST_VERIFY);

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/editor is still open/i);
  });

  it("verifies through the section-text fallback when no note-row selector matches", async () => {
    // The item selectors are the most speculative of the lot; the step must still work when none of
    // them match, as long as the saved text is visible in the section.
    const state = stateWith([SECTION_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL]);
    const result = await postBidBoardProjectNote(makePage(state), "9001", NOTE, "DFW-2-12345-ab", FAST_VERIFY);

    expect(result).toMatchObject({ posted: true, skipped: false });
  });

  it("returns an error result (does NOT throw) when navigation fails", async () => {
    navigateToProjectMock.mockResolvedValueOnce(false);
    const result = await postBidBoardProjectNote(makePage(stateWith([SECTION_SEL])), "9001", NOTE, "DFW-2-12345-ab");
    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/could not navigate/i);
  });

  it("returns an error result (does NOT throw) when the page blows up mid-step", async () => {
    const page: any = { locator: () => { throw new Error("Target page, context or browser has been closed"); } };
    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab");
    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/has been closed/i);
  });

  it("skips an empty note without touching the page", async () => {
    const state = stateWith([SECTION_SEL, ITEM_SEL, ADD_SEL, INPUT_SEL, CREATE_SEL]);
    const result = await postBidBoardProjectNote(makePage(state), "9001", "   ", "DFW-2-12345-ab");
    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(navigateToProjectMock).not.toHaveBeenCalled();
  });
});
