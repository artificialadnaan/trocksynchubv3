import { Page } from "playwright";
import { getPage, saveSession, clearSession, withRetry, randomDelay, takeScreenshot } from "./browser";
import { PROCORE_SELECTORS, PROCORE_URLS } from "./selectors";
import { log } from "../index";
import { storage } from "../storage";
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
  screenshotPath?: string;
}

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || "default-secret-key-for-encryption";
  return crypto.scryptSync(secret, "salt", 32);
}

export function encryptPassword(password: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  
  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptPassword(encryptedData: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedData.split(":");
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  
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

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    
    // Check if we're on a logged-in page
    if (url.includes("app.procore.com") || url.includes("sandbox.procore.com")) {
      // Look for user menu or other logged-in indicators
      const userMenu = await page.$(PROCORE_SELECTORS.nav.userMenu);
      return userMenu !== null;
    }
    
    return false;
  } catch {
    return false;
  }
}

async function performLogin(page: Page, credentials: ProcoreCredentials): Promise<LoginResult> {
  const loginUrl = credentials.sandbox ? PROCORE_URLS.loginSandbox : PROCORE_URLS.login;
  
  log(`Navigating to Procore login: ${loginUrl}`, "playwright");
  await page.goto(loginUrl, { waitUntil: "networkidle" });
  
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
  
  // Wait for navigation or error
  try {
    await Promise.race([
      page.waitForURL(/app\.procore\.com|sandbox\.procore\.com|us02\.procore\.com/, { timeout: 30000 }),
      page.waitForSelector(PROCORE_SELECTORS.login.errorMessage, { timeout: 30000 }),
      page.waitForSelector(PROCORE_SELECTORS.login.mfaInput, { timeout: 30000 }),
    ]);
  } catch (error) {
    const screenshotPath = await takeScreenshot(page, "login-timeout");
    return {
      success: false,
      error: "Login timed out after submitting credentials",
      screenshotPath,
    };
  }
  
  // Check for MFA
  const mfaInput = await page.$(PROCORE_SELECTORS.login.mfaInput);
  if (mfaInput) {
    const screenshotPath = await takeScreenshot(page, "mfa-required");
    return {
      success: false,
      error: "MFA required - please configure MFA handling or use an account without MFA",
      screenshotPath,
    };
  }
  
  // Check for error message
  const errorElement = await page.$(PROCORE_SELECTORS.login.errorMessage);
  if (errorElement) {
    const errorText = await errorElement.textContent();
    const screenshotPath = await takeScreenshot(page, "login-error");
    return {
      success: false,
      error: `Login failed: ${errorText}`,
      screenshotPath,
    };
  }
  
  // Verify we're logged in
  if (await isLoggedIn(page)) {
    await saveSession();
    log("Successfully logged into Procore", "playwright");
    return { success: true };
  }
  
  const screenshotPath = await takeScreenshot(page, "login-unknown-state");
  return {
    success: false,
    error: "Unknown login state",
    screenshotPath,
  };
}

export async function ensureLoggedIn(): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = await getPage();
  
  // Check if already logged in
  if (await isLoggedIn(page)) {
    log("Already logged into Procore", "playwright");
    return { page, success: true };
  }
  
  // Get credentials
  const credentials = await getProcoreCredentials();
  if (!credentials) {
    return {
      page,
      success: false,
      error: "Procore browser credentials not configured. Please save credentials in Settings.",
    };
  }
  
  // Perform login with retry
  const result = await withRetry(
    () => performLogin(page, credentials),
    3,
    2000
  );
  
  return {
    page,
    success: result.success,
    error: result.error,
  };
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
  
  if (!credentials) {
    log("No Procore credentials configured", "playwright");
    return false;
  }
  
  const loginUrl = credentials.sandbox ? PROCORE_URLS.loginSandbox : PROCORE_URLS.login;
  
  try {
    log(`Navigating to Procore login: ${loginUrl}`, "playwright");
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    // Wait a moment for page to stabilize
    await page.waitForTimeout(1500);
    
    // STEP 1: Enter email
    log("Step 1: Entering email", "playwright");
    await page.waitForSelector(PROCORE_SELECTORS.login.emailInput, { timeout: 15000 });
    await page.fill(PROCORE_SELECTORS.login.emailInput, credentials.email);
    
    await page.waitForTimeout(500);
    
    // Check if password field is already visible (old login flow)
    let passwordVisible = await page.$(PROCORE_SELECTORS.login.passwordInput);
    
    if (!passwordVisible) {
      // Two-step login: Click Continue button
      log("Clicking Continue to proceed to password step", "playwright");
      try {
        const continueButton = await page.waitForSelector(PROCORE_SELECTORS.login.continueButton, { timeout: 5000 });
        await continueButton.click();
        
        // Wait for password field
        log("Waiting for password field...", "playwright");
        await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 15000, state: "visible" });
      } catch {
        // Try generic submit button
        log("Trying submit button for email step", "playwright");
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 15000, state: "visible" });
        } else {
          log("Could not find Continue button or password field", "playwright");
          return false;
        }
      }
    }
    
    await page.waitForTimeout(500);
    
    // STEP 2: Enter password
    log("Step 2: Entering password", "playwright");
    await page.waitForSelector(PROCORE_SELECTORS.login.passwordInput, { timeout: 10000 });
    await page.fill(PROCORE_SELECTORS.login.passwordInput, credentials.password);
    
    await page.waitForTimeout(500);
    
    // Click Sign In
    log("Clicking Sign In", "playwright");
    await page.click(PROCORE_SELECTORS.login.submitButton);
    
    // Wait for navigation
    try {
      await page.waitForURL(/app\.procore\.com|sandbox\.procore\.com|us02\.procore\.com/, { timeout: 30000 });
      log("Successfully logged into Procore", "playwright");
      return true;
    } catch {
      // Check for MFA or error
      const mfaInput = await page.$(PROCORE_SELECTORS.login.mfaInput);
      if (mfaInput) {
        log("MFA required - cannot proceed", "playwright");
        return false;
      }
      
      const errorElement = await page.$(PROCORE_SELECTORS.login.errorMessage);
      if (errorElement) {
        const errorText = await errorElement.textContent();
        log(`Login failed: ${errorText}`, "playwright");
        return false;
      }
      
      log("Login navigation timed out", "playwright");
      return false;
    }
  } catch (error: any) {
    log(`Login error: ${error.message}`, "playwright");
    return false;
  }
}
