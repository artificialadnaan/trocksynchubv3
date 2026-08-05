import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the 2026-08-03 outage: the Procore password changed, and every
 * Playwright-driven flow died while the logs blamed the wrong thing —
 *
 *   Trying three-dot menu selector: [data-qa="ci-EllipsisVertical"] (found 0 elements)
 *   ... all selectors exhausted
 *   BidBoard export RPA failed: Export menu button not found. Procore UI may have changed.
 *
 * The same selector found 10 elements the moment the password was fixed, so the UI had not
 * changed at all. The run had already logged "Already on Bid Board dashboard, skipping login"
 * while sitting on a sign-in form.
 */

const logMock = vi.hoisted(() => vi.fn());
const getPageMock = vi.hoisted(() => vi.fn());
const clearSessionMock = vi.hoisted(() => vi.fn(async () => {}));
const closeBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const getAutomationConfigMock = vi.hoisted(() => vi.fn(async (_key: string) => null as any));
const recordLoginOutcomeMock = vi.hoisted(() => vi.fn(async () => ({ action: "none" as const })));

vi.mock("../server/index.ts", () => ({ log: logMock }));
vi.mock("../server/db.ts", () => ({ db: {}, pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true, provider: "gmail" })) }));
vi.mock("../server/storage.ts", () => ({ storage: { getAutomationConfig: getAutomationConfigMock } }));
vi.mock("../server/playwright/browser.ts", () => ({
  getPage: getPageMock,
  saveSession: vi.fn(async () => {}),
  clearSession: clearSessionMock,
  closeBrowser: closeBrowserMock,
  withRetry: vi.fn(),
  randomDelay: vi.fn(async () => {}),
  takeScreenshot: vi.fn(async () => "/tmp/shot.png"),
  waitForNavigation: vi.fn(),
  withBrowserLock: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
// The auth module fires the ops alert; stub the alert module so these tests never touch a DB or a
// transport. The dedupe behaviour itself is exercised against the real module further down.
vi.mock("../server/sync/procore-login-alert.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/sync/procore-login-alert")>()),
  recordLoginOutcomeAndMaybeAlert: recordLoginOutcomeMock,
}));

const { detectPageAuthState, describeSelectorMiss, encryptPassword, ensureLoggedIn, isProcoreLoginUrl } =
  await import("../server/playwright/auth.ts");

// ── Page fakes ───────────────────────────────────────────────────────────────

/** A fake page whose `$` resolves for any selector matching one of `present`. */
function fakePage(url: string, present: RegExp[]) {
  return {
    url: () => url,
    $: vi.fn(async (selector: string) => (present.some((re) => re.test(selector)) ? { handle: selector } : null)),
    waitForTimeout: vi.fn(async () => {}),
    goto: vi.fn(async () => {}),
  };
}

/** Procore serves the sign-in screen on a URL that still names the page we asked for — which is how
 *  a URL-shape check ("does it contain /tools/bid-board?") concluded we were on the dashboard. */
const LOGIN_URL_CARRYING_TARGET =
  "https://login.procore.com/?redirect=/webclients/host/companies/1234/tools/bid-board";
const BID_BOARD_URL = "https://us02.procore.com/webclients/host/companies/1234/tools/bid-board";

/** The sign-in screen: a password box, plus the generic chrome that the old URL/nav heuristics
 *  happily mistook for an application shell. */
const loginPage = (url = LOGIN_URL_CARRYING_TARGET) =>
  fakePage(url, [/password/i, /nav/, /class\*="header"/, /#user_email/]);

/** A genuinely authenticated Bid Board page (the SPA shell is mounted). */
const authenticatedBidBoardPage = () => fakePage(BID_BOARD_URL, [/spaContent/, /nav/]);

// ── 1. A login-page DOM is never "authenticated" ─────────────────────────────

describe("isProcoreLoginUrl (pure)", () => {
  it("recognises the sign-in host even when the redirect query still names the Bid Board page", () => {
    expect(isProcoreLoginUrl(LOGIN_URL_CARRYING_TARGET)).toBe(true);
    expect(isProcoreLoginUrl("https://login-sandbox.procore.com/")).toBe(true);
  });

  it("does not treat the real Bid Board URL as a sign-in page", () => {
    expect(isProcoreLoginUrl(BID_BOARD_URL)).toBe(false);
    expect(isProcoreLoginUrl("https://us02.procore.com/webclients/host/companies/1234/projects/9")).toBe(false);
  });
});

describe("detectPageAuthState", () => {
  it("does NOT call a sign-in page authenticated, even though it has nav/header chrome", async () => {
    const state = await detectPageAuthState(loginPage());
    expect(state.authenticated).toBe(false);
    expect(state.loginPage).toBe(true);
    expect(state.evidence).toMatch(/password|sign-in/i);
  });

  it("does NOT call a sign-in page authenticated when it is served on the target page's own URL", async () => {
    // Same DOM, but the URL is the Bid Board URL itself — only the password field gives it away.
    const state = await detectPageAuthState(fakePage(BID_BOARD_URL, [/password/i, /nav/]));
    expect(state.authenticated).toBe(false);
    expect(state.loginPage).toBe(true);
  });

  it("does NOT call the two-step login's email step authenticated (no password field to give it away)", async () => {
    const emailStep = fakePage(LOGIN_URL_CARRYING_TARGET, [/nav/, /class\*="company"/]);
    const state = await detectPageAuthState(emailStep);
    expect(state.authenticated).toBe(false);
    expect(state.loginPage).toBe(true);
  });

  it("does NOT call a sign-in form on an app URL authenticated just because it has a nav bar", async () => {
    // No password field and no sign-in host — only the form itself gives it away, and a nav bar is
    // not allowed to outrank it.
    const inlineSignIn = fakePage(BID_BOARD_URL, [/#user_email/, /nav/, /class\*="company"/]);
    const state = await detectPageAuthState(inlineSignIn);
    expect(state.authenticated).toBe(false);
    expect(state.loginPage).toBe(true);
  });

  it("lets a real session marker outrank an email field on the same page", async () => {
    const appPageWithEmailField = fakePage(BID_BOARD_URL, [/spaContent/, /#user_email/]);
    const state = await detectPageAuthState(appPageWithEmailField);
    expect(state.authenticated).toBe(true);
    expect(state.loginPage).toBe(false);
  });

  it("reports an authenticated page as authenticated (the happy path still works)", async () => {
    const state = await detectPageAuthState(authenticatedBidBoardPage());
    expect(state.authenticated).toBe(true);
    expect(state.loginPage).toBe(false);
  });

  it("never reports authenticated when the page probe throws (a dead page proves nothing)", async () => {
    const broken = {
      url: () => BID_BOARD_URL,
      $: vi.fn(async () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    };
    const state = await detectPageAuthState(broken);
    expect(state.authenticated).toBe(false);
  });
});

// ── 2. Failure attribution: sign-in vs DOM drift ─────────────────────────────

describe("describeSelectorMiss", () => {
  it("blames the sign-in — NOT a UI change — when the page is a login form", async () => {
    const err = await describeSelectorMiss(loginPage(), "Export menu button");
    expect(err.message).not.toContain("Procore UI may have changed");
    expect(err.message).toMatch(/sign(ed)?[ -]?out|sign-in failure/i);
  });

  it("names the remediation nobody guesses: the password lives in SyncHub, not Procore", async () => {
    const err = await describeSelectorMiss(loginPage(), "Export menu button");
    expect(err.message).toContain("automation_config.procore_browser_credentials");
    expect(err.message).toMatch(/does NOT propagate/i);
  });

  it("STILL reports a possible UI change when an authenticated page's selectors genuinely miss", async () => {
    const err = await describeSelectorMiss(authenticatedBidBoardPage(), "Export menu button");
    expect(err.message).toBe("Export menu button not found. Procore UI may have changed.");
  });

  it("does not claim a UI change when the session simply cannot be confirmed", async () => {
    const bare = fakePage("https://us02.procore.com/webclients/host/companies/1234/tools/bid-board", []);
    const err = await describeSelectorMiss(bare, "Export menu button");
    expect(err.message).not.toContain("Procore UI may have changed");
    expect(err.message).toMatch(/cannot confirm a Procore session/i);
  });
});

// ── 3. ensureLoggedIn no longer mistakes a stale session for a live one ──────

describe("ensureLoggedIn — target-URL fast path", () => {
  beforeEach(() => {
    logMock.mockClear();
    clearSessionMock.mockClear();
    recordLoginOutcomeMock.mockClear();
    getAutomationConfigMock.mockReset();
    getAutomationConfigMock.mockResolvedValue(null); // no stored credentials → stop before a real login
  });

  it("refuses to skip login when the target URL serves a sign-in screen", async () => {
    getPageMock.mockResolvedValue(loginPage());

    const res = await ensureLoggedIn({ targetUrl: BID_BOARD_URL });

    expect(res.success).toBe(false);
    const lines = logMock.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /skipping login/i.test(l))).toBe(false);
    expect(lines.some((l) => /NOT authenticated/i.test(l))).toBe(true);
    // A stale session must be cleared so the next attempt is a real login, not a selector hunt.
    expect(clearSessionMock).toHaveBeenCalled();
  });

  it("refuses to skip login when the sign-in screen is served on the Bid Board URL itself", async () => {
    getPageMock.mockResolvedValue(loginPage(BID_BOARD_URL));

    const res = await ensureLoggedIn({ targetUrl: BID_BOARD_URL });

    expect(res.success).toBe(false);
    expect(logMock.mock.calls.map((c) => String(c[0])).some((l) => /skipping login/i.test(l))).toBe(false);
  });

  it("still skips the login when the target page really is authenticated", async () => {
    getPageMock.mockResolvedValue(authenticatedBidBoardPage());

    const res = await ensureLoggedIn({ targetUrl: BID_BOARD_URL });

    expect(res.success).toBe(true);
    expect(logMock.mock.calls.map((c) => String(c[0])).some((l) => /skipping login/i.test(l))).toBe(true);
    // The healthy fast path must still report the success, or a resolved outage never sends its
    // recovery email (this is the path every healthy Bid Board sync takes).
    expect(recordLoginOutcomeMock.mock.calls.at(-1)![0]).toMatchObject({ outcome: { ok: true } });
  });

  it("reports a structured reason and alerts when no credentials are stored", async () => {
    getPageMock.mockResolvedValue(loginPage());

    const res = await ensureLoggedIn({ targetUrl: BID_BOARD_URL });

    expect(res.reason).toBe("not_configured");
    expect(recordLoginOutcomeMock).toHaveBeenCalled();
    expect(recordLoginOutcomeMock.mock.calls.at(-1)![0]).toMatchObject({
      outcome: { ok: false, reason: "not_configured" },
    });
  });
});

// ── 3b. A real credential rejection, end to end ─────────────────────────────

describe("ensureLoggedIn — Procore rejects the stored password", () => {
  const PROCORE_REJECTION = "The email address or password you entered is not valid.";

  /** A fake that walks Procore's two-step login and then shows the rejection banner. */
  function rejectingLoginPage() {
    let url = "https://login.procore.com/";
    const handle = { fill: vi.fn(async () => {}), click: vi.fn(async () => {}) };
    return {
      url: () => url,
      goto: vi.fn(async (to: string) => {
        url = to;
      }),
      waitForTimeout: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => handle),
      $: vi.fn(async (selector: string) => {
        if (/otp|inputmode="numeric"|mfa/.test(selector)) return null; // no MFA prompt
        if (/alert-danger|role="alert"/.test(selector)) {
          return { textContent: async () => PROCORE_REJECTION };
        }
        if (/password/i.test(selector)) return handle;
        return null;
      }),
    };
  }

  it("returns a credentials_rejected login error and alerts with Procore's own words", async () => {
    const prevKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "unit-test-key-not-a-secret";
    vi.useFakeTimers();
    try {
      logMock.mockClear();
      recordLoginOutcomeMock.mockClear();
      getPageMock.mockResolvedValue(rejectingLoginPage());
      getAutomationConfigMock.mockResolvedValue({
        // A throwaway value purely so decryptPassword() succeeds; not a credential.
        value: { email: "automation@example.invalid", encryptedPassword: encryptPassword("x"), sandbox: false },
      });

      const pending = ensureLoggedIn({ blocking: "Bid Board project creation" });
      await vi.runAllTimersAsync(); // skip the 3s/6s inter-attempt backoff
      const res = await pending;

      expect(res.success).toBe(false);
      expect(res.reason).toBe("credentials_rejected");
      expect(res.error).toContain(PROCORE_REJECTION);
      // Nothing anywhere claims the UI moved.
      expect(logMock.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/UI may have changed/i);
      expect(recordLoginOutcomeMock.mock.calls.at(-1)![0]).toMatchObject({
        outcome: {
          ok: false,
          reason: "credentials_rejected",
          attempts: 3,
          blocking: "Bid Board project creation",
        },
      });
    } finally {
      vi.useRealTimers();
      if (prevKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = prevKey;
    }
  });
});

// ── 4. The export RPA reports the right cause to its caller ─────────────────

describe("exportBidBoardProjectList — error attribution", () => {
  async function runExportWith(page: any) {
    vi.resetModules();
    vi.doMock("fs/promises", () => ({
      mkdir: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      rename: vi.fn(async () => {}),
      access: vi.fn(async () => {}),
      default: {},
    }));
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

  it("blames the Procore sign-in, not the Procore UI, when the menu is missing from a login page", async () => {
    await expect(
      runExportWith(pageWithNoMenu(LOGIN_URL_CARRYING_TARGET, [/password/i, /nav/]))
    ).rejects.toThrow(/sign-in failure/i);
  });

  it("keeps the UI-change error for an authenticated page whose menu selectors genuinely miss", async () => {
    await expect(runExportWith(pageWithNoMenu(BID_BOARD_URL, [/spaContent/, /nav/]))).rejects.toThrow(
      "Export menu button not found. Procore UI may have changed."
    );
  });
});

// ── 5. The Bid Board project-creation path stops trusting the URL too ───────

describe("navigateToBidBoard — the other half of the outage (project creation)", () => {
  /** Every content marker misses; the reload changes nothing. All that is left is the URL. */
  function stuckPage(url: string, present: RegExp[]) {
    return {
      ...fakePage(url, present),
      waitForSelector: vi.fn(async () => {
        throw new Error("Timeout 15000ms exceeded");
      }),
      reload: vi.fn(async () => {}),
    };
  }

  async function navigateWith(page: any) {
    vi.resetModules();
    getAutomationConfigMock.mockImplementation(async (key: string) =>
      key === "procore_config" ? { value: { companyId: "1234" } } : { value: { sandbox: false } }
    );
    const { navigateToBidBoard } = await import("../server/playwright/bidboard.ts");
    return navigateToBidBoard(page as any);
  }

  it("does NOT report the Bid Board as loaded when the URL serves a sign-in screen", async () => {
    expect(await navigateWith(stuckPage(BID_BOARD_URL, [/password/i]))).toBe(false);
  });

  it("keeps the URL as a last resort for a page that is merely marker-less, not signed out", async () => {
    expect(await navigateWith(stuckPage(BID_BOARD_URL, []))).toBe(true);
  });
});

// ── 6. The alert fires once per incident, not once per 19-minute cycle ──────

describe("recordLoginOutcomeAndMaybeAlert — dedupe", () => {
  const NOW = new Date("2026-08-03T14:00:00Z");
  const MIN = 60_000;
  let send: ReturnType<typeof vi.fn>;

  /** In-memory stand-in for procore_login_alert_state. */
  function fakeDb() {
    const store = new Map<string, any>();
    return {
      store,
      query: vi.fn(async (text: string, params?: any[]) => {
        const t = text.toLowerCase();
        if (t.includes("select") && t.includes("procore_login_alert_state")) {
          const row = store.get(params![0]);
          return { rows: row ? [row] : [] };
        }
        if (t.includes("insert into") && t.includes("procore_login_alert_state")) {
          const [scope, state, last_reason, last_alerted_at, last_success_at, last_error, updated_at] = params!;
          store.set(scope, { scope, state, last_reason, last_alerted_at, last_success_at, last_error, updated_at });
        }
        return { rows: [] };
      }),
    };
  }

  let record: typeof import("../server/sync/procore-login-alert")["recordLoginOutcomeAndMaybeAlert"];

  beforeEach(async () => {
    send = vi.fn(async () => ({ success: true, provider: "gmail" }));
    // The real module — the auth-level stub above must not shadow the behaviour under test.
    ({ recordLoginOutcomeAndMaybeAlert: record } = await vi.importActual<
      typeof import("../server/sync/procore-login-alert")
    >("../server/sync/procore-login-alert.ts"));
  });

  const run = (db: any, outcome: any, now: Date) =>
    record({ outcome, now, realertMinutes: 60, recipient: "ops@trock.test" }, { db, send });

  it("emails once on the first rejection and records 'failing'", async () => {
    const db = fakeDb();
    const res = await run(db, { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" }, NOW);
    expect(res.action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.store.get("procore-browser-login").state).toBe("failing");
  });

  it("does NOT email again for the identical failure on the next 19-minute cycles", async () => {
    const db = fakeDb();
    const fail = { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" };
    await run(db, fail, NOW);
    send.mockClear();
    for (const mins of [19, 38, 57]) {
      await run(db, fail, new Date(NOW.getTime() + mins * MIN));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("re-alerts once the window elapses", async () => {
    const db = fakeDb();
    const fail = { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" };
    await run(db, fail, NOW);
    send.mockClear();
    await run(db, fail, new Date(NOW.getTime() + 76 * MIN));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats a DIFFERENT failure as a new incident, not a throttled repeat", async () => {
    const db = fakeDb();
    await run(db, { ok: false, reason: "credentials_rejected", attempts: 3, error: "not valid" }, NOW);
    send.mockClear();
    const res = await run(db, { ok: false, reason: "mfa_required", attempts: 3 }, new Date(NOW.getTime() + 19 * MIN));
    expect(res.action).toBe("alert_failure");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends one recovery email when sign-in works again, then goes quiet", async () => {
    const db = fakeDb();
    await run(db, { ok: false, reason: "credentials_rejected", attempts: 3 }, NOW);
    send.mockClear();
    const recovered = await run(db, { ok: true }, new Date(NOW.getTime() + 30 * MIN));
    expect(recovered.action).toBe("alert_recovered");
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    await run(db, { ok: true }, new Date(NOW.getTime() + 49 * MIN));
    expect(send).not.toHaveBeenCalled();
  });

  it("carries the remediation and the cause, and never the account or its password", async () => {
    const db = fakeDb();
    await run(
      db,
      { ok: false, reason: "credentials_rejected", attempts: 3, error: "The email address or password you entered is not valid." },
      NOW
    );
    const email = send.mock.calls[0][0];
    expect(email.subject.toLowerCase()).toMatch(/sign-in failed/);
    expect(email.htmlBody).toContain("automation_config.procore_browser_credentials");
    expect(email.htmlBody).toContain("The email address or password you entered is not valid.");
    expect(email.bypassGlobalCc).toBe(true);
  });

  it("is inert when no recipient is configured, and never throws into the automation", async () => {
    const db = fakeDb();
    const prev = process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    try {
      const res = await record({ outcome: { ok: false, reason: "credentials_rejected" }, now: NOW }, { db, send });
      expect(send).not.toHaveBeenCalled();
      expect(db.store.size).toBe(0);
      expect(res.action).toBe("none");
    } finally {
      if (prev !== undefined) process.env.BIDBOARD_CRM_ALERT_RECIPIENT = prev;
    }
  });

  it("a healthy login while already ok writes nothing (ensureLoggedIn runs on every automation)", async () => {
    const db = fakeDb();
    db.query.mockClear();
    await run(db, { ok: true }, NOW);
    const writes = db.query.mock.calls.filter((c) => String(c[0]).toLowerCase().includes("insert into"));
    expect(writes).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a DB failure does NOT throw into the automation run", async () => {
    const db = { query: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(run(db, { ok: false, reason: "credentials_rejected" }, NOW)).resolves.toEqual({ action: "none" });
  });
});
