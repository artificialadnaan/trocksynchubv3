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
  const companyId = await getCompanyId();
  if (!companyId) {
    log("Procore company ID not configured", "playwright");
    return null;
  }

  const sandbox = await isSandbox();
  const bidBoardUrl = getBidBoardExportUrl(companyId, sandbox);

  const { page, success, error } = await ensureLoggedIn({ targetUrl: bidBoardUrl });
  if (!success || !page) {
    log(`BidBoard export failed: ${error || "Not logged in"}`, "playwright");
    return null;
  }

  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  } catch {
    // Dir may already exist
  }

  try {
    if (!page.url().includes("/tools/bid-board")) {
      log("Navigating to Bid Board for export...", "playwright");
      await page.goto(bidBoardUrl, { waitUntil: "load", timeout: 60000 });
    }
    await randomDelay(3000, 5000);

    // Close any open modals (Company Settings, etc.) before interacting with the page
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await randomDelay(300, 600);
    }
    await randomDelay(500, 1000);

    // Step 1: Click three-dot overflow menu
    // DOM: <span class="StyledContent-..."><svg data-qa="ci-EllipsisVertical" name="EllipsisVertical" ...></span>
    const menuSelectors: { name: string; fn: () => ReturnType<typeof page.locator> }[] = [
      { name: '[data-qa="ci-EllipsisVertical"]', fn: () => page.locator('[data-qa="ci-EllipsisVertical"]') },
      { name: 'span:has([data-qa="ci-EllipsisVertical"])', fn: () => page.locator('span:has([data-qa="ci-EllipsisVertical"])') },
      { name: 'button:has([data-qa="ci-EllipsisVertical"])', fn: () => page.locator('button:has([data-qa="ci-EllipsisVertical"])') },
      { name: 'svg[name="EllipsisVertical"]', fn: () => page.locator('svg[name="EllipsisVertical"]') },
    ];
    let menuClicked = false;
    for (const { name, fn } of menuSelectors) {
      try {
        const loc = fn();
        const count = await loc.count();
        log(`Trying three-dot menu selector: ${name} (found ${count} elements)`, "playwright");
        if (count > 0) {
          const first = loc.first();
          const isVisible = await first.isVisible().catch(() => false);
          log(`Selector ${name}: first element visible=${isVisible}`, "playwright");
          if (isVisible) {
            await first.click({ timeout: 8000 });
            await randomDelay(1500, 2500);
            if (await page.locator("text=Export").first().isVisible().catch(() => false)) {
              log(`Three-dot menu opened successfully with selector: ${name}`, "playwright");
              menuClicked = true;
              break;
            }
            log(`Selector ${name}: clicked but Export text not visible`, "playwright");
          }
        }
      } catch (err: any) {
        log(`Selector ${name} failed: ${err?.message || String(err)}`, "playwright");
      }
    }
    if (!menuClicked) {
      log("Could not find three-dot overflow menu; all selectors exhausted", "playwright");
      await takeScreenshot(page, "bidboard-export-menu-not-found").catch((screenshotErr) => {
        log(`Could not capture menu-not-found screenshot: ${screenshotErr}`, "playwright");
      });
      throw new Error("Export menu button not found. Procore UI may have changed.");
    }
    await randomDelay(1000, 2000);

    // Step 2: Click "Export project list to Excel" menu item
    // DOM: <li class="aid-exportProjectList" role="menuitem"><a>Export project list to Excel</a></li>
    const exportTimeout = 30000;
    const exportSelectors: { name: string; loc: ReturnType<typeof page.locator> }[] = [
      { name: ".aid-exportProjectList", loc: page.locator(".aid-exportProjectList") },
      { name: 'li[role="menuitem"]:has-text("Export")', loc: page.locator('li[role="menuitem"]').filter({ hasText: /export.*excel/i }) },
      { name: "getByRole(menuitem, export excel)", loc: page.getByRole("menuitem", { name: /export.*excel/i }) },
    ];

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destPath = path.join(EXPORTS_DIR, `bidboard-export-${timestamp}.xlsx`);

    // Procore may trigger a download event or navigation-based download.
    const downloadPromise = page.waitForEvent("download", { timeout: EXPORT_TIMEOUT_MS });
    let exportClicked = false;
    for (const { name, loc } of exportSelectors) {
      try {
        const count = await loc.count();
        log(`Trying export menu selector: ${name} (found ${count} elements)`, "playwright");
        if (count > 0) {
          await loc.first().click({ timeout: exportTimeout });
          exportClicked = true;
          log(`Clicked export via selector: ${name}`, "playwright");
          break;
        }
      } catch (err: any) {
        log(`Export selector ${name} failed: ${err?.message || String(err)}`, "playwright");
      }
    }
    try {
      if (!exportClicked) throw new Error("Export link not found");
    } catch (clickErr) {
      log(`Export click failed: ${clickErr}`, "playwright");
      await takeScreenshot(page, "bidboard-export-link-not-found").catch((screenshotErr) => {
        log(`Could not capture export-link-not-found screenshot: ${screenshotErr}`, "playwright");
      });
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
    await takeScreenshot(page, "bidboard-export-no-file").catch((screenshotErr) => {
      log(`Could not capture export-no-file screenshot: ${screenshotErr}`, "playwright");
    });
    return null;
  } catch (err: any) {
    log(`BidBoard export RPA failed: ${err.message}`, "playwright");
    await takeScreenshot(page, "bidboard-export-error").catch((screenshotErr) => {
      log(`Could not capture export-error screenshot: ${screenshotErr}`, "playwright");
    });
    throw err;
  }
}
