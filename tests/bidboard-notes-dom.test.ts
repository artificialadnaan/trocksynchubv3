/**
 * The Notes-section resolver against REAL Chromium and REAL Playwright locators.
 * ==============================================================================
 *
 * Why this file exists, separately from tests/bidboard-project-note.test.ts:
 *
 * That suite drives a hand-written fake DOM which resolves selectors by LITERAL STRING. It cannot
 * express `:has()`, `:text-is()`, `:text-matches()` or `xpath=..` — i.e. it cannot express a single one
 * of the selector semantics this resolver's safety rests on. The consequence was not theoretical: two
 * of its tests for the climb stayed green with the climb's core rule deleted, because the only thing
 * they asserted ("the resolved container holds one add button") is true of EVERY wrapper between the
 * button and `<body>`. A wrong-card write and a page-wide `<body>` scope both passed that bar.
 *
 * So every test here does two things the fake DOM cannot:
 *   1. runs the production function against a real browser via `page.setContent`, so `:has()`,
 *      `:text-matches()` and the ancestor climb behave exactly as they do on a live Procore page;
 *   2. asserts WHICH ELEMENT resolved, by id or tagName. Never "something resolved", never a property
 *      that every candidate on the climb path satisfies.
 *
 * The layouts are the ones an adversarial review OBSERVED failing in real Chromium against the previous
 * climb-from-the-"+" rule: a decoy "Internal Notes" card owning an earlier "+", a "+" in the card
 * header, a page with no `textarea[name="description"]` rendered, and a `Notes (3)` count suffix.
 *
 * No Procore credentials, no network, no live project — `setContent` only.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type Browser, type Page } from "playwright";

// Same import-time stubs as the fake-DOM suite: bidboard-notes pulls navigateToProject (which loads
// db/storage at import time) and the browser helpers. Neither is exercised by the resolver.
const navigateToProjectMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../server/playwright/bidboard.ts", () => ({ navigateToProject: navigateToProjectMock }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/playwright/browser.ts", () => ({
  randomDelay: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
  takeScreenshot: vi.fn(async () => ".playwright-storage/shot.png"),
}));

const {
  resolveNotesSectionByAnchor,
  resolveNotesSection,
  readNoteTextsDetailed,
  hasMarkerNote,
  postBidBoardProjectNote,
  CRM_ACTIVITY_NOTE_MARKER,
} = await import("../server/playwright/bidboard-notes.ts");
const { PROCORE_SELECTORS } = await import("../server/playwright/selectors.ts");

const NOTES = PROCORE_SELECTORS.bidboard.newUi.notes;

/**
 * The Chromium this repo already has, without downloading anything.
 *
 * `chromium.launch()` on its own only works when the build the installed playwright package PINS is
 * present; a package bump leaves several perfectly good older builds in the cache and none of them at
 * the pinned revision. So: try the pinned one, then fall back to the newest build actually on disk.
 * `PLAYWRIGHT_BROWSERS_PATH` is honoured because the Dockerfile sets it to /app/.playwright.
 *
 * Deliberately NOT `describe.skip` when nothing is found. A suite that silently skips is worse than no
 * suite: it reports green for the exact hazard it exists to catch.
 */
function installedChromiumPath(): string | undefined {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    path.join(os.homedir(), ".cache/ms-playwright"),
  ].filter((dir): dir is string => Boolean(dir) && fs.existsSync(dir!));
  const relatives = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux/chrome",
  ];
  for (const root of roots) {
    const builds = fs
      .readdirSync(root)
      .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
    for (const build of builds) {
      for (const relative of relatives) {
        const candidate = path.join(root, build, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    const executablePath = installedChromiumPath();
    if (!executablePath) {
      throw new Error(
        "No Chromium available for the real-DOM Notes tests. Run `npx playwright install chromium`. " +
          "These tests must not be skipped: the fake-DOM suite cannot express the selector semantics they cover.",
      );
    }
    browser = await chromium.launch({ headless: true, executablePath });
  }
  page = await browser.newPage();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

/** WHICH element resolved. The one assertion that can tell the Notes card from a wrapper around it. */
async function resolvedIdentity(result: any): Promise<string> {
  return await result.locator.evaluate((el: Element) => `${el.tagName}#${el.id || "(no id)"}`);
}

/** Procore's Project Description, rendered as the editable textarea — present on the real page. */
const DESCRIPTION_FIELD = '<textarea name="description">Existing project description</textarea>';
const PLUS = (id: string) => `<button id="${id}" aria-label="Add"><span><svg data-qa="ci-Plus" name="Plus"></svg></span></button>`;

describe("the Notes label selector, against real Chromium", () => {
  // Every claim in selectors.ts's `sectionLabel` docblock, executed. `:text-is()`/`:text-matches()`
  // semantics are subtle enough (see the badge case) that documenting them from memory is how the
  // count-suffix hazard got missed in the first place.
  it("matches Notes with or without a count suffix, and never matches Internal Notes", async () => {
    await page.setContent(`
      <div id="plain"><h3>Notes</h3></div>
      <div id="parens"><h3>Notes (3)</h3></div>
      <div id="spaced"><h3>Notes 3</h3></div>
      <div id="badge"><h3>Notes<span>3</span></h3></div>
      <div id="padded"><h3>  Notes  </h3></div>
      <div id="internal"><h3>Internal Notes</h3></div>
      <div id="sentence"><h3>Notes to self</h3></div>
    `);
    const labels = page.locator(NOTES.sectionLabel);
    const owners: string[] = [];
    for (let i = 0; i < (await labels.count()); i += 1) {
      owners.push(await labels.nth(i).evaluate((el) => (el.closest("div[id]") as HTMLElement).id));
    }
    expect(owners.sort()).toEqual(["badge", "padded", "parens", "plain", "spaced"]);
    expect(owners).not.toContain("internal");
    expect(owners).not.toContain("sentence");
  });
});

describe("resolveNotesSectionByAnchor, against real Chromium", () => {
  it("THE P0: resolves the Notes card, never the wrapper it shares with an Internal Notes card", async () => {
    // Observed failure of the climb-from-"+" rule: the decoy "+" comes first in DOM order, climbs to
    // #rightCol, and the note is then typed into the FIRST visible "+" under it — Internal Notes —
    // and reported `posted: true`. The idempotency read covers the same wrong container, so the
    // project is skipped forever after.
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard">
          <div class="hdr"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
          <div class="aid-note">Someone else's internal note</div>
        </div>
        <div id="notesCard">
          <div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div>
          <div class="aid-note">A real note</div>
        </div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });

  it("THE P1: resolves the CARD, not the header the '+' happens to sit in", async () => {
    // The innermost labelled ancestor of the "+" is #header, and the note ROWS are outside it. The
    // consequence is asserted below, not just the identity: with #header resolved, the idempotency
    // guard cannot see the existing CRM note, so every run posts another ~8 KB duplicate AND reports
    // it as a failure, because the post-save verify is equally blind.
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody">
          <div class="aid-note">Colby Burling · Aug 17, 2026 ${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</div>
        </div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#card");

    if (!result.ok) throw new Error("unreachable");
    const read = await readNoteTextsDetailed(result.locator, { timeoutMs: 2000 });
    expect(read.failed).toBe(false);
    expect(hasMarkerNote(read.texts)).toBe(true);
  });

  it("THE other P1: never resolves to <body> when no description textarea is rendered", async () => {
    // Procore renders the Project Description READ-ONLY until Edit is clicked, so `sectionContamination`
    // — which needs `textarea[name=…]` in the DOM at that instant — cannot fire at all. Observed on the
    // old rule: `{"ok":true,"id":"BODY"}`, i.e. the page-wide scope this module's own comment calls
    // "the single root cause behind a whole class of hazards — ⚠️ DO NOT ADD ONE".
    await page.setContent(`
      <div id="app">
        <nav id="topnav"><a href="#">Overview</a><a href="#">Documents</a></nav>
        <div id="col">
          <div id="card"><h3>Notes</h3>${PLUS("plus")}<div class="aid-note">A note</div></div>
        </div>
      </div>
      <div id="descriptionReadOnly"><label>Description</label><p>Existing project description</p></div>
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    const identity = await resolvedIdentity(result);
    expect(identity).not.toBe("BODY#(no id)");
    expect(identity).not.toBe("HTML#(no id)");
    // #app is rejected for holding the app's <nav>; #col is the widest container that is provably one
    // region with exactly one add control in it.
    expect(identity).toBe("DIV#col");
  });

  it("refuses to climb into <body> even with no landmark to stop it", async () => {
    // The tagName rejection standing alone: nothing on this page contaminates, and there is no nav,
    // tablist or <main> either. The container itself being a page root is the only remaining signal,
    // and a CSS `.locator()` cannot see it — only the `xpath=self::…` check can.
    await page.setContent(`
      <div id="shell"><div id="card"><h3>Notes</h3>${PLUS("plus")}<div class="aid-note">A note</div></div></div>
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#shell");
  });

  it("resolves a card whose label carries a count SUFFIX — Notes (3)", async () => {
    // `:text-is()` is exact, so a count suffix made the entire fix inert (observed: not-found). This
    // codebase already documents Procore doing exactly this to a Bid Board tab label.
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
        <div id="notesCard"><h3>Notes (3)</h3>${PLUS("plus")}<div class="aid-note">A note</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });

  it("resolves a card whose count is a BADGE element — <h3>Notes<span>3</span></h3>", async () => {
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
        <div id="notesCard"><h3>Notes<span class="badge">3</span></h3>${PLUS("plus")}<div class="aid-note">A note</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });

  it("fails CLOSED when the project has no Notes card at all", async () => {
    await page.setContent(`
      <div id="rightCol"><div id="filesCard"><h3>Files</h3>${PLUS("plus")}</div></div>
      ${DESCRIPTION_FIELD}
    `);
    expect(await resolveNotesSectionByAnchor(page)).toEqual({ ok: false, reason: "not-found" });
  });

  it("fails CLOSED on a page that has only an Internal Notes card, and never resolves to it", async () => {
    // The wrong-card write in its purest form: if "Internal Notes" could satisfy the label, this would
    // resolve to a card the CRM must never write into.
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("plus")}<div class="aid-note">Private</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("reports CONTAMINATED, not not-found, when the only candidate holds the description field", async () => {
    // A genuinely located but unusable card is a different diagnosis from a missing selector, and the
    // operator acts on them differently. The card here IS the Notes card; it is refused for holding
    // Procore's Project Description, which would put every scoped search below it page-wide in effect.
    await page.setContent(`
      <div id="notesCard"><h3>Notes</h3>${PLUS("plus")}${DESCRIPTION_FIELD}</div>
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
  });

  it("keeps a zero-notes card usable — the '+' is present before the first note exists", async () => {
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
        <div id="notesCard"><h3>Notes</h3>${PLUS("plus")}<p class="empty">No notes yet</p></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });
});

describe("resolveNotesSection end to end, against real Chromium", () => {
  it("falls through the precise tier to the climb and reports the climbed container", async () => {
    await page.setContent(`
      <div id="rightCol">
        <div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
        <div id="notesCard"><h3>Notes</h3>${PLUS("notesPlus")}<div class="aid-note">A note</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSection(page, { timeoutMs: 50, projectLabel: "9001" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
    expect(result.selector).toContain("Notes label");
  });

  it("is CLAMPED by the caller's deadline instead of walking every label on the page", async () => {
    // Three decoy "Notes" labels, each in a card that fails HARD (it holds the description field), and
    // the real card last. With a budget the climb walks past all three and finds it; with the caller's
    // deadline already spent it must stop after the first — the climb used to get no budget at all and
    // ran in full even when the step that owns the global browser lock had ~0ms left.
    const decoy = (n: number) =>
      `<div id="decoy${n}"><h3>Notes</h3>${PLUS(`decoyPlus${n}`)}${DESCRIPTION_FIELD}</div>`;
    await page.setContent(`
      <div id="left">${decoy(1)}${decoy(2)}${decoy(3)}</div>
      <div id="rightCol">
        <div id="otherCard"><h3>Files</h3>${PLUS("otherPlus")}</div>
        <div id="notesCard"><h3>Notes</h3>${PLUS("plus")}<div class="aid-note">A note</div></div>
      </div>
    `);

    const withBudget = await resolveNotesSection(page, { timeoutMs: 20, projectLabel: "9001" });
    expect(withBudget.ok).toBe(true);
    expect(await resolvedIdentity(withBudget)).toBe("DIV#notesCard");

    const spent = await resolveNotesSection(page, { timeoutMs: 0, deadlineAt: Date.now() - 1, projectLabel: "9001" });
    // Stopped after decoy1 — reported as what it actually saw, not as a bare "nothing here".
    expect(spent).toMatchObject({ ok: false, reason: "contaminated" });
  });
});

describe("readNoteTextsDetailed, against real Chromium", () => {
  it("bounds its innerText read instead of blocking for the 30s default", async () => {
    // Measured: `innerText()` on a locator resolving to ZERO elements takes 30002ms before throwing,
    // while `count()`/`isVisible()` answer in ~1ms. This call sits inside a 10s verify window, holding
    // the global browser lock, so the default alone blew the whole budget three times over.
    await page.setContent(`<div id="card"><h3>Notes</h3></div>`);
    const detached = page.locator("#gone-from-the-dom");
    const startedAt = Date.now();
    const read = await readNoteTextsDetailed(detached, { timeoutMs: 500 });
    const elapsed = Date.now() - startedAt;
    expect(read.failed).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("postBidBoardProjectNote end to end, against real Chromium", () => {
  /**
   * A working Procore-shaped Notes card: "+" opens a note composer INSIDE its own card, Create commits
   * the text as a note row in that same card. Two cards, so a wrong-card resolution is VISIBLE in the
   * final DOM rather than merely inferred — this is the assertion the P0 needed and did not have.
   */
  const twoCardPage = `
    <div id="rightCol">
      <div id="internalNotesCard" class="notes-card">
        <div class="hdr"><h3>Internal Notes</h3>${PLUS("internalPlus")}</div>
        <div class="rows"></div>
      </div>
      <div id="notesCard" class="notes-card">
        <div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div>
        <div class="rows"></div>
      </div>
    </div>
    ${DESCRIPTION_FIELD}
    <script>
      document.querySelectorAll('.notes-card button').forEach((button) => {
        button.addEventListener('click', () => {
          const card = button.closest('.notes-card');
          if (card.querySelector('textarea')) return;
          const composer = document.createElement('div');
          composer.className = 'composer';
          composer.innerHTML =
            '<textarea name="value" placeholder="Enter note"></textarea>' +
            '<button class="aid-confirmButton">Create</button>';
          card.appendChild(composer);
          composer.querySelector('button').addEventListener('click', () => {
            const row = document.createElement('div');
            row.className = 'aid-note';
            row.textContent = 'Colby Burling \\u00b7 Aug 18, 2026\\n' + composer.querySelector('textarea').value;
            card.querySelector('.rows').appendChild(row);
            composer.remove();
          });
        });
      });
    </script>
  `;

  const NOTE = [
    `${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Aug 17, 2026)`,
    "",
    "Aug 14, 2026 · Call (connected, 15 min) · Jane Rep",
    "  Owner confirmed scope; wants alternates priced.",
  ].join("\n");

  it("posts into the Notes card and leaves the Internal Notes card untouched", async () => {
    await page.setContent(twoCardPage);
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", {
      verifyTimeoutMs: 4000,
      overallTimeoutMs: 20000,
      stepTimeoutMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ posted: true, skipped: false });
    // WHERE it landed — the assertion the P0 turned on. `posted: true` was already true when the note
    // went into the wrong card.
    expect(await page.locator("#notesCard .aid-note").count()).toBe(1);
    expect(await page.locator("#internalNotesCard .aid-note").count()).toBe(0);
    expect(await page.locator("#notesCard .aid-note").innerText()).toContain("Owner confirmed scope");
    // …and Procore's Project Description is exactly as it was.
    expect(await page.locator('textarea[name="description"]').inputValue()).toBe("Existing project description");
  });

  it("SKIPS a project that already has a CRM note, reading the card that actually holds the rows", async () => {
    // The header-layout consequence, end to end: if the resolved container were the header, this note
    // would be invisible and a second ~8 KB copy would be posted — on every run, forever.
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody"><div class="aid-note">Colby Burling · Aug 17, 2026 ${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", {
      verifyTimeoutMs: 1000,
      overallTimeoutMs: 15000,
      stepTimeoutMs: 500,
    });

    expect(result).toMatchObject({ posted: false, skipped: true });
    expect(result.error).toBeUndefined();
    // Nothing was added; the existing note is still the only one.
    expect(await page.locator(".aid-note").count()).toBe(1);
  });

  it("declines without typing when the Notes card cannot be identified", async () => {
    await page.setContent(`
      <div id="rightCol"><div id="internalNotesCard"><h3>Internal Notes</h3>${PLUS("plus")}</div></div>
      ${DESCRIPTION_FIELD}
    `);
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", {
      verifyTimeoutMs: 500,
      overallTimeoutMs: 10000,
      stepTimeoutMs: 200,
    });

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/Notes section not found/i);
    expect(await page.locator(".aid-note").count()).toBe(0);
    expect(await page.locator('textarea[name="description"]').inputValue()).toBe("Existing project description");
  });
});
