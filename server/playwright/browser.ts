import { chromium, Browser, BrowserContext, Page } from "playwright";
import { log } from "../index";
import path from "path";
import fs from "fs/promises";

const STORAGE_DIR = process.env.PLAYWRIGHT_STORAGE_DIR || ".playwright-storage";
const SESSION_FILE = path.join(STORAGE_DIR, "procore-session.json");

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;

export interface BrowserConfig {
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
}

const defaultConfig: BrowserConfig = {
  headless: process.env.NODE_ENV === "production",
  slowMo: 50,
  timeout: 30000,
};

async function ensureStorageDir(): Promise<void> {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    // Directory may already exist
  }
}

export async function getBrowser(config: BrowserConfig = {}): Promise<Browser> {
  const mergedConfig = { ...defaultConfig, ...config };
  
  if (!browserInstance || !browserInstance.isConnected()) {
    log("Launching new browser instance", "playwright");
    browserInstance = await chromium.launch({
      headless: mergedConfig.headless,
      slowMo: mergedConfig.slowMo,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  
  return browserInstance;
}

export async function getContext(config: BrowserConfig = {}): Promise<BrowserContext> {
  await ensureStorageDir();
  
  if (contextInstance) {
    return contextInstance;
  }
  
  const browser = await getBrowser(config);
  
  // Try to load existing session
  let storageState: string | undefined;
  try {
    await fs.access(SESSION_FILE);
    storageState = SESSION_FILE;
    log("Loading existing session from storage", "playwright");
  } catch {
    log("No existing session found, creating new context", "playwright");
  }
  
  contextInstance = await browser.newContext({
    storageState,
    viewport: { width: 1920, height: 1080 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
  });
  
  contextInstance.setDefaultTimeout(config.timeout || defaultConfig.timeout || 30000);
  
  return contextInstance;
}

export async function getPage(config: BrowserConfig = {}): Promise<Page> {
  const context = await getContext(config);
  const pages = context.pages();
  
  if (pages.length > 0) {
    return pages[0];
  }
  
  return await context.newPage();
}

export async function saveSession(): Promise<void> {
  if (contextInstance) {
    await ensureStorageDir();
    await contextInstance.storageState({ path: SESSION_FILE });
    log("Session saved to storage", "playwright");
  }
}

export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(SESSION_FILE);
    log("Session cleared", "playwright");
  } catch {
    // File may not exist
  }
  
  if (contextInstance) {
    await contextInstance.close();
    contextInstance = null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (contextInstance) {
    await saveSession();
    await contextInstance.close();
    contextInstance = null;
  }
  
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    log("Browser closed", "playwright");
  }
}

export async function takeScreenshot(page: Page, name: string): Promise<string> {
  await ensureStorageDir();
  const screenshotPath = path.join(STORAGE_DIR, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log(`Screenshot saved: ${screenshotPath}`, "playwright");
  return screenshotPath;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      log(`Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`, "playwright");
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  
  throw lastError;
}

export async function waitForNavigation(page: Page, urlPattern?: string | RegExp): Promise<void> {
  if (urlPattern) {
    await page.waitForURL(urlPattern, { timeout: 30000 });
  } else {
    await page.waitForLoadState("networkidle");
  }
}

export function randomDelay(minMs: number = 500, maxMs: number = 2000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}
