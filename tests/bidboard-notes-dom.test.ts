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
  // PLAYWRIGHT_BROWSERS_PATH=0 means "inside the package", not a directory named "0"; and a root that is a FILE
  // would make readdirSync throw out of beforeAll, replacing the intended message below with an fs error.
  const isDirectory = (dir: string) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH === "0" ? undefined : process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), "Library/Caches/ms-playwright"),
    path.join(os.homedir(), ".cache/ms-playwright"),
  ].filter((dir): dir is string => Boolean(dir) && isDirectory(dir!));
  const relatives = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux/chrome",
    // Playwright 1.58's linux-x64 full-Chromium layout; `chrome-linux/chrome` is the arm64 one.
    "chrome-linux64/chrome",
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

  /**
   * Codex round 1 on #73 (P1): the climb keeps the OUTERMOST ancestor with exactly one "+", so a column that holds
   * the Notes card AND a card with no "+" of its own resolved to the whole column. The generic editor/Create tiers
   * could then reach the neighbouring card. The Tasks card here has both a contenteditable and a Create submit.
   * Since round 3 the climb also stops at the card boundary (`sectionForeignCard`), so this resolves to #notesCard;
   * these tests keep the confirmed-hooks-only write path covered as the second line of defence.
   */
  const columnWithTasksCard = (composer: "confirmed" | "none") => `
    <div id="col">
      <div id="notesCard" class="notes-card">
        <div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div>
        <div class="rows"></div>
      </div>
      <div id="tasksCard">
        <h3>Tasks</h3>
        <div id="taskBox" contenteditable="true"></div>
        <button id="taskCreate" type="submit">Create</button>
      </div>
    </div>
    ${DESCRIPTION_FIELD}
    <script>
      document.getElementById('taskCreate').addEventListener('click', () => {
        document.getElementById('taskCreate').dataset.clicked = 'yes';
      });
      document.getElementById('notesPlus').addEventListener('click', () => {
        if (${JSON.stringify(composer)} === 'none') return; // the editor never renders
        const card = document.getElementById('notesCard');
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
          row.textContent = 'Colby Burling \\u00b7 Sep 30, 2026\\n' + composer.querySelector('textarea').value;
          card.querySelector('.rows').appendChild(row);
          composer.remove();
        });
      });
    </script>
  `;

  it("THE round-1 P1: a column-wide card posts only through the confirmed editor and its own Create", async () => {
    await page.setContent(columnWithTasksCard("confirmed"));
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", {
      verifyTimeoutMs: 4000,
      overallTimeoutMs: 20000,
      stepTimeoutMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(await page.locator("#notesCard .aid-note").innerText()).toContain("Owner confirmed scope");
    // The neighbouring card is exactly as it was: nothing typed, its Create never pressed.
    expect(await page.locator("#taskBox").innerText()).toBe("");
    expect(await page.locator("#taskCreate").getAttribute("data-clicked")).toBeNull();
    expect(await page.locator('textarea[name="description"]').inputValue()).toBe("Existing project description");
  });

  it("THE round-1 P1: when the Notes editor never opens, it declines rather than typing into a neighbouring card", async () => {
    await page.setContent(columnWithTasksCard("none"));
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE, "DFW-2-12345-ab", {
      verifyTimeoutMs: 500,
      overallTimeoutMs: 10000,
      stepTimeoutMs: 300,
    });

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/Note editor not found/i);
    expect(await page.locator("#taskBox").innerText()).toBe("");
    expect(await page.locator("#taskCreate").getAttribute("data-clicked")).toBeNull();
  });
});

describe("postBidBoardProjectNote in a shared column, Create found from the note field, against real Chromium", () => {
  it("THE round-1 P1: clicks the composer's own Create, not an earlier card's Create in the same column", async () => {
    // Tasks comes FIRST, and the composer's Create is a plain button: the generic `button:has-text("Create")` tier,
    // searched across the column, would press the Tasks card's Create before the composer's.
    await page.setContent(`
      <div id="col">
        <div id="tasksCard"><h3>Tasks</h3><button id="taskCreate">Create</button></div>
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
      </div>
      ${DESCRIPTION_FIELD}
      <script>
        document.getElementById('taskCreate').addEventListener('click', () => {
          document.getElementById('taskCreate').dataset.clicked = 'yes';
        });
        document.getElementById('notesPlus').addEventListener('click', () => {
          const card = document.getElementById('notesCard');
          if (card.querySelector('textarea')) return;
          const composer = document.createElement('div');
          const field = document.createElement('textarea');
          field.name = 'value';
          field.placeholder = 'Enter note';
          const create = document.createElement('button');
          create.textContent = 'Create';
          composer.append(field, create);
          card.appendChild(composer);
          create.addEventListener('click', () => {
            const row = document.createElement('div');
            row.className = 'aid-note';
            row.textContent = field.value;
            card.querySelector('.rows').appendChild(row);
            composer.remove();
          });
        });
      </script>
    `);
    navigateToProjectMock.mockResolvedValue(true);
    const NOTE_TEXT = [`${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Sep 30, 2026)`, "", "Owner confirmed scope."].join("\n");

    const result = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 4000,
      overallTimeoutMs: 20000,
      stepTimeoutMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(await page.locator("#taskCreate").getAttribute("data-clicked")).toBeNull();
    expect(await page.locator("#notesCard .aid-note").innerText()).toContain("Owner confirmed scope");
  });
});

describe("the Create climb stays inside the composer, against real Chromium", () => {
  it("THE round-2 finding: a Notes composer with no Create declines — never the neighbouring card's Create", async () => {
    // CodeRabbit on 7895d55: the Tasks card has a Create and NO text field, so a one-field rule alone let the climb
    // from the note field rise into the column and press it.
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
        <div id="tasksCard"><h3>Tasks</h3><button id="taskCreate" type="submit">Create</button></div>
      </div>
      ${DESCRIPTION_FIELD}
      <script>
        document.getElementById('taskCreate').addEventListener('click', () => {
          document.getElementById('taskCreate').dataset.clicked = 'yes';
        });
        document.getElementById('notesPlus').addEventListener('click', () => {
          const card = document.getElementById('notesCard');
          if (card.querySelector('textarea')) return;
          const composer = document.createElement('div');
          const field = document.createElement('textarea');
          field.name = 'value';
          field.placeholder = 'Enter note';
          composer.append(field); // no Create in the composer
          card.appendChild(composer);
        });
      </script>
    `);
    navigateToProjectMock.mockResolvedValue(true);

    const NOTE_TEXT = [`${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Sep 30, 2026)`, "", "Owner confirmed scope."].join("\n");
    const result = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 500,
      overallTimeoutMs: 10000,
      stepTimeoutMs: 300,
    });

    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/Create button not found/i);
    expect(await page.locator("#taskCreate").getAttribute("data-clicked")).toBeNull();
  });
});

describe("resolveNotesSection polling, against real Chromium", () => {
  it("THE round-1 P2: finds a structural card at once, instead of first waiting out the precise tier", async () => {
    await page.setContent(`
      <div id="card"><div class="hdr"><h3>Notes</h3>${PLUS("plus")}</div><div class="rows"></div></div>
      ${DESCRIPTION_FIELD}
    `);
    const started = Date.now();
    const result = await resolveNotesSection(page, { timeoutMs: 8000 });
    expect(result).toMatchObject({ ok: true, structural: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still WAITS for a Notes card that renders late — the poll is still a poll", async () => {
    await page.setContent(`
      ${DESCRIPTION_FIELD}
      <script>
        setTimeout(() => {
          const card = document.createElement('div');
          card.id = 'card';
          const hdr = document.createElement('div');
          const h3 = document.createElement('h3');
          h3.textContent = 'Notes';
          const plus = document.createElement('button');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('data-qa', 'ci-Plus');
          plus.appendChild(svg);
          hdr.append(h3, plus);
          card.appendChild(hdr);
          document.body.appendChild(card);
        }, 700);
      </script>
    `);
    const result = await resolveNotesSection(page, { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, structural: true });
  });
});

/**
 * Codex round 3 on #73 (a3d6245). The climb kept the OUTERMOST ancestor with exactly one "+", so a neighbouring
 * card WITHOUT a "+" of its own was swallowed: the resolver returned the shared column, and every read and lookup
 * after it ran over the neighbour too. `sectionForeignCard` is the card boundary that stops it.
 */
describe("the structural climb stops at the Notes card's boundary, against real Chromium", () => {
  const NOTE_TEXT = [`${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Oct 2, 2026)`, "", "Owner confirmed scope."].join("\n");
  /** "+" opens a composer with the CONFIRMED note field inside #notesCard; Create commits a row there. */
  const notesComposerScript = `
    document.getElementById('notesPlus').addEventListener('click', () => {
      const card = document.getElementById('notesCard');
      if (card.querySelector('.composer')) return;
      const composer = document.createElement('div');
      composer.className = 'composer';
      const field = document.createElement('textarea');
      field.name = 'value';
      field.placeholder = 'Enter note';
      const create = document.createElement('button');
      create.textContent = 'Create';
      composer.append(field, create);
      card.appendChild(composer);
      create.addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'aid-note';
        row.textContent = field.value;
        card.querySelector('.rows').appendChild(row);
        composer.remove();
      });
    });`;

  it("THE round-3 P1: a titled neighbour with no '+' stops the climb at the card, not the shared column", async () => {
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
        <div id="tasksCard"><h3>Tasks</h3><button>Create</button></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });

  it("THE round-3 P1: an UNTITLED neighbour is still a boundary when it holds a text field", async () => {
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
        <div id="otherCard"><span>Follow-ups</span><div contenteditable="true"></div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });

  it("THE round-3 P1: fails CLOSED when the label's own row already shares a container with another card", async () => {
    // No container holds the Notes label and its "+" without the Tasks title too — there is no Notes-only scope.
    await page.setContent(`
      <div id="row"><h3>Notes</h3><h3>Tasks</h3>${PLUS("plus")}</div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
    if (result.ok || result.reason !== "contaminated") throw new Error("unreachable");
    expect(result.selector).toContain("another card");
  });

  it("THE round-3 P1, end to end: never types into a neighbour's note-shaped field that comes FIRST in the column", async () => {
    // The neighbour carries a field identical to the confirmed note input, and its own Create. With the column
    // resolved, the confirmed-input lookup took the first visible match (the neighbour's) and the Create climb from
    // it pressed the neighbour's Create — a write into another card.
    await page.setContent(`
      <div id="col">
        <div id="followUpCard">
          <textarea id="followUpField" name="value" placeholder="Enter note"></textarea>
          <button id="followUpCreate">Create</button>
        </div>
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
      </div>
      ${DESCRIPTION_FIELD}
      <script>
        document.getElementById('followUpCreate').addEventListener('click', () => {
          document.getElementById('followUpCreate').dataset.clicked = 'yes';
        });
        ${notesComposerScript}
      </script>
    `);
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 4000,
      overallTimeoutMs: 20000,
      stepTimeoutMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ posted: true, skipped: false });
    expect(await page.locator("#followUpField").inputValue()).toBe("");
    expect(await page.locator("#followUpCreate").getAttribute("data-clicked")).toBeNull();
    expect(await page.locator("#notesCard .aid-note").innerText()).toContain("Owner confirmed scope");
  });

  it("THE round-3 P2 (marker read): a neighbour card quoting the marker never makes the Notes card SKIP", async () => {
    // Since the header-only check (CodeRabbit on 6e05da3) this declines rather than posts: a marker outside the
    // resolved card is indistinguishable from a note row the boundary could not recognise. What Codex flagged — a
    // silent `skipped: true` with no note in Notes — must still never happen, and nothing may be written.
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
        <div id="activityCard"><h3>Activity</h3><p>${CRM_ACTIVITY_NOTE_MARKER} copied into another card</p></div>
      </div>
      ${DESCRIPTION_FIELD}
      <script>${notesComposerScript}</script>
    `);
    navigateToProjectMock.mockResolvedValue(true);

    const result = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 4000,
      overallTimeoutMs: 20000,
      stepTimeoutMs: 2000,
    });

    expect(result).toMatchObject({ posted: false, skipped: false });
    expect(result.error).toMatch(/not a usable Notes card/);
    expect(result.error).toMatch(/header/);
    expect(await page.locator(".aid-note").count()).toBe(0);
    expect(await page.locator("textarea[name=value]").count()).toBe(0);
  });

  it("THE round-3 P2 (hidden duplicate '+'): a hidden template copy inside the card does not split it", async () => {
    // Raw-counted, the hidden copy made the card read as two cards: the climb stopped at the header, which does not
    // hold the rows, so the idempotency read was blind to the existing CRM note.
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody">
          <div style="display:none">${PLUS("hiddenTemplatePlus")}</div>
          <div class="aid-note">Colby Burling · Aug 17, 2026 ${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</div>
        </div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#card");

    navigateToProjectMock.mockResolvedValue(true);
    const posted = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 1000,
      overallTimeoutMs: 15000,
      stepTimeoutMs: 500,
    });
    expect(posted).toMatchObject({ posted: false, skipped: true });
  });

  it("THE round-3 P2 (hidden duplicate '+'): a neighbour whose '+' is hidden is still outside the card", async () => {
    // Counting only visible "+" must not let the climb widen over a neighbour with a hidden one; its title stops it.
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div><div class="rows"></div></div>
        <div id="internalNotesCard"><h3>Internal Notes</h3><span style="visibility:hidden">${PLUS("internalPlus")}</span></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });
});

/**
 * CodeRabbit on 6e05da3 (Major): `sectionForeignCard` counted headings and fields INSIDE note rows, so an author
 * `<h6>` in a row stopped the climb at the header — which does not hold the rows — and the header came back `ok`.
 * The idempotency read and the post-save verify were then blind to the card's notes: a duplicate on every run.
 */
describe("the card boundary never leaves the header as the Notes card, against real Chromium", () => {
  const NOTE_TEXT = [`${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Oct 2, 2026)`, "", "Owner confirmed scope."].join("\n");

  it("a heading and a field inside a recognised note row are Notes content: resolves the CARD and skips", async () => {
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody">
          <div class="aid-note"><h6>Colby Burling</h6><span>Aug 17, 2026</span>
            <p>${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</p><textarea aria-label="Edit note"></textarea></div>
        </div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#card");

    navigateToProjectMock.mockResolvedValue(true);
    const posted = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 1000,
      overallTimeoutMs: 15000,
      stepTimeoutMs: 500,
    });
    expect(posted).toMatchObject({ posted: false, skipped: true });
    expect(await page.locator(".aid-note").count()).toBe(1);
  });

  it("rows the boundary cannot recognise, holding the marker, make it DECLINE rather than return the header", async () => {
    // No note-row hook at all: the `<h6>` stops the climb at the header. The marker in the stop container, absent
    // from the header, is what proves the header is not the card.
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody"><article class="row"><h6>Colby Burling</h6><p>${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</p></article></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
    if (result.ok || result.reason !== "contaminated") throw new Error("unreachable");
    expect(result.selector).toContain("header");

    navigateToProjectMock.mockResolvedValue(true);
    const posted = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", {
      verifyTimeoutMs: 500,
      overallTimeoutMs: 10000,
      stepTimeoutMs: 300,
    });
    expect(posted).toMatchObject({ posted: false, skipped: false });
    expect(await page.locator("article.row").count()).toBe(1);
  });

  it("recognised rows outside the stop make it DECLINE even before any CRM note exists", async () => {
    // A field in the body (an always-open composer the boundary counts) stops the climb at the header; the rows
    // beside it are recognised, so the header is refused before the first post rather than after a duplicate.
    await page.setContent(`
      <div id="card">
        <div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
        <div id="cardBody"><div contenteditable="true"></div><div class="aid-note">Colby Burling · a rep's own note</div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
  });

  it("a neighbouring card still bounds the Notes card when the card has rows of its own", async () => {
    // The header-only check must not undo the round-3 P1: rows INSIDE the resolved card are not "outside" it.
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("notesPlus")}</div>
          <div class="rows"><div class="aid-note"><h6>Colby Burling</h6>${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</div></div></div>
        <div id="tasksCard"><h3>Tasks</h3><div contenteditable="true"></div></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });
});

/**
 * Adversarial review of #73 at c15e2a0 — three cases reproduced in real Chromium, ported from the reviewer's
 * fixtures (/private/tmp/pr73-adv/adv.test.ts) with assertions in place of their diagnostics.
 */
describe("adversarial review at c15e2a0, against real Chromium", () => {
  const NOTE_TEXT = [`${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab (as of Oct 2, 2026)`, "", "Owner confirmed scope."].join("\n");
  const ADV_OPTS = { verifyTimeoutMs: 3000, overallTimeoutMs: 20000, stepTimeoutMs: 2000 };

  it("finding 3: a card that vanishes mid-climb (SPA re-render) fails CLOSED instead of returning the header", async () => {
    await page.setContent(`
      <div id="col"><div id="slot">
        <div id="card"><div id="header"><h3>Notes</h3>${PLUS("plus")}</div>
          <div id="cardBody"><div class="aid-note">Colby · ${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</div></div></div>
      </div><div><h3>Tasks</h3></div></div>
      ${DESCRIPTION_FIELD}
    `);
    // Re-render the card's slot at the moment the climb counts the CARD level (label ⇑2), and restore it 150 ms
    // later — the window in which `count()` sees zero for that ancestor.
    let fired = false;
    const wrap = (loc: any): any =>
      new Proxy(loc, {
        get(target, prop) {
          if (prop === "count") {
            return async () => {
              if (!fired && String(target).endsWith(".locator('..').locator('..')")) {
                fired = true;
                await page.evaluate(() => {
                  const slot = document.getElementById("slot")!;
                  const html = slot.innerHTML;
                  slot.innerHTML = '<div class="skeleton">Loading…</div>';
                  setTimeout(() => {
                    slot.innerHTML = html;
                  }, 150);
                });
              }
              return target.count();
            };
          }
          const value = target[prop];
          if (["locator", "nth", "filter", "first", "last"].includes(prop as string)) {
            return (...args: any[]) => wrap(value.apply(target, args));
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const result = await resolveNotesSectionByAnchor({ locator: (selector: string) => wrap(page.locator(selector)) } as any);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fired).toBe(true);
    // Was `ok` with the HEADER, whose read cannot see the existing CRM note.
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("finding 2: a header-only refusal of the real card declines everything — never a second 'Notes' card", async () => {
    // The real card's rows are unrecognisable and hold the CRM note, so its climb is refused as header-only. The
    // next "Notes" label then resolved #notes2 and posted a duplicate there.
    await page.setContent(`
      <div id="col1">
        <div id="card"><div id="header"><h3>Notes</h3>${PLUS("plus1")}</div>
          <div id="cardBody"><article class="row"><h6>Colby Burling</h6><p>${CRM_ACTIVITY_NOTE_MARKER} DFW-2-12345-ab</p></article></div></div>
      </div>
      <div id="col2">
        <div id="notes2"><div class="hdr"><h3>Notes</h3>${PLUS("plus2")}</div><div class="rows"></div></div>
        <div><h3>Other</h3></div>
      </div>
      ${DESCRIPTION_FIELD}
      <script>
        document.getElementById('plus2').addEventListener('click', () => {
          const card = document.getElementById('notes2');
          if (card.querySelector('textarea')) return;
          const composer = document.createElement('div');
          const field = document.createElement('textarea'); field.name = 'value'; field.placeholder = 'Enter note';
          const create = document.createElement('button'); create.textContent = 'Create';
          composer.append(field, create); card.appendChild(composer);
          create.addEventListener('click', () => {
            const row = document.createElement('div'); row.className = 'aid-note'; row.textContent = field.value;
            card.querySelector('.rows').appendChild(row); composer.remove();
          });
        });
      </script>
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
    if (result.ok || result.reason !== "contaminated") throw new Error("unreachable");
    expect(result.selector).toContain("header");

    navigateToProjectMock.mockResolvedValue(true);
    const posted = await postBidBoardProjectNote(page, "9001", NOTE_TEXT, "DFW-2-12345-ab", ADV_OPTS);
    expect(posted).toMatchObject({ posted: false, skipped: false });
    expect(await page.locator("#notes2 .aid-note").count()).toBe(0);
    expect(await page.locator("#plus2").count()).toBe(1);
  });

  it("finding 2: two separate, valid 'Notes' cards are ambiguous — decline rather than pick the first", async () => {
    await page.setContent(`
      <div id="col1"><div id="notesA"><h3>Notes</h3>${PLUS("plusA")}<div class="rows"></div></div><div><h3>Files</h3></div></div>
      <div id="col2"><div id="notesB"><h3>Notes</h3>${PLUS("plusB")}<div class="rows"></div></div><div><h3>Tasks</h3></div></div>
      ${DESCRIPTION_FIELD}
    `);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result).toMatchObject({ ok: false, reason: "contaminated" });
    if (result.ok || result.reason !== "contaminated") throw new Error("unreachable");
    expect(result.selector).toMatch(/ambiguous/);
  });

  it("finding 2: two 'Notes' labels inside ONE card are one card, not an ambiguity", async () => {
    await page.setContent(`
      <div id="col">
        <div id="notesCard"><div class="hdr"><h3>Notes</h3>${PLUS("plus")}</div>
          <div class="rows"><div class="aid-note"><span>Notes</span> from the walkthrough</div></div></div>
        <div><h3>Tasks</h3></div>
      </div>
      ${DESCRIPTION_FIELD}
    `);
    expect(await page.locator(NOTES.sectionLabel).count()).toBe(2);
    const result = await resolveNotesSectionByAnchor(page);
    expect(result.ok).toBe(true);
    expect(await resolvedIdentity(result)).toBe("DIV#notesCard");
  });
});
