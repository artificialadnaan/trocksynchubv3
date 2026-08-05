/**
 * Playwright Authentication Module
 * =================================
 *
 * This module handles browser-based authentication to Procore.
 * It manages credentials securely and maintains login sessions.
 *
 * Why Browser Authentication?
 * Some Procore features (BidBoard, Portfolio transitions) require
 * browser automation because they don't have complete API coverage.
 * This module handles logging in and maintaining authenticated sessions.
 *
 * Security Features:
 * - Passwords encrypted at rest using AES-256-GCM
 * - Encryption key derived from ENCRYPTION_KEY env var (falls back to SESSION_SECRET)
 * - Session cookies saved to avoid repeated logins
 * - Sessions expire and re-authenticate as needed
 *
 * Login Flow:
 * 1. Check for existing valid session
 * 2. If no session, decrypt stored credentials
 * 3. Navigate to Procore login page
 * 4. Enter email, wait for password field
 * 5. Enter password, click sign in
 * 6. Handle any 2FA or security prompts
 * 7. Save session cookies for reuse
 *
 * Key Functions:
 * - loginToProcore(): Main login function
 * - ensureLoggedIn(): Ensures valid session, re-logs if needed
 * - saveProcoreCredentials(): Securely stores credentials
 * - testLogin(): Validates credentials without saving
 * - encryptPassword()/decryptPassword(): Credential encryption
 *
 * Environment Variables Required:
 * - ENCRYPTION_KEY: Used to derive encryption key for credentials (preferred)
 * - SESSION_SECRET: Fallback if ENCRYPTION_KEY is not set (backwards compatibility)
 *
 * @module playwright/auth
 */

import { Page } from "playwright";
import { getPage, saveSession, clearSession, closeBrowser, withRetry, randomDelay, takeScreenshot } from "./browser";
import { PROCORE_SELECTORS, PROCORE_URLS } from "./selectors";
import { log } from "../index";
import { storage } from "../storage";
import {
  PROCORE_CREDENTIAL_REMEDIATION,
  recordLoginOutcomeAndMaybeAlert,
  type LoginFailureReason,
} from "../sync/procore-login-alert";
import crypto from "crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

interface ProcoreCredentials {
  email: string;
  password: string;
  sandbox?: boolean;
}

interface LoginResult {
  success: boolean;
  error?: string;
  /** Structured cause, set at each failure site. Never parsed back out of `error` — a re-worded
   *  message must not be able to reclassify an outage. */
  reason?: LoginFailureReason;
  screenshotPath?: string;
}

export type { LoginFailureReason };
export { PROCORE_CREDENTIAL_REMEDIATION };

function getEncryptionSecret(): string {
  const key = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!key) {
    throw new Error("ENCRYPTION_KEY or SESSION_SECRET environment variable is required for credential encryption");
  }
  return key;
}

// Backwards-compatible alias
function getSessionSecret(): string {
  return getEncryptionSecret();
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

export function encryptPassword(password: string): string {
  const secret = getEncryptionSecret();
  const salt = crypto.randomBytes(16);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return `${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptPassword(encryptedData: string): string {
  const parts = encryptedData.split(":");
  const secret = getEncryptionSecret();

  // Support both old format (iv:authTag:encrypted) and new format (salt:iv:authTag:encrypted)
  let salt: Buffer, iv: Buffer, authTag: Buffer, encrypted: string;
  if (parts.length === 4) {
    // New format with random salt
    salt = Buffer.from(parts[0], "hex");
    iv = Buffer.from(parts[1], "hex");
    authTag = Buffer.from(parts[2], "hex");
    encrypted = parts[3];
  } else if (parts.length === 3) {
    // Legacy format with hardcoded salt — backward compatibility
    salt = Buffer.from("salt");
    iv = Buffer.from(parts[0], "hex");
    authTag = Buffer.from(parts[1], "hex");
    encrypted = parts[2];
  } else {
    throw new Error("Invalid encrypted data format");
  }

  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export async function getProcoreCredentials(): Promise<ProcoreCredentials | null> {
  const config = await storage.getAutomationConfig("procore_browser_credentials");

  if (!config?.value) {
    return null;
  }

  const { email, encryptedPassword, sandbox } = config.value as {
    email: string;
    encryptedPassword: string;
    sandbox?: boolean;
  };

  try {
    const password = decryptPassword(encryptedPassword);
    return { email, password, sandbox };
  } catch (error) {
    log(`Failed to decrypt Procore credentials: ${error}`, "playwright");
    return null;
  }
}

export async function saveProcoreCredentials(
  email: string,
  password: string,
  sandbox: boolean = false
): Promise<void> {
  const encryptedPassword = encryptPassword(password);

  await storage.upsertAutomationConfig({
    key: "procore_browser_credentials",
    value: {
      email,
      encryptedPassword,
      sandbox,
    },
    description: "Procore browser automation credentials (encrypted)",
  });

  log("Procore browser credentials saved", "playwright");
}

// ── Authentication proof ──────────────────────────────────────────────────────
//
// A URL is NOT proof of a session. Procore serves its sign-in screen at URLs that still carry the
// page you asked for (`https://login.procore.com/?redirect=/.../tools/bid-board`), so a URL-shape
// check reports "logged in" while the browser stares at a password box. That is what produced
// "Already on Bid Board dashboard, skipping login" during the 2026-08-03 outage, and turned an
// expired password into a fruitless selector hunt misreported as a Procore UI change.
//
// Everything below asserts against the DOM, in a fixed order of evidence.

/** Minimal structural view of a Playwright Page — lets the probes be unit-tested with plain fakes.
 *  `$` resolves to an element handle or null; only its truthiness is used here. */
export interface AuthProbePage {
  url(): string;
  $(selector: string): Promise<unknown>;
}

const LOGIN_HOST_RE = /(^|\.)login(-sandbox)?\.procore\.com$/i;
const LOGIN_PATH_RE = /(^|\/)(login|signin|sign_in|sessions\/new|users\/sign_in)(\/|$)/i;

/** True when the URL is a Procore SIGN-IN url — host-based, so a `?redirect=` query that still
 *  mentions the target page can no longer be mistaken for the target page itself. */
export function isProcoreLoginUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (LOGIN_HOST_RE.test(u.hostname)) return true;
    return LOGIN_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/** Unambiguous "this is the sign-in screen" DOM. Checked BEFORE any positive marker. */
const LOGIN_DOM_PROOF = PROCORE_SELECTORS.login.passwordInput;

/** Weaker sign-in evidence — only consulted after the authenticated markers have all missed, so a
 *  real app page that happens to contain an email field is not misread as a login screen. */
const LOGIN_DOM_HINTS = 'form[action*="login"], form[action*="session"], form[action*="sign_in"], #user_email';

/** Elements that only exist once a session is established. Ordered strongest-first. */
const AUTHENTICATED_DOM_MARKERS: { name: string; selector: string }[] = [
  { name: "user-menu", selector: PROCORE_SELECTORS.nav.userMenu },
  { name: "bid-board-app-shell", selector: PROCORE_SELECTORS.bidboard.newUi.app },
  { name: "app-navigation", selector: 'nav, [class*="navigation"], [class*="sidebar"]' },
  { name: "project-or-company-chrome", selector: '[class*="project"], [class*="company"]' },
];

export interface PageAuthState {
  /** True only when an authenticated-session-only element was actually found in the DOM. */
  authenticated: boolean;
  /** True when the page is a Procore sign-in screen. Mutually exclusive with `authenticated`. */
  loginPage: boolean;
  /** Short, log-safe description of what decided the verdict. Contains no credential material. */
  evidence: string;
  url: string;
}

/**
 * Decide whether a page is authenticated, from the DOM. Order of evidence:
 *  1. a password field, or a sign-in URL  → login page, NOT authenticated (hard stop)
 *  2. an authenticated-only element       → authenticated
 *  3. weaker login-form evidence          → login page, NOT authenticated
 *  4. otherwise                           → not authenticated, not a recognisable login page
 */
export async function detectPageAuthState(page: AuthProbePage): Promise<PageAuthState> {
  let url = "";
  try {
    url = page.url();
  } catch {
    return { authenticated: false, loginPage: false, evidence: "page url unavailable", url: "" };
  }

  try {
    if (await page.$(LOGIN_DOM_PROOF)) {
      return { authenticated: false, loginPage: true, evidence: "a password field is present", url };
    }
    if (isProcoreLoginUrl(url)) {
      return { authenticated: false, loginPage: true, evidence: "the page is on a Procore sign-in URL", url };
    }

    for (const marker of AUTHENTICATED_DOM_MARKERS) {
      if (await page.$(marker.selector)) {
        return { authenticated: true, loginPage: false, evidence: `authenticated marker '${marker.name}' found`, url };
      }
    }

    if (await page.$(LOGIN_DOM_HINTS)) {
      return { authenticated: false, loginPage: true, evidence: "a sign-in form is present", url };
    }

    return {
      authenticated: false,
      loginPage: false,
      evidence: "no authenticated-session element found on the page",
      url,
    };
  } catch (err) {
    // A closed/crashed page proves nothing — never report it as authenticated.
    return {
      authenticated: false,
      loginPage: false,
      evidence: `auth probe failed: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }
}

/**
 * Build the honest error for "we looked for a selector and found nothing". Only an AUTHENTICATED
 * page may blame a Procore UI change; an unauthenticated one names the sign-in failure and the
 * remediation. Getting this backwards is what cost 73 minutes on 2026-08-03.
 */
export async function describeSelectorMiss(page: AuthProbePage, subject: string): Promise<Error> {
  const state = await detectPageAuthState(page);
  if (state.authenticated) {
    return new Error(`${subject} not found. Procore UI may have changed.`);
  }
  const what = state.loginPage ? "SyncHub is signed OUT of Procore" : "SyncHub cannot confirm a Procore session";
  return new Error(
    `${subject} not found because ${what} (${state.evidence}) — this is a Procore sign-in failure, ` +
      `NOT a Procore UI change. ${PROCORE_CREDENTIAL_REMEDIATION}`
  );
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const state = await detectPageAuthState(page);
  if (state.authenticated) {
    log(`Logged in — ${state.evidence} (${state.url})`, "playwright");
  }
  return state.authenticated;
}

async function performLogin(page: Page, credentials: ProcoreCredentials): Promise<LoginResult> {
  const loginUrl = credentials.sandbox ? PROCORE_URLS.loginSandbox : PROCORE_URLS.login;

  log(`Navigating to Procore login: ${loginUrl}`, "playwright");
  // Use 'load' instead of 'networkidle' — Procore's login page has persistent connections
  // (analytics, SSO polling) that prevent networkidle from ever firing
  await page.goto(loginUrl, { waitUntil: "load" });

  await randomDelay(1000, 2000);

  // STEP 1: Enter email
  log("Step 1: Entering email", "playwright");
  const emailInput = await page.waitForSelector(PROCORE_SELECTORS.login.emailInput, { timeout: 15000 });
  await emailInput.fill(credentials.email);

  await randomDelay(500, 1000);

  // Check if password field is already visible (old login flow)
  let passwordVisible = await page.$(PROCORE_SELECTORS.login.passwordInput);

  if (!passwordVisible) {
    // Two-step login: Click Continue button to proceed to password step
    log("Clicking Continue to proceed to password step", "playwright");
    try {
      // Try to find and click Continue/Next button
      const continueButton = await page.waitForSelector(PROCORE_SELECTORS.login.continueButton, { timeout: 5000 });
      await continueButton.click();

      // Wait for password field to appear
      log("Waiting for password field...", "playwright");
      await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 15000, state: "visible" });
    } catch (e) {
      // Maybe there's a submit button instead
      log("Trying submit button for email step", "playwright");
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 15000, state: "visible" });
      } else {
        const screenshotPath = await takeScreenshot(page, "login-no-continue-button");
        return {
          success: false,
          error: "Could not find Continue button or password field",
          reason: "login_form_unrecognized",
          screenshotPath,
        };
      }
    }
  }

  await randomDelay(500, 1000);

  // STEP 2: Enter password
  log("Step 2: Entering password", "playwright");
  const passwordInput = await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 10000 });
  await passwordInput.fill(credentials.password);

  await randomDelay(500, 1000);

  // Click Sign In / Submit
  log("Clicking Sign In", "playwright");
  const submitButton = await page.waitForSelector(PROCORE_SELECTORS.login.submitButton, { timeout: 10000 });
  await submitButton.click();

  // Wait for navigation - Procore may do multiple redirects
  log("Waiting for login to complete...", "playwright");

  // Give the page time to redirect
  await page.waitForTimeout(3000);

  // Check URL to see if we've left the login page
  const postLoginUrl = page.url();
  log(`Post-login URL: ${postLoginUrl}`, "playwright");

  // If still on login page, wait for navigation or error
  if (postLoginUrl.includes("login")) {
    try {
      await Promise.race([
        page.waitForURL(/procore\.com(?!.*login)/, { timeout: 30000 }),
        page.waitForSelector(PROCORE_SELECTORS.login.errorMessage, { timeout: 30000 }),
        page.waitForSelector(PROCORE_SELECTORS.login.mfaInput, { timeout: 30000 }),
      ]);
    } catch (error) {
      // Check if we actually navigated away from login
      const currentUrl = page.url();
      if (!currentUrl.includes("login")) {
        log(`Navigation detected to: ${currentUrl}`, "playwright");
      } else {
        const screenshotPath = await takeScreenshot(page, "login-timeout");
        return {
          success: false,
          error: "Login timed out after submitting credentials",
          reason: "timeout",
          screenshotPath,
        };
      }
    }
  }

  // Wait a bit more for page to stabilize after redirects
  await page.waitForTimeout(2000);

  // Check for MFA
  const mfaInput = await page.$(PROCORE_SELECTORS.login.mfaInput);
  if (mfaInput) {
    const screenshotPath = await takeScreenshot(page, "mfa-required");
    return {
      success: false,
      error: "MFA required - please configure MFA handling or use an account without MFA",
      reason: "mfa_required",
      screenshotPath,
    };
  }

  // Check for error message (only if still on login page)
  const currentUrl = page.url();
  if (currentUrl.includes("login")) {
    const errorElement = await page.$(PROCORE_SELECTORS.login.errorMessage);
    if (errorElement) {
      const errorText = await errorElement.textContent();
      const screenshotPath = await takeScreenshot(page, "login-error");
      return {
        success: false,
        error: `Login failed: ${errorText}`,
        reason: "credentials_rejected",
        screenshotPath,
      };
    }
  }

  // Verify we're logged in
  if (await isLoggedIn(page)) {
    await saveSession();
    log("Successfully logged into Procore", "playwright");
    return { success: true };
  }

  // No authenticated marker, but we did submit credentials, saw no rejection, and are off the
  // sign-in host — accept it, while logging that the session is UNVERIFIED so a later selector miss
  // can be read in context. (Host-based, not `includes("login")`: a redirect query string that
  // mentions the word must not decide this either way.)
  if (!isProcoreLoginUrl(currentUrl) && currentUrl.includes("procore.com")) {
    await saveSession();
    log(`Login accepted but UNVERIFIED (no authenticated marker) - on URL: ${currentUrl}`, "playwright");
    return { success: true };
  }

  const screenshotPath = await takeScreenshot(page, "login-unknown-state");
  return {
    success: false,
    error: `Unknown login state. Current URL: ${currentUrl}`,
    reason: "unknown",
    screenshotPath,
  };
}

export async function ensureLoggedIn(
  options?: { targetUrl?: string; blocking?: string }
): Promise<{ page: Page; success: boolean; error?: string; reason?: LoginFailureReason }> {
  let page = await getPage();

  // If targetUrl provided, try navigating there first — we may already be logged in.
  // The verdict comes from the DOM, never from the URL: Procore's sign-in screen can be served on a
  // URL that still names the page we asked for, which is exactly how a dead password used to log
  // "Already on Bid Board dashboard, skipping login" and then hunt for menu selectors on a login form.
  if (options?.targetUrl) {
    try {
      await page.goto(options.targetUrl, { waitUntil: "load", timeout: 60000 });
      await page.waitForTimeout(2000);
      const state = await detectPageAuthState(page);
      if (state.authenticated) {
        log(`Already authenticated on the target page — ${state.evidence}, skipping login`, "playwright");
        // Record the success here too: this is the path a healthy Bid Board sync takes every cycle,
        // so without it a resolved outage would never send its recovery email.
        await recordLoginOutcome({ ok: true }, options?.blocking);
        return { page, success: true };
      }
      log(`Target page is NOT authenticated — ${state.evidence} (${state.url})`, "playwright");
      if (state.loginPage) {
        log("Sign-in screen served for the target page (stale session), clearing session for fresh login", "playwright");
        await clearSession();
        await closeBrowser();
        page = await getPage();
      }
    } catch (e) {
      log(`Target URL check failed: ${(e as Error).message}`, "playwright");
    }
  }

  // Check if already logged in
  if (await isLoggedIn(page)) {
    log("Already logged into Procore", "playwright");
    await recordLoginOutcome({ ok: true }, options?.blocking);
    return { page, success: true };
  }

  // On a sign-in screen with a stale session — clear and get a fresh context
  if (isProcoreLoginUrl(page.url())) {
    log("On login page, clearing stale session for fresh login", "playwright");
    await clearSession();
    await closeBrowser();
    page = await getPage();
  }

  // Get credentials
  const credentials = await getProcoreCredentials();
  if (!credentials) {
    const error = "Procore browser credentials not configured. Please save credentials in Settings.";
    await recordLoginOutcome({ ok: false, reason: "not_configured", attempts: 0, error }, options?.blocking);
    return { page, success: false, error, reason: "not_configured" };
  }

  // Perform login with retry — get a fresh browser context on each attempt
  // to avoid stale page state (CAPTCHA, pre-filled forms, rate limits)
  let result: LoginResult = { success: false, error: 'Login not attempted', reason: "unknown" };
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    try {
      result = await performLogin(page, credentials);
    } catch (loginErr: any) {
      result = { success: false, error: loginErr.message || String(loginErr), reason: "unknown" };
    }
    if (result.success) break;

    log(`Attempt ${attempt}/3 failed: ${result.error}`, "playwright");
    try { await takeScreenshot(page, `login-failed-attempt-${attempt}`); } catch { /* page may be closed */ }

    if (attempt < 3) {
      // Fresh browser context for next attempt
      await clearSession();
      await closeBrowser();
      await new Promise((r) => setTimeout(r, 3000 * attempt)); // Increasing delay between attempts
      page = await getPage();
    }
  }

  // Alert on the rejection itself rather than waiting an hour for the CRM-side absence-of-success
  // check. Debounced per failure signature, so a 19-minute cycle does not send 3 emails an hour.
  await recordLoginOutcome(
    result.success
      ? { ok: true }
      : { ok: false, reason: result.reason ?? "unknown", attempts, error: result.error },
    options?.blocking
  );

  return {
    page,
    success: result.success,
    error: result.error,
    reason: result.success ? undefined : (result.reason ?? "unknown"),
  };
}

/** Alerting must never break an automation run: recordLoginOutcomeAndMaybeAlert already swallows its
 *  own errors, this is the belt-and-braces guard for anything it cannot (e.g. an import-time throw). */
async function recordLoginOutcome(
  outcome: { ok: boolean; reason?: LoginFailureReason; attempts?: number; error?: string },
  blocking?: string
): Promise<void> {
  try {
    await recordLoginOutcomeAndMaybeAlert({ outcome: { ...outcome, blocking } });
  } catch {
    /* no-op */
  }
}

export async function logout(): Promise<void> {
  const page = await getPage();

  // Click user menu and find logout
  try {
    const userMenu = await page.$(PROCORE_SELECTORS.nav.userMenu);
    if (userMenu) {
      await userMenu.click();
      await randomDelay(500, 1000);

      const logoutLink = await page.$('a:has-text("Log Out"), a:has-text("Sign Out")');
      if (logoutLink) {
        await logoutLink.click();
        await page.waitForURL(/login/, { timeout: 10000 });
      }
    }
  } catch (error) {
    log(`Logout error: ${error}`, "playwright");
  }

  await clearSession();
  log("Logged out of Procore", "playwright");
}

export async function testLogin(email: string, password: string, sandbox: boolean = false): Promise<LoginResult> {
  // Clear any existing session first (before getting page)
  await clearSession();

  // Now get a fresh page from a new context
  const page = await getPage();

  const result = await performLogin(page, { email, password, sandbox });

  if (result.success) {
    // Save credentials if login was successful
    await saveProcoreCredentials(email, password, sandbox);
  }

  return result;
}

/**
 * Login to Procore using an external Page object (for isolated browser instances)
 * Uses stored credentials from the database
 * Handles Procore's two-step login flow (email -> Continue -> password -> Sign In)
 */
export async function loginToProcore(page: Page): Promise<boolean> {
  const credentials = await getProcoreCredentials();
  if (!credentials) return false;
  try {
    const result = await performLogin(page, credentials);
    return result.success;
  } catch {
    return false;
  }
}
