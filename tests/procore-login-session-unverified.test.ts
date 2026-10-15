import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the 2026-10 silent outage. Production showed, every 19 minutes:
 *
 *   [playwright] Login accepted but UNVERIFIED (no authenticated marker)
 *   [playwright] BidBoard export RPA failed: Export menu button not found because SyncHub cannot
 *                confirm a Procore session (no authenticated-session element found on the page) —
 *                this is a Procore sign-in failure…
 *
 * …while procore_login_alert_state stayed 'ok' (last success 2026-09-11) and no alert was ever sent.
 * Two holes, both closed here:
 *  1. an UNVERIFIED login was reported to the alert module as a SUCCESS ({ ok: true });
 *  2. the export's own confirmed sign-in failure (describeSelectorMiss) was thrown, logged, and never
 *     reported to the alert module at all.
 * Plus the export's "navigation-based download" fallback, which can only ever pick up an OLDER export
 * already sitting in data/exports and silently re-process it as if it were fresh.
 *
 * DB, email and Playwright are all faked: the alert module is replaced by a spy (its persistence and
 * throttle are exercised against real Postgres in procore-login-alert.runtime.test.ts).
 */

const logMock = vi.hoisted(() => vi.fn());
const getPageMock = vi.hoisted(() => vi.fn());
const getAutomationConfigMock = vi.hoisted(() => vi.fn(async (_key: string) => null as any));
const recordLoginOutcomeMock = vi.hoisted(() => vi.fn(async () => ({ action: "none" as const })));

vi.mock("../server/index.ts", () => ({ log: logMock }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: getAutomationConfigMock } }));
vi.mock("../server/playwright/browser.ts", () => ({
  getPage: getPageMock,
  saveSession: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
  closeBrowser: vi.fn(async () => {}),
  withRetry: vi.fn(),
  randomDelay: vi.fn(async () => {}),
  takeScreenshot: vi.fn(async () => "/tmp/shot.png"),
  waitForNavigation: vi.fn(),
  withBrowserLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../server/sync/procore-login-alert.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/sync/procore-login-alert")>()),
  recordLoginOutcomeAndMaybeAlert: recordLoginOutcomeMock,
}));

const { describeSelectorMiss, encryptPassword, ensureLoggedIn } = await import("../server/playwright/auth.ts");

const BID_BOARD_URL = "https://us02.procore.com/webclients/host/companies/1234/tools/bid-board";
const LOGIN_URL = "https://login.procore.com/?redirect=/webclients/host/companies/1234/tools/bid-board";
const EXPORT_BLOCKING = "Bid Board stage sync (Excel export)";
/** A throwaway value purely so decryptPassword() succeeds; not a credential. */
const FAKE_PASSWORD = "unit-test-not-a-password-9f3a";

function fakePage(url: string, present: RegExp[]) {
  return {
    url: () => url,
    $: vi.fn(async (selector: string) => (present.some((re) => re.test(selector)) ? { handle: selector } : null)),
    waitForTimeout: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
  };
}

/** Every recorded outcome, in call order. */
const recorded = () => recordLoginOutcomeMock.mock.calls.map((c: any[]) => c[0]);

beforeEach(() => {
  logMock.mockClear();
  recordLoginOutcomeMock.mockClear();
});

// ── 1. An UNVERIFIED login is not a success ──────────────────────────────────

describe("ensureLoggedIn — 'Login accepted but UNVERIFIED'", () => {
  /** Walks Procore's login form; after Sign In it lands on an app URL that shows NO session element
   *  at all — exactly the production page: off the sign-in host, nothing signed-in on it. */
  function unverifiedLoginPage() {
    let url = "https://login.procore.com/";
    let submitted = false;
    const handle = (selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        if (/Sign In/i.test(selector)) {
          submitted = true;
          url = BID_BOARD_URL;
        }
      }),
    });
    return {
      url: () => url,
      goto: vi.fn(async (to: string) => {
        url = to;
      }),
      waitForTimeout: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}),
      waitForSelector: vi.fn(async (selector: string) => handle(selector)),
      $: vi.fn(async (selector: string) => {
        // Before submit: the old one-step form (password visible). After: an empty page.
        if (!submitted && /password/i.test(selector)) return handle(selector);
        return null;
      }),
    };
  }

  async function runUnverifiedLogin() {
    const prevKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "unit-test-key-not-a-secret";
    try {
      getPageMock.mockResolvedValue(unverifiedLoginPage());
      getAutomationConfigMock.mockResolvedValue({
        value: { email: "automation@example.invalid", encryptedPassword: encryptPassword(FAKE_PASSWORD), sandbox: false },
      });
      return await ensureLoggedIn({ blocking: EXPORT_BLOCKING });
    } finally {
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
    }
  }

  it("is NOT reported to the alert module as a success (it used to flip/keep the state 'ok')", async () => {
    const res = await runUnverifiedLogin();

    // The precondition this test exists for: the production log line.
    expect(logMock.mock.calls.map((c) => String(c[0])).some((l) => /UNVERIFIED/.test(l))).toBe(true);
    expect(recorded().some((r: any) => r.outcome?.ok === true)).toBe(false);
    // Callers still get to try (the downstream page check is what confirms the failure), but they
    // are told the session is unverified.
    expect(res.success).toBe(true);
    expect(res.verified).toBe(false);
  });
});

// ── 2. A confirmed selector-miss sign-in failure reaches the alert module ────

describe("describeSelectorMiss — reports a confirmed sign-in failure", () => {
  it("records a failure when the page shows no signed-in session (the production case)", async () => {
    const err = await describeSelectorMiss(fakePage(BID_BOARD_URL, []), "Export menu button", {
      blocking: EXPORT_BLOCKING,
    });

    expect(err.message).toMatch(/cannot confirm a Procore session/i);
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]).toMatchObject({
      outcome: { ok: false, reason: "session_not_established", blocking: EXPORT_BLOCKING },
    });
    expect(recorded()[0].outcome.error).toMatch(/Export menu button/);
  });

  it("records a failure when the page is a Procore sign-in screen", async () => {
    await describeSelectorMiss(fakePage(LOGIN_URL, [/password/i]), "Export menu button", { blocking: EXPORT_BLOCKING });

    expect(recorded().at(-1)).toMatchObject({ outcome: { ok: false, reason: "session_not_established" } });
  });

  it("records nothing for an AUTHENTICATED page (a real UI change is not a sign-in failure)", async () => {
    const err = await describeSelectorMiss(fakePage(BID_BOARD_URL, [/spaContent/, /nav/]), "Export menu button");

    expect(err.message).toBe("Export menu button not found. Procore UI may have changed.");
    expect(recordLoginOutcomeMock).not.toHaveBeenCalled();
  });

  it("records nothing when the probe itself crashed (a dead page proves nothing either way)", async () => {
    const broken = {
      url: () => BID_BOARD_URL,
      $: vi.fn(async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    };
    await describeSelectorMiss(broken, "Export menu button");

    expect(recordLoginOutcomeMock).not.toHaveBeenCalled();
  });
});

// ── 3. The export: sign-in failure, real success, and the stale-file fallback ─

describe("exportBidBoardProjectList — alerting and the stale-export fallback", () => {
  afterEach(() => {
    vi.doUnmock("../server/playwright/auth.ts");
    vi.doUnmock("fs/promises");
    vi.resetModules();
  });

  const OLD_EXPORT = "bidboard-export-2026-09-11T05-20-00-000Z.xlsx";
  let fsMock: Record<string, any>;

  async function runExportWith(page: any, opts: { existingExports?: string[] } = {}) {
    vi.resetModules();
    fsMock = {
      mkdir: vi.fn(async () => {}),
      readdir: vi.fn(async () => opts.existingExports ?? []),
      rename: vi.fn(async () => {}),
      access: vi.fn(async () => {}),
      default: {},
    };
    vi.doMock("fs/promises", () => fsMock);
    vi.doMock("../server/playwright/auth.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../server/playwright/auth")>()),
      ensureLoggedIn: vi.fn(async () => ({ page, success: true })),
    }));
    getAutomationConfigMock.mockImplementation(async (key: string) =>
      key === "procore_config" ? { value: { companyId: "1234" } } : { value: { sandbox: false } }
    );
    const { exportBidBoardProjectList } = await import("../server/playwright/bidboard-export.ts");
    return exportBidBoardProjectList();
  }

  /** A page on which every three-dot menu selector misses. */
  function pageWithNoMenu(url: string, present: RegExp[]) {
    const missing = {
      first: () => missing,
      count: vi.fn(async () => 0),
      isVisible: vi.fn(async () => false),
      click: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
    };
    return {
      ...fakePage(url, present),
      locator: vi.fn(() => missing),
      getByRole: vi.fn(() => missing),
      keyboard: { press: vi.fn(async () => {}) },
      waitForEvent: vi.fn(() => new Promise(() => {})),
    };
  }

  /** An authenticated page where the menu and the export link are found and clicked; `download` is
   *  what Playwright's download event yields (null = the event never fired). */
  function pageWithExport(download: { saveAs: (p: string) => Promise<void> } | null) {
    const found: any = {
      first: () => found,
      filter: () => found,
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
    };
    return {
      ...fakePage(BID_BOARD_URL, [/spaContent/, /nav/]),
      locator: vi.fn(() => found),
      getByRole: vi.fn(() => found),
      keyboard: { press: vi.fn(async () => {}) },
      waitForEvent: vi.fn(() => Promise.resolve(download)),
    };
  }

  it("records the export's sign-in failure (no session on the Bid Board page) with what it blocks", async () => {
    await expect(runExportWith(pageWithNoMenu(BID_BOARD_URL, []))).rejects.toThrow(/sign-in failure/i);

    expect(recorded().at(-1)).toMatchObject({
      outcome: { ok: false, reason: "session_not_established", blocking: EXPORT_BLOCKING },
    });
  });

  it("records a real success when Procore actually delivers the export file", async () => {
    const saveAs = vi.fn(async () => {});
    const out = await runExportWith(pageWithExport({ saveAs }));

    expect(out).toMatch(/bidboard-export-.*\.xlsx$/);
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(recorded().at(-1)).toMatchObject({ outcome: { ok: true, blocking: EXPORT_BLOCKING } });
  });

  it("refuses to re-use an OLDER export file when Procore delivered nothing — fails visibly instead", async () => {
    // Playwright never saves downloads into data/exports (no downloadsPath), so the only .xlsx this
    // fallback can ever find is a PREVIOUS export. It used to rename that old file to a fresh
    // timestamp and hand it to the stage sync as if it were today's Bid Board.
    await expect(runExportWith(pageWithExport(null), { existingExports: [OLD_EXPORT] })).rejects.toThrow(
      /no export file/i
    );

    expect(fsMock.rename).not.toHaveBeenCalled();
    const lines = logMock.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /older export/i.test(l))).toBe(true);
    // Not a sign-in problem: nothing recorded as a login outcome either way.
    expect(recorded().some((r: any) => r.outcome?.ok === true)).toBe(false);
  });
});
