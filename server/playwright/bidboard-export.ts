/**
 * BidBoard Excel Export RPA
 * ==========================
 *
 * Playwright RPA to export the "Export Project List To Excel" file from Procore Bid Board.
 * Bid Board does NOT expose stage changes via webhook or API — the only reliable way to get
 * current stage data is to download the export from the dashboard UI.
 *
 * Key behaviors:
 * - Uses text-based selectors (most reliable) over CSS (Procore's styled-component classes change)
 * - Handles both download event and navigation-based download (Procore may redirect to download URL)
 * - Presses Escape before interacting if overlay is blocking (StyledPortal)
 * - Generous timeouts for 375+ projects (Excel generation can take 30+ seconds)
 *
 * @module playwright/bidboard-export
 */

import { Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { ensureLoggedIn } from "./auth";
import { randomDelay, takeScreenshot } from "./browser";
import { log } from "../index";
import { storage } from "../storage";

const EXPORTS_DIR = path.join(process.cwd(), "data", "exports");
const EXPORT_TIMEOUT_MS = 60000;

async function getCompanyId(): Promise<string | null> {
  const config = await storage.getAutomationConfig("procore_config");
  return (config?.value as any)?.companyId || null;
}

async function isSandbox(): Promise<boolean> {
  const credentials = await storage.getAutomationConfig("procore_browser_credentials");
  return (credentials?.value as any)?.sandbox || false;
}

function getBidBoardExportUrl(companyId: string, sandbox: boolean): string {
  const base = sandbox ? "https://sandbox.procore.com" : "https://us02.procore.com";
  return `${base}/webclients/host/companies/${companyId}/tools/bid-board`;
}

/**
 * Export the Bid Board project list to Excel via Playwright RPA.
 * 1. Navigates to Bid Board
 * 2. Clicks three-dot overflow menu
 * 3. Clicks "Export Project List To Excel"
 * 4. Waits for and saves the downloaded .xlsx file
 *
 * @returns File path of saved export, or null on failure
 */
export async function exportBidBoardProjectList(): Promise<string | null> {
  const { page, success, error } = await ensureLoggedIn();
  if (!success || !page) {
    log(`BidBoard export failed: ${error || "Not logged in"}`, "playwright");
    return null;
  }

  const companyId = await getCompanyId();
  if (!companyId) {
    log("Procore company ID not configured", "playwright");
    return null;
  }

  const sandbox = await isSandbox();
  const bidBoardUrl = getBidBoardExportUrl(companyId, sandbox);

  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  } catch {
    // Dir may already exist
  }

  try {
    log("Navigating to Bid Board for export...", "playwright");
    await page.goto(bidBoardUrl, { waitUntil: "load", timeout: 60000 });
    await randomDelay(3000, 5000);

    // Press Escape in case Procore StyledPortal overlay is blocking pointer events
    await page.keyboard.press("Escape");
    await randomDelay(500, 1000);

    // Step 1: Find and click three-dot overflow menu
    // Prefer text/role selectors; avoid versioned class names like StyledPageTitle-core-12_35_0__sc-*
    const menuSelectors = [
      // Text-based: look for a button with more/options icon (common patterns)
      'button[aria-label*="more" i]',
      'button[aria-label*="menu" i]',
      'button[aria-haspopup="menu"]',
      // XPath structural fallback (more stable than versioned classes)
      '//*[@id="spaContent"]//div[contains(@class,"StyledBox") or contains(@class,"StyledPageTitle")]//button[.//span]',
      // Generic overflow button in header area
      '[role="button"]:has(svg), [role="button"]:has(span)',
    ];

    let menuClicked = false;
    for (const sel of menuSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 8000 });
          menuClicked = true;
          log(`Clicked overflow menu via: ${sel}`, "playwright");
          break;
        }
      } catch {
        /* try next */
      }
    }

    if (!menuClicked) {
      log("Could not find three-dot overflow menu", "playwright");
      await takeScreenshot(page, "bidboard-export-menu-not-found");
      throw new Error("Export menu button not found. Procore UI may have changed.");
    }

    await randomDelay(1500, 2500);

    // Step 2: Click "Export Project List To Excel"
    // Primary: text-based (most reliable)
    const exportLink = page.getByRole("link", { name: /Export project/i }).or(
      page.getByRole("menuitem", { name: /Export project/i })
    ).or(
      page.getByText("Export project", { exact: false })
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destPath = path.join(EXPORTS_DIR, `bidboard-export-${timestamp}.xlsx`);

    // Procore may trigger a download event or navigation-based download.
    const downloadPromise = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS });
    try {
      await exportLink.first().click({ timeout: 10000 });
    } catch (clickErr) {
      log(`Export click failed: ${clickErr}`, "playwright");
      await takeScreenshot(page, "bidboard-export-link-not-found");
      throw new Error("Export Project List To Excel link not found. Procore UI may have changed.");
    }

    const download = await downloadPromise.catch(() => null);
    if (download) {
      await download.saveAs(destPath);
      log(`BidBoard export saved: ${destPath}`, "playwright");
      return destPath;
    }

    // Fallback: if download didn't fire (navigation-based or slow Excel generation), wait and look
    log("Download event did not fire; checking for navigation-based download...", "playwright");
    await randomDelay(5000, 8000);
    const entries = await fs.readdir(EXPORTS_DIR).catch(() => []);
    const xlsx = entries.filter((e) => e.endsWith(".xlsx")).sort().reverse()[0];
    if (xlsx) {
      const full = path.join(EXPORTS_DIR, xlsx);
      if (full !== destPath) {
        try {
          await fs.rename(full, destPath);
        } catch {
          return full;
        }
      }
      return destPath;
    }

    log("No Excel file received after export click", "playwright");
    await takeScreenshot(page, "bidboard-export-no-file");
    return null;
  } catch (err: any) {
    log(`BidBoard export RPA failed: ${err.message}`, "playwright");
    await takeScreenshot(page, "bidboard-export-error");
    throw err;
  }
}
