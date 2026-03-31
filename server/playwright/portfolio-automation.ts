/**
 * Portfolio Automation Module
 * ===========================
 *
 * Complete Playwright automation for the Bid Board → Portfolio workflow.
 * Phase 1 (Bid Board): Add to Portfolio, export docs, upload docs
 * Phase 2 (Portfolio): Send to Budget, Create Prime Contract
 * Phase 3 (Portfolio): Scrape Bid Board data, add customer to directory, edit prime contract
 *
 * All selectors are based on actual Procore DOM inspection (March 2026).
 * Key selector patterns used:
 *   - .aid-* classes (stable across Procore versions)
 *   - [data-qa="..."] attributes
 *   - [role="menuitem"] with text matching
 *   - .aid-confirmButton for modal confirm buttons
 *
 * @module playwright/portfolio-automation
 */

import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { randomDelay, takeScreenshot } from "./browser";
import { log } from "../index";
import { storage } from "../storage";
import * as path from "path";
import * as fs from "fs/promises";

// ─── Download directory ─────────────────────────────────────────
const DOWNLOADS_DIR = path.join(process.cwd(), "data", "portfolio-automation-downloads");

// ─── Selectors (from actual DOM inspection March 2026) ──────────
// These use stable .aid-* classes and data-qa attributes from the live Procore UI.
// Versioned class names like StyledBox-core-12_35_0__sc-* are AVOIDED — they break on updates.

const SEL = {
  // Global / shared
  ellipsisButton: '[data-qa="ci-EllipsisVertical"]',
  confirmButton: ".aid-confirmButton",

  // Bid Board project page — tabs
  tabs: {
    overview: ".aid-projBarOverview.aid-tab",
    documents: ".aid-projBarPlans.aid-tab",
    estimating: ".aid-projBarEstimation.aid-tab",
    proposal: ".aid-projBarBid.aid-tab",
  },

  // Bid Board — Add to Portfolio (from ellipsis dropdown)
  addToPortfolio: {
    menuItem: '[role="menuitem"] a:has-text("Add to Portfolio")',
  },

  // Bid Board — Export from Estimating tab
  estimateExport: {
    exportButton: "button.aid-export",
    excelMenuItem: ".aid-exportToExcel[role='menuitem']",
    excelMenuItemFallback: '[role="menuitem"] a:has-text("Excel")',
    estimateMenuItem: ".aid-exportsSubmenu[role='menuitem']",
    estimateMenuItemFallback: '[role="menuitem"] a:has-text("Estimate")',
  },

  // Bid Board — Proposal tab
  proposal: {
    exportButtonByLabel: 'button[label="Export"]',
    saveAsPdf: ".aid-exportBid-pdf[role='menuitem']",
    saveAsPdfFallback: '[role="menuitem"] a:has-text("Save as PDF")',
  },

  // Bid Board — Documents tab
  documents: {
    uploadButton: 'button[label="Upload"]',
    uploadAttachments: '.aid-upload-attachments[role="menuitem"]',
    uploadAttachmentsFallback: '[role="menuitem"] a:has-text("Upload Attachments")',
    attachButton: '[data-qa="qa-attach-button"]',
    sendToDocumentsTool: '[role="menuitem"] a:has-text("Send To Documents Tool")',
    fileInput: 'input[type="file"]',
  },

  // Portfolio — Estimating tool (after project is in Portfolio)
  portfolioEstimating: {
    actionsButton: 'button.aid-actions, button:has-text("Actions")',
    sendToBudget: ".aid-send-to-budget[role='menuitem'], [role='menuitem']:has-text('Send to Budget')",
    sendToBudgetFallback: '[role="menuitem"] a:has-text("Send to Budget"), [role="menuitem"]:has-text("Send to Budget")',
    createPrimeContract: ".aid-create-prime-contract[role='menuitem'], [role='menuitem']:has-text('Create Prime Contract')",
    createPrimeContractFallback: '[role="menuitem"] a:has-text("Create Prime Contract"), [role="menuitem"]:has-text("Create Prime Contract")',
    estimatingTab: '.aid-tab-title:has-text("Estimating")',
  },

  // Modal / loading states
  modal: {
    dialog: '[role="dialog"], [role="presentation"]',
    closeButton: '[role="dialog"] button:has([data-qa="ci-Close"])',
    loadingSpinner: '[role="img"][aria-label="Loading"]',
  },

  // Phase 3 — Directory
  directory: {
    addCompanyBtn: "#new-add-company-btn button, [data-pendo='new-add-company-open-modal-button']",
    searchInput: '[data-qa="core-search-input"]',
    addToProjectBtn: '[data-pendo="new-add-company-save-from-company-directory"]',
  },

  // Phase 3 — Prime Contract edit
  primeContract: {
    firstRowLink: ".ag-row-first a[href*='prime_contracts/']",
    fallbackLink: 'a[href*="prime_contracts/"]:not([href*="/edit"])',
    editButton: '[data-qa="editButton"], a:has-text("Edit Contract"), button:has-text("Edit Contract")',
    contractNumInput: '[data-qa="field_number"] input, input[name="number"]',
    vendorField: '[data-qa="field_vendor"]',
    contractorField: '[data-qa="field_contractor"]',
    saveButton: '[data-qa="saveButton"], button:has-text("Save")',
    tinyMceFrame: "iframe.tox-edit-area__iframe",
  },
};

// ─── Types ──────────────────────────────────────────────────────

export interface BidBoardScrapedData {
  customerCompanyName: string | null;
  projectNumber: string | null;
  scopeOfWork: string | null;
  inclusions: string[];
  exclusions: string[];
}

export interface PortfolioAutomationResult {
  success: boolean;
  bidboardProjectId: string;
  portfolioProjectId?: string;
  steps: StepResult[];
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

interface StepResult {
  step: string;
  status: "success" | "failed" | "skipped";
  duration: number;
  error?: string;
  screenshotPath?: string;
  metadata?: Record<string, unknown>;
}

export interface AutomationJobState {
  jobId: string;
  bidboardProjectId: string;
  portfolioProjectId?: string;
  companyId: string;
  startedAt: Date;
  currentPhase: "phase1" | "phase2" | "phase3" | "completed" | "failed";
  currentStep: string;
  completedSteps: string[];
  failedSteps: string[];
  collectedData: {
    estimateExcelPath?: string;
    proposalPdfPath?: string;
    scrapedData?: BidBoardScrapedData;
    contractNumber?: string;
  };
  error?: string;
}

// ─── Step Logger ────────────────────────────────────────────────

async function logStep(
  page: Page | null,
  result: PortfolioAutomationResult,
  step: string,
  status: "success" | "failed" | "skipped",
  duration: number,
  opts?: { error?: string; screenshotPath?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  let pageContext: Record<string, string> = {};
  if (page) {
    try {
      pageContext = {
        url: page.url(),
        title: await page.title().catch(() => "unknown"),
      };
    } catch {
      /* page may be closed */
    }
  }

  const stepResult: StepResult = { step, status, duration, ...opts };
  result.steps.push(stepResult);

  await storage.createBidboardAutomationLog({
    projectId: result.bidboardProjectId,
    projectName: result.bidboardProjectId,
    action: `portfolio_automation:${step}`,
    status,
    details: {
      duration,
      pageUrl: pageContext.url,
      pageTitle: pageContext.title,
      ...opts?.metadata,
    },
    errorMessage: opts?.error,
    screenshotPath: opts?.screenshotPath,
  });

  const emoji = status === "success" ? "✓" : status === "failed" ? "✗" : "⊘";
  log(
    `[portfolio-auto] ${emoji} ${step} (${duration}ms) ${status === "failed" ? "— " + (opts?.error || "") : ""} [${pageContext.url || "no page"}]`,
    "playwright"
  );
}

// ─── Failure context capture ────────────────────────────────────

async function captureFailureContext(
  page: Page,
  stepName: string
): Promise<{ screenshotPath: string; diagnostics: Record<string, unknown> }> {
  const screenshotPath = await takeScreenshot(page, `fail-${stepName}`);
  const diagnostics: Record<string, unknown> = {
    url: page.url(),
    title: await page.title().catch(() => "unknown"),
  };

  try {
    diagnostics.hasErrorToast =
      (await page.locator('[class*="error"], [role="alert"], .toast-error').count()) > 0;
    diagnostics.hasModal =
      (await page.locator('[role="dialog"], [role="presentation"]').count()) > 0;
    diagnostics.hasLoadingSpinner =
      (await page.locator('[role="img"][aria-label="Loading"], .ajax-loader').count()) > 0;

    const errorEl = await page.$('[class*="error"], [role="alert"]');
    if (errorEl) {
      diagnostics.errorText = await errorEl.textContent().catch(() => null);
    }

    const modalTitle = await page.$(
      '[role="dialog"] h2, [role="dialog"] h3, [role="presentation"] h2'
    );
    if (modalTitle) {
      diagnostics.modalTitle = await modalTitle.textContent().catch(() => null);
    }

    diagnostics.sessionExpired = page.url().includes("login");
    diagnostics.hasProcoreNav =
      (await page.locator('nav, [class*="navigation"], [class*="header"]').count()) > 0;
  } catch {
    /* some diagnostics may fail */
  }

  return { screenshotPath, diagnostics };
}

// ─── Session expiry check ───────────────────────────────────────

async function ensureStillLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("login")) {
    log("[portfolio-auto] Session expired — detected login page redirect", "playwright");
    return false;
  }
  const sessionExpired = await page
    .locator('text="session expired"i, text="sign in"i, text="log in"i')
    .count();
  if (sessionExpired > 0 && url.includes("procore.com")) {
    log("[portfolio-auto] Session expired — detected sign-in prompt", "playwright");
    return false;
  }
  return true;
}

// ─── Automation summary ─────────────────────────────────────────

function logAutomationSummary(result: PortfolioAutomationResult): void {
  const totalDuration = result.completedAt
    ? result.completedAt.getTime() - result.startedAt.getTime()
    : Date.now() - result.startedAt.getTime();
  const succeeded = result.steps.filter((s) => s.status === "success").length;
  const failed = result.steps.filter((s) => s.status === "failed").length;
  const skipped = result.steps.filter((s) => s.status === "skipped").length;

  log(`\n${"═".repeat(60)}`, "playwright");
  log(`PORTFOLIO AUTOMATION COMPLETE`, "playwright");
  log(`${"═".repeat(60)}`, "playwright");
  log(`  Bid Board Project: ${result.bidboardProjectId}`, "playwright");
  log(`  Portfolio Project: ${result.portfolioProjectId || "N/A"}`, "playwright");
  log(`  Overall: ${result.success ? "SUCCESS" : "FAILED"}`, "playwright");
  log(`  Duration: ${(totalDuration / 1000).toFixed(1)}s`, "playwright");
  log(`  Steps: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`, "playwright");
  if (failed > 0) {
    log(`  Failed steps:`, "playwright");
    for (const step of result.steps.filter((s) => s.status === "failed")) {
      log(`    ✗ ${step.step}: ${step.error}`, "playwright");
      if (step.screenshotPath) log(`      Screenshot: ${step.screenshotPath}`, "playwright");
    }
  }
  log(`${"═".repeat(60)}\n`, "playwright");
}

// ─── Helper: Extract portfolio project ID from URL ────────────────────────
// Portfolio URLs: /projects/{id}/tools/estimating/ (Bid Board uses /tools/bid-board/project/)
function extractPortfolioProjectIdFromUrl(url: string): string | null {
  const match = url.match(/\/projects\/(\d+)\//);
  return match ? match[1] : null;
}

// ─── Helper: Dismiss any open modals (e.g. Add to Portfolio confirmation) ──
// The Add to Portfolio confirmation dialog can linger and block clicks on the Estimation tab.

async function dismissOpenModals(page: Page): Promise<void> {
  const openModal = page.locator('.MuiDialog-root, [role="presentation"].MuiModal-root, [role="dialog"]');
  if ((await openModal.count()) > 0) {
    await page.keyboard.press("Escape");
    await randomDelay(800, 1200);
    await page.keyboard.press("Escape");
    await randomDelay(800, 1200);
  }
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.MuiDialog-root, .MuiModal-root, [role="dialog"]').length === 0,
      { timeout: 10000 }
    );
  } catch {
    log("[portfolio-auto] Warning: modal may still be present, proceeding anyway", "playwright");
  }
}

// ─── Helper: Wait for modal to close ────────────────────────────

async function waitForModalToClose(page: Page, timeoutMs: number = 120000): Promise<void> {
  try {
    await page.waitForSelector(SEL.modal.dialog, { state: "hidden", timeout: timeoutMs });
  } catch {
    try {
      await page.waitForSelector(SEL.modal.loadingSpinner, { state: "hidden", timeout: 10000 });
    } catch {
      await randomDelay(5000, 8000);
    }
  }
}

// ─── Helper: Wait for confirm button to be enabled ──────────────

async function waitForConfirmButtonEnabled(page: Page, timeoutMs: number = 60000): Promise<void> {
  await page.waitForSelector(`${SEL.confirmButton}:not([disabled])`, { timeout: timeoutMs });
  await randomDelay(500, 1000);
}

// ─── Helper: Click menu item with fallback ──────────────────────

async function clickMenuItem(
  page: Page,
  primary: string,
  fallback: string,
  description: string
): Promise<void> {
  try {
    const item = page.locator(primary).first();
    if ((await item.count()) > 0) {
      await item.click({ timeout: 8000 });
      return;
    }
  } catch {
    /* try fallback */
  }

  const fb = page.locator(fallback).first();
  if ((await fb.count()) > 0) {
    await fb.click({ timeout: 8000 });
    return;
  }

  throw new Error(`Could not find menu item: ${description}`);
}

// ─── Helper: Wait for Procore SPA content to load ─────────────────
// Procore pages load initial HTML then hydrate SPA content async.
// page.goto waitUntil: "load" fires before SPA renders. Use this after
// navigation to wait for meaningful UI elements before interacting.

async function detectProcoreErrorPage(page: Page): Promise<string | null> {
  try {
    const errorText = await page.locator('text="Something went wrong"').first().textContent({ timeout: 2000 }).catch(() => null);
    if (errorText) {
      const detail = await page.locator('body').textContent().catch(() => "") || "";
      const match = detail.match(/(Active proposal is not set|Please try again|contact support)/i);
      return match ? match[0] : "Something went wrong";
    }
  } catch { /* no error page */ }
  return null;
}

async function waitForProcoreSpaLoaded(
  page: Page,
  selectors: string[],
  logContext: string,
  fallbackDelay: [number, number] = [15000, 18000]
): Promise<void> {
  // Check for Procore error page first (e.g. "Active proposal is not set")
  const errorMsg = await detectProcoreErrorPage(page);
  if (errorMsg) {
    log(`[portfolio-auto] Procore error page detected: "${errorMsg}" — reloading`, "playwright");
    await page.reload({ waitUntil: "load", timeout: 60000 });
    await randomDelay(3000, 5000);

    // Check again after reload
    const errorAfterReload = await detectProcoreErrorPage(page);
    if (errorAfterReload) {
      // Try /details? (bare, no proposalId) — Procore auto-fills proposalId on redirect
      const currentUrl = page.url();
      const baseUrl = currentUrl.split("?")[0];
      const detailsUrl = baseUrl.endsWith("/details") ? `${baseUrl}?` : `${baseUrl}/details?`;
      log(`[portfolio-auto] Error persists after reload — trying bare details URL: ${detailsUrl}`, "playwright");
      await page.goto(detailsUrl, { waitUntil: "load", timeout: 60000 });
      await randomDelay(3000, 5000);

      const errorAfterNav = await detectProcoreErrorPage(page);
      if (errorAfterNav) {
        log(`[portfolio-auto] Error persists after bare details nav: "${errorAfterNav}" — will attempt to proceed`, "playwright");
      }
    }
  }

  let spaLoaded = false;
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 30000 });
      spaLoaded = true;
      log(`[portfolio-auto] ${logContext} SPA loaded (found: ${sel})`, "playwright");
      break;
    } catch {
      /* try next selector */
    }
  }
  if (!spaLoaded) {
    log(
      `[portfolio-auto] WARNING: No SPA content indicators found for ${logContext}, waiting ${fallbackDelay[0] / 1000}s as fallback`,
      "playwright"
    );
    await randomDelay(fallbackDelay[0], fallbackDelay[1]);
  }
  await randomDelay(2000, 3000);
}

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Bid Board Actions
// ═══════════════════════════════════════════════════════════════

const PHASE1_ADD_TO_PORTFOLIO_STEPS = [
  "click_add_to_portfolio",
  "confirm_add_to_portfolio",
  "wait_portfolio_creation",
] as const;

/** Check if project is already in Portfolio (Add to Portfolio menu item does not exist). */
async function isProjectAlreadyInPortfolio(page: Page): Promise<boolean> {
  await page.keyboard.press("Escape");
  await randomDelay(500, 1000);

  let menuOpened = false;
  const ellipsisButtons = page.locator(SEL.ellipsisButton);
  if ((await ellipsisButtons.count()) > 0) {
    try {
      await ellipsisButtons.first().click({ timeout: 8000 });
      menuOpened = true;
    } catch {
      /* try stage caret fallback */
    }
  }
  if (!menuOpened) {
    const stageCaret = page.locator('[data-qa="ci-ChevronDown"]').first();
    if ((await stageCaret.count()) > 0) {
      await stageCaret.click({ timeout: 8000 });
      menuOpened = true;
    }
  }
  if (!menuOpened) return false;

  await page.waitForSelector('[role="menuitem"]', { timeout: 5000 }).catch(() => {});
  await randomDelay(800, 1500);

  const addToPortfolioItem = page.locator(SEL.addToPortfolio.menuItem).first();
  const count = await addToPortfolioItem.count();
  const exists = count > 0 && (await addToPortfolioItem.isVisible());
  await page.keyboard.press("Escape");
  await randomDelay(300, 600);
  return !exists;
}

/**
 * Phase 1: Runs in the Bid Board context.
 * Steps: Add to Portfolio → Export Estimate → Export Proposal → Upload Docs → Send to Documents Tool
 * On retry, skips steps that already succeeded (resume from failed step).
 */
export async function runPhase1BidBoardActions(
  page: Page,
  bidboardProjectUrl: string,
  result: PortfolioAutomationResult,
  retryOptions?: Phase1RetryOptions
): Promise<{ estimateExcelPath: string | null; proposalPdfPath: string | null }> {
  const completedStepNames = retryOptions?.completedStepNames ?? [];
  const previousOutput = retryOptions?.previousOutput;

  let estimateExcelPath: string | null = previousOutput?.estimateExcelPath ?? null;
  let proposalPdfPath: string | null = previousOutput?.proposalPdfPath ?? null;

  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  const completedSet = new Set(completedStepNames);
  const skipAddToPortfolio =
    completedSet.has("click_add_to_portfolio") || completedSet.has("confirm_add_to_portfolio");

  // ── Navigate and optionally skip add-to-portfolio block ───
  await page.goto(bidboardProjectUrl, { waitUntil: "load", timeout: 60000 });
  const bidboardSpaSelectors = [
    ".aid-projBarOverview",
    ".aid-projBarEstimation",
    ".aid-tab",
    '[data-qa="ci-EllipsisVertical"]',
  ];
  await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board project");

  // If error page persists, try fallback URLs then BidBoard list as last resort
  const postLoadError = await detectProcoreErrorPage(page);
  if (postLoadError) {
    const projectIdMatch = bidboardProjectUrl.match(/\/project\/(\d+)/);
    const companyMatch = bidboardProjectUrl.match(/\/companies\/(\d+)/);
    const companyId = companyMatch?.[1] || "";
    const projectId = projectIdMatch?.[1] || "";

    // Fallback 1: Try /details? without proposalId (Procore auto-fills it on redirect)
    if (projectId) {
      const bareDetailsUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${projectId}/details?`;
      log(`[portfolio-auto] Error page: "${postLoadError}" — trying bare /details? URL`, "playwright");
      await page.goto(bareDetailsUrl, { waitUntil: "load", timeout: 60000 });
      await randomDelay(3000, 5000);
    }

    const errorAfterBare = await detectProcoreErrorPage(page);
    if (errorAfterBare && projectId) {
      // Fallback 2: Navigate via BidBoard list view
      log(`[portfolio-auto] Still error after bare URL: "${errorAfterBare}" — trying BidBoard list navigation`, "playwright");
      const listUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board`;
      await page.goto(listUrl, { waitUntil: "load", timeout: 60000 });
      await randomDelay(5000, 7000);
      const projectLink = page.locator(`a[href*="/project/${projectId}"]`).first();
      if (await projectLink.count() > 0) {
        await projectLink.click({ timeout: 10000 });
        await page.waitForLoadState("load").catch(() => {});
        await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board project (list nav)");
        log(`[portfolio-auto] Successfully navigated to project via BidBoard list`, "playwright");
      }
    } else if (!errorAfterBare) {
      await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board project (bare details)");
      log(`[portfolio-auto] Bare /details? URL loaded successfully`, "playwright");
    }
  }

  const alreadyInPortfolio = await isProjectAlreadyInPortfolio(page);
  const shouldSkipAddToPortfolio = skipAddToPortfolio || alreadyInPortfolio;

  if (shouldSkipAddToPortfolio) {
    log(
      `[portfolio-auto] Skipping add-to-portfolio (already in Portfolio or completed in previous attempt)`,
      "playwright"
    );

    // Ensure we're on the actual project page, not stuck on the BidBoard list or error page
    const currentUrl = page.url();
    const isOnProjectPage = currentUrl.includes("/project/") && !await detectProcoreErrorPage(page);
    if (!isOnProjectPage) {
      log(`[portfolio-auto] Not on project page (url: ${currentUrl}), navigating into project before proceeding`, "playwright");
      await page.goto(bidboardProjectUrl, { waitUntil: "load", timeout: 60000 });
      await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board project (re-entry)");

      // Verify we actually made it to the project page
      const reEntryUrl = page.url();
      const reEntryError = await detectProcoreErrorPage(page);
      if (reEntryError || (!reEntryUrl.includes("/project/"))) {
        throw new Error(`Could not navigate to project page after re-entry (url: ${reEntryUrl}, error: ${reEntryError || 'not on project page'})`);
      }
    }

    // Try to find portfolio project ID since we skipped portfolio creation
    if (!result.portfolioProjectId) {
      // Method 1: Check sync mapping for portfolio_project_id
      try {
        const bidId = bidboardProjectUrl.match(/\/project\/(\d+)/)?.[1];
        if (bidId) {
          const mapping = await storage.getSyncMappingByBidboardProjectId(bidId);
          if (mapping?.portfolioProjectId) {
            result.portfolioProjectId = mapping.portfolioProjectId;
            log(`[portfolio-auto] Found portfolio project ID from sync mapping: ${mapping.portfolioProjectId}`, "playwright");
          }
        }
      } catch { /* continue to method 2 */ }

      // Method 2: Navigate to project home — Procore redirects BidBoard projects in portfolio to /projects/{id}/
      if (!result.portfolioProjectId) {
        try {
          const companyMatch = bidboardProjectUrl.match(/\/companies\/(\d+)/);
          const bidId = bidboardProjectUrl.match(/\/project\/(\d+)/)?.[1];
          if (companyMatch && bidId) {
            const homeUrl = `https://us02.procore.com/webclients/host/companies/${companyMatch[1]}/projects?search=${bidId}`;
            await page.goto(homeUrl, { waitUntil: "load", timeout: 30000 });
            await randomDelay(3000, 5000);
            // Look for project link containing /projects/{id}/
            const projectLinks = await page.locator('a[href*="/projects/"]').all();
            for (const link of projectLinks) {
              const href = await link.getAttribute("href");
              const pid = href?.match(/\/projects\/(\d+)/)?.[1];
              if (pid) {
                result.portfolioProjectId = pid;
                log(`[portfolio-auto] Found portfolio project ID from project search: ${pid}`, "playwright");
                break;
              }
            }
          }
          // Navigate back
          await page.goto(bidboardProjectUrl, { waitUntil: "load", timeout: 60000 });
          await randomDelay(2000, 3000);
        } catch (err) {
          log(`[portfolio-auto] Could not extract portfolio project ID: ${err instanceof Error ? err.message : String(err)}`, "playwright");
        }
      }
    }

    for (const step of PHASE1_ADD_TO_PORTFOLIO_STEPS) {
      await logStep(page, result, step, "skipped", 0, {
        metadata: { reason: "Resuming from failed step; project already in Portfolio" },
      });
    }
  } else {
    // ── Step 2: Click ellipsis → Add to Portfolio ─────────────
    const step2Start = Date.now();
    try {
      await page.keyboard.press("Escape");
      await randomDelay(500, 1000);

      let menuOpened = false;
      const ellipsisButtons = page.locator(SEL.ellipsisButton);
      if ((await ellipsisButtons.count()) > 0) {
        try {
          await ellipsisButtons.first().click({ timeout: 8000 });
          menuOpened = true;
          log("[portfolio-auto] Clicked header ellipsis", "playwright");
        } catch {
          /* try stage caret fallback */
        }
      }
      if (!menuOpened) {
        const stageCaret = page.locator('[data-qa="ci-ChevronDown"]').first();
        if ((await stageCaret.count()) > 0) {
          await stageCaret.click({ timeout: 8000 });
          menuOpened = true;
          log("[portfolio-auto] Clicked stage badge caret (ellipsis fallback)", "playwright");
        }
      }
      if (!menuOpened) {
        throw new Error("Could not open Global Actions menu (ellipsis or stage caret)");
      }
      await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
      await randomDelay(1000, 2000);

      await clickMenuItem(
        page,
        SEL.addToPortfolio.menuItem,
        'li[role="menuitem"]:has-text("Add To Portfolio")',
        "Add to Portfolio"
      );
      await randomDelay(1000, 2000);

      await logStep(page, result, "click_add_to_portfolio", "success", Date.now() - step2Start);
    } catch (err: unknown) {
      const { screenshotPath, diagnostics } = await captureFailureContext(page, "step2-add-to-portfolio");
      await logStep(page, result, "click_add_to_portfolio", "failed", Date.now() - step2Start, {
        error: err instanceof Error ? err.message : String(err),
        screenshotPath,
        metadata: { diagnostics },
      });
      throw err;
    }

    // ── Step 3: Confirm "Add To Portfolio" modal ──────────────
    const step3Start = Date.now();
    try {
      await waitForConfirmButtonEnabled(page, 30000);
      await page.click(SEL.confirmButton, { timeout: 10000 });
      await logStep(page, result, "confirm_add_to_portfolio", "success", Date.now() - step3Start);
    } catch (err: unknown) {
      const { screenshotPath, diagnostics } = await captureFailureContext(page, "step3-confirm-portfolio");
      await logStep(page, result, "confirm_add_to_portfolio", "failed", Date.now() - step3Start, {
        error: err instanceof Error ? err.message : String(err),
        screenshotPath,
        metadata: { diagnostics },
      });
      throw err;
    }

    // ── Step 4: Wait for portfolio creation ───────────────────
    const step4Start = Date.now();
    try {
      await waitForModalToClose(page, 120000);
      await randomDelay(3000, 5000);

      const currentUrl = page.url();
      log(`[portfolio-auto] After Add to Portfolio, URL: ${currentUrl}`, "playwright");

      const portfolioProjectId = extractPortfolioProjectIdFromUrl(currentUrl);
      if (portfolioProjectId) {
        result.portfolioProjectId = portfolioProjectId;
        log(`[portfolio-auto] Extracted portfolio project ID: ${portfolioProjectId}`, "playwright");

        // Save portfolio project ID to sync mapping for future runs
        try {
          const bidId = bidboardProjectUrl.match(/\/project\/(\d+)/)?.[1];
          if (bidId) {
            const mapping = await storage.getSyncMappingByBidboardProjectId(bidId);
            if (mapping && !mapping.portfolioProjectId) {
              await storage.updateSyncMapping(mapping.id, { portfolioProjectId });
              log(`[portfolio-auto] Saved portfolio project ID ${portfolioProjectId} to sync mapping ${mapping.id}`, "playwright");
            }
          }
        } catch { /* non-critical */ }

        // Set portfolio project stage to "Buy Out" via Procore API
        try {
          const { getAccessToken } = await import("../procore");
          const procoreConfigRaw = await storage.getAutomationConfig("procore_config");
          const procoreConfig = procoreConfigRaw?.value as { companyId?: string } | undefined;
          const cid = procoreConfig?.companyId;
          if (!cid) throw new Error("Procore company ID not configured");
          const { fetchWithRateLimitRetry } = await import("../lib/rate-limit-tracker");
          const accessToken = await getAccessToken();
          const stagesRes = await fetchWithRateLimitRetry(
            `https://api.procore.com/rest/v1.0/companies/${cid}/project_stages`,
            { headers: { Authorization: `Bearer ${accessToken}`, "Procore-Company-Id": cid } },
            "procore"
          );
          if (stagesRes.ok) {
            const stages = await stagesRes.json() as Array<{ id: number; name: string }>;
            const buyOutStage = stages.find((s) => s.name === "Buy Out");
            if (buyOutStage) {
              const updateRes = await fetchWithRateLimitRetry(
                `https://api.procore.com/rest/v1.0/projects/${portfolioProjectId}?company_id=${cid}`,
                {
                  method: "PATCH",
                  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Procore-Company-Id": cid },
                  body: JSON.stringify({ project: { project_stage_id: buyOutStage.id } }),
                },
                "procore"
              );
              if (updateRes.ok) {
                log(`[portfolio-auto] Set portfolio project stage to "Buy Out" (stage ID: ${buyOutStage.id})`, "playwright");
              } else {
                log(`[portfolio-auto] WARNING: Failed to set stage to Buy Out: ${updateRes.status}`, "playwright");
              }
            } else {
              log(`[portfolio-auto] WARNING: "Buy Out" stage not found in Procore project stages`, "playwright");
            }
          }
        } catch (stageErr: any) {
          log(`[portfolio-auto] WARNING: Could not set portfolio stage to Buy Out: ${stageErr.message}`, "playwright");
        }
      }

      await logStep(page, result, "wait_portfolio_creation", "success", Date.now() - step4Start, {
        metadata: { url: currentUrl, portfolioProjectId: result.portfolioProjectId },
      });
    } catch (err: unknown) {
      const { screenshotPath, diagnostics } = await captureFailureContext(page, "step4-wait-portfolio");
      await logStep(page, result, "wait_portfolio_creation", "failed", Date.now() - step4Start, {
        error: err instanceof Error ? err.message : String(err),
        screenshotPath,
        metadata: { diagnostics },
      });
    }
  }

  // ── Step 5-6: Go to Estimating tab → Export Excel ─────────
  if (completedSet.has("export_estimate_excel")) {
    await logStep(page, result, "export_estimate_excel", "skipped", 0, {
      metadata: { reason: "Completed in previous attempt", filePath: estimateExcelPath },
    });
  } else {
    const step6Start = Date.now();
    try {
      await dismissOpenModals(page);

      await page.click(SEL.tabs.estimating, { timeout: 10000 });
      await randomDelay(3000, 5000);

      // Extract portfolio project ID from URL if not yet set (e.g. when skipping add-to-portfolio)
      if (!result.portfolioProjectId) {
        const url = page.url();
        const pid = extractPortfolioProjectIdFromUrl(url);
        if (pid) {
          result.portfolioProjectId = pid;
          log(`[portfolio-auto] Extracted portfolio project ID from Estimation tab URL: ${pid}`, "playwright");
        }
      }

      await page.click(SEL.estimateExport.exportButton, { timeout: 10000 });
      await randomDelay(1000, 2000);

      await clickMenuItem(
        page,
        SEL.estimateExport.estimateMenuItem,
        SEL.estimateExport.estimateMenuItemFallback,
        "Estimate export submenu"
      );
      await randomDelay(1000, 2000);

      const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
      await clickMenuItem(
        page,
        SEL.estimateExport.excelMenuItem,
        SEL.estimateExport.excelMenuItemFallback,
        "Excel export"
      );

      const download = await downloadPromise;
      const timestamp = Date.now();
      estimateExcelPath = path.join(DOWNLOADS_DIR, `estimate-${timestamp}.xlsx`);
      await download.saveAs(estimateExcelPath);

      await logStep(page, result, "export_estimate_excel", "success", Date.now() - step6Start, {
        metadata: { filePath: estimateExcelPath },
      });
    } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "step6-export-estimate");
    await logStep(page, result, "export_estimate_excel", "failed", Date.now() - step6Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }
  }

  // ── Step 7-8: Go to Proposal tab → Handle warning → Export PDF ──
  if (completedSet.has("export_proposal_pdf")) {
    await logStep(page, result, "export_proposal_pdf", "skipped", 0, {
      metadata: { reason: "Completed in previous attempt", filePath: proposalPdfPath },
    });
  } else {
    const step8Start = Date.now();
    try {
      await page.click(SEL.tabs.proposal, { timeout: 10000 });
    await randomDelay(2000, 4000);

    try {
      const warningButton = page.locator(`${SEL.confirmButton}:has-text("Show Proposal")`);
      if ((await warningButton.count()) > 0) {
        await warningButton.click({ timeout: 5000 });
        await randomDelay(2000, 3000);
        log("[portfolio-auto] Dismissed Zero Field Warning modal", "playwright");
      }
    } catch {
      /* No warning modal */
    }

    await page.click(SEL.proposal.exportButtonByLabel, { timeout: 10000 });
    await randomDelay(1000, 2000);

    const pdfDownloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await clickMenuItem(
      page,
      SEL.proposal.saveAsPdf,
      SEL.proposal.saveAsPdfFallback,
      "Save as PDF"
    );

    const pdfDownload = await pdfDownloadPromise;
    const timestamp = Date.now();
    proposalPdfPath = path.join(DOWNLOADS_DIR, `proposal-${timestamp}.pdf`);
    await pdfDownload.saveAs(proposalPdfPath);

    await logStep(page, result, "export_proposal_pdf", "success", Date.now() - step8Start, {
      metadata: { filePath: proposalPdfPath },
    });
    } catch (err: unknown) {
      const { screenshotPath, diagnostics } = await captureFailureContext(page, "step8-export-proposal");
      await logStep(page, result, "export_proposal_pdf", "failed", Date.now() - step8Start, {
        error: err instanceof Error ? err.message : String(err),
        screenshotPath,
        metadata: { diagnostics },
      });
    }
  }

  // ── Step 9-11: Go to Documents tab → Upload files ─────────
  if (completedSet.has("upload_documents")) {
    await logStep(page, result, "upload_documents", "skipped", 0, {
      metadata: { reason: "Completed in previous attempt" },
    });
  } else {
    const step11Start = Date.now();
    try {
      await page.click(SEL.tabs.documents, { timeout: 10000 });
      await randomDelay(3000, 5000);

      await page.click(SEL.documents.uploadButton, { timeout: 10000 });
      await randomDelay(1000, 2000);

      await clickMenuItem(
        page,
        SEL.documents.uploadAttachments,
        SEL.documents.uploadAttachmentsFallback,
        "Upload Attachments"
      );
      await randomDelay(2000, 3000);

      const filesToUpload: string[] = [];
      if (estimateExcelPath) {
        try {
          await fs.access(estimateExcelPath);
          filesToUpload.push(estimateExcelPath);
        } catch {
          /* file doesn't exist */
        }
      }
      if (proposalPdfPath) {
        try {
          await fs.access(proposalPdfPath);
          filesToUpload.push(proposalPdfPath);
        } catch {
          /* file doesn't exist */
        }
      }

      if (filesToUpload.length > 0) {
        // Click "My Computer" tab if present
        try {
          await page.locator('text="My Computer"').first().click({ timeout: 5000 });
          await randomDelay(1000, 1500);
        } catch { /* tab may already be active */ }

        // Use page.evaluate to click "Upload Files" — Playwright locators can't see buttons inside Procore modals
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 30000 }),
          page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const uploadBtn = buttons.find(b => {
              const text = b.textContent?.trim();
              if (!text?.includes('Upload Files')) return false;
              const parent = b.closest('[class*="region"], [role="region"], [class*="Modal"]') || b.parentElement?.parentElement;
              return parent?.textContent?.includes('Drag & Drop');
            });
            if (uploadBtn) uploadBtn.click();
            else {
              const fallback = buttons.find(b => b.textContent?.trim().includes('Upload Files') && b.offsetParent !== null);
              if (fallback) fallback.click();
              else throw new Error('Upload Files button not found in modal');
            }
          }),
        ]);
        await fileChooser.setFiles(filesToUpload);

        // Wait for uploads to complete
        const fileCount = filesToUpload.length;
        await page.waitForFunction(
          (count: number) => {
            const statusEl = document.querySelector('[role="status"]');
            if (statusEl?.textContent?.includes(`Uploaded ${count} of ${count}`)) return true;
            if (statusEl?.textContent?.includes('Total Progress: 100%')) return true;
            return false;
          },
          fileCount,
          { timeout: 120000 }
        ).catch(() => {});
        await randomDelay(2000, 3000);

        // Click Attach via page.evaluate — same modal visibility issue
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const attachBtn = buttons.find(b => b.textContent?.trim() === 'Attach' && !b.disabled && b.offsetParent !== null);
          if (attachBtn) attachBtn.click();
          else {
            const fallback = buttons.find(b => b.textContent?.trim().includes('Attach') && !b.textContent?.includes('Attach Files') && !b.disabled);
            if (fallback) fallback.click();
          }
        });
        await randomDelay(3000, 5000);
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await randomDelay(2000, 3000);

        await logStep(page, result, "upload_documents", "success", Date.now() - step11Start, {
          metadata: { filesUploaded: filesToUpload.length },
        });
      } else {
        await logStep(page, result, "upload_documents", "skipped", Date.now() - step11Start, {
          metadata: { reason: "No files to upload" },
        });
      }
    } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "step11-upload-docs");
    await logStep(page, result, "upload_documents", "failed", Date.now() - step11Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
    }
  }

  // ── Step 12: Send Drawings folder to Documents Tool ───────
  if (completedSet.has("send_to_documents_tool")) {
    await logStep(page, result, "send_to_documents_tool", "skipped", 0, {
      metadata: { reason: "Completed in previous attempt" },
    });
  } else {
    const step12Start = Date.now();
    try {
      // Dismiss Attach Files modal if still open from failed upload (avoids StyledModalScrim blocking clicks)
      try {
          const cancelBtn = page.locator('button:has-text("Cancel"), [role="dialog"] button:has([data-qa="ci-Close"])').first();
        if ((await cancelBtn.count()) > 0) {
          await cancelBtn.click({ timeout: 3000 });
          await page.waitForSelector(SEL.modal.dialog, { state: "hidden", timeout: 5000 }).catch(() => {});
          await randomDelay(500, 1000);
        }
      } catch {
        /* modal may already be closed */
      }

      // Target the ellipsis next to the "Folders" header in the left sidebar (not the page-level ellipsis)
      const foldersHeader = page.locator('text="Folders"').first();
      let clicked = false;

      // Try 1: Sibling/adjacent ellipsis next to "Folders" text
      const foldersEllipsis = foldersHeader
        .locator("..")
        .locator('[data-qa="ci-EllipsisVertical"], button:has(svg)')
        .first();
      if ((await foldersEllipsis.count()) > 0) {
        await foldersEllipsis.click({ timeout: 8000 });
        clicked = true;
        log("[portfolio-auto] Clicked Folders header ellipsis", "playwright");
      }

      // Try 2: Hover first in case it's hidden until hover
      if (!clicked) {
        await foldersHeader.hover();
        await randomDelay(500, 500);
        const hoverEllipsis = foldersHeader
          .locator("..")
          .locator('[data-qa="ci-EllipsisVertical"], button:has(svg)')
          .first();
        if ((await hoverEllipsis.count()) > 0) {
          await hoverEllipsis.click({ timeout: 8000 });
          clicked = true;
          log("[portfolio-auto] Clicked Folders header ellipsis (after hover)", "playwright");
        }
      }

      // Try 3: Right-click the Folders header
      if (!clicked) {
        await foldersHeader.click({ button: "right", timeout: 8000 });
        clicked = true;
        log("[portfolio-auto] Right-clicked Folders header for context menu", "playwright");
      }

      if (!clicked) {
        throw new Error("Could not find ellipsis button for Drawings folder");
      }

      await randomDelay(1000, 2000);

      await clickMenuItem(
        page,
        SEL.documents.sendToDocumentsTool,
        '[role="menuitem"]:has-text("Send To Documents Tool")',
        "Send To Documents Tool"
      );
      await randomDelay(2000, 3000);

      await waitForModalToClose(page, 300000);
      await randomDelay(3000, 5000);

      await logStep(page, result, "send_to_documents_tool", "success", Date.now() - step12Start);
    } catch (err: unknown) {
      const { screenshotPath, diagnostics } = await captureFailureContext(page, "step12-send-docs-tool");
      await logStep(page, result, "send_to_documents_tool", "failed", Date.now() - step12Start, {
        error: err instanceof Error ? err.message : String(err),
        screenshotPath,
        metadata: { diagnostics },
      });
    }
  }

  return { estimateExcelPath, proposalPdfPath };
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Portfolio Actions (after webhook)
// ═══════════════════════════════════════════════════════════════

/**
 * Phase 2: Runs in the Portfolio context after the project has been created.
 * Triggered by the Procore webhook.
 */
export async function runPhase2PortfolioActions(
  page: Page,
  companyId: string,
  portfolioProjectId: string,
  result: PortfolioAutomationResult
): Promise<void> {
  result.portfolioProjectId = portfolioProjectId;

  // Set portfolio project stage to "Buy Out" via Procore API
  try {
    const { getAccessToken } = await import("../procore");
    const { fetchWithRateLimitRetry } = await import("../lib/rate-limit-tracker");
    const accessToken = await getAccessToken();
    const stagesRes = await fetchWithRateLimitRetry(
      `https://api.procore.com/rest/v1.0/companies/${companyId}/project_stages`,
      { headers: { Authorization: `Bearer ${accessToken}`, "Procore-Company-Id": companyId } },
      "procore"
    );
    if (stagesRes.ok) {
      const stages = await stagesRes.json() as Array<{ id: number; name: string }>;
      const buyOutStage = stages.find((s) => s.name === "Buy Out");
      if (buyOutStage) {
        const updateRes = await fetchWithRateLimitRetry(
          `https://api.procore.com/rest/v1.0/projects/${portfolioProjectId}?company_id=${companyId}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "Procore-Company-Id": companyId },
            body: JSON.stringify({ project: { project_stage_id: buyOutStage.id } }),
          },
          "procore"
        );
        if (updateRes.ok) {
          log(`[portfolio-auto] Set portfolio project ${portfolioProjectId} stage to "Buy Out"`, "playwright");
        } else {
          log(`[portfolio-auto] WARNING: Failed to set stage to Buy Out: ${updateRes.status}`, "playwright");
        }
      }
    }
  } catch (stageErr: any) {
    log(`[portfolio-auto] WARNING: Could not set portfolio stage to Buy Out: ${stageErr.message}`, "playwright");
  }

  const estimatingUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${portfolioProjectId}/tools/estimating/estimate`;

  const navStart = Date.now();
  try {
    await page.goto(estimatingUrl, { waitUntil: "load", timeout: 60000 });
    const portfolioEstimatingSpaSelectors = [
      'button.aid-actions, button:has-text("Actions")',
      ".aid-tab-title",
      ".aid-send-to-budget",
      ".aid-create-prime-contract",
    ];
    await waitForProcoreSpaLoaded(page, portfolioEstimatingSpaSelectors, "Portfolio Estimating");

    try {
      const estimatingTab = page.locator(SEL.portfolioEstimating.estimatingTab);
      if ((await estimatingTab.count()) > 0) {
        await estimatingTab.click({ timeout: 8000 });
        await randomDelay(3000, 5000);
      }
    } catch {
      /* May already be on the Estimating tab */
    }

    await logStep(page, result, "navigate_portfolio_estimating", "success", Date.now() - navStart, {
      metadata: { url: estimatingUrl },
    });
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "phase2-navigate");
    await logStep(page, result, "navigate_portfolio_estimating", "failed", Date.now() - navStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
    throw err;
  }

  const budgetStart = Date.now();
  try {
    // Poll for "Send to Budget" menu item — Procore needs time to initialize
    // financial tools (Budget, Prime Contract) after Add to Portfolio.
    // The WBS/cost code initialization runs async and can take 2-5 minutes.
    const BUDGET_POLL_MAX = 10; // 10 attempts
    const BUDGET_POLL_INTERVAL = 30000; // 30s between attempts
    let budgetMenuFound = false;
    let budgetAlreadySent = false;

    for (let attempt = 1; attempt <= BUDGET_POLL_MAX; attempt++) {
      await page.click(SEL.portfolioEstimating.actionsButton, { timeout: 10000 });
      await randomDelay(1000, 2000);

      const sendToBudgetItem = await page.$(SEL.portfolioEstimating.sendToBudget)
        || await page.$(SEL.portfolioEstimating.sendToBudgetFallback);

      if (sendToBudgetItem) {
        budgetMenuFound = true;
        log(`[phase2] Send to Budget menu item found (attempt ${attempt}/${BUDGET_POLL_MAX})`, "playwright");
        break;
      }

      // If Send to Budget is absent but Create Prime Contract exists → budget already sent
      const primeItem = await page.$(SEL.portfolioEstimating.createPrimeContract)
        || await page.$(SEL.portfolioEstimating.createPrimeContractFallback);
      if (primeItem) {
        budgetAlreadySent = true;
        log(`[phase2] Send to Budget not in menu but Create Prime Contract is — budget already sent, skipping`, "playwright");
        await page.keyboard.press("Escape");
        break;
      }

      await page.keyboard.press("Escape");
      if (attempt < BUDGET_POLL_MAX) {
        log(`[phase2] Send to Budget not available yet — financial tools initializing (attempt ${attempt}/${BUDGET_POLL_MAX}, retrying in ${BUDGET_POLL_INTERVAL / 1000}s)`, "playwright");
        await page.reload({ waitUntil: "load" }).catch(() => {});
        await randomDelay(3000, 5000);
        const estTab = await page.$(SEL.portfolioEstimating.estimatingTab) || await page.$('.aid-tab:has-text("Estimating")');
        if (estTab) await estTab.click();
        await randomDelay(2000, 3000);
        await new Promise((r) => setTimeout(r, BUDGET_POLL_INTERVAL));
      }
    }

    if (budgetAlreadySent) {
      await logStep(page, result, "send_to_budget", "skipped", Date.now() - budgetStart, {
        metadata: { reason: "Budget already sent" },
      });
    } else if (!budgetMenuFound) {
      throw new Error("Send to Budget menu item not available after polling — financial tools may not be initialized");
    } else {
      await clickMenuItem(
        page,
        SEL.portfolioEstimating.sendToBudget,
        SEL.portfolioEstimating.sendToBudgetFallback,
        "Send to Budget"
      );
      await randomDelay(2000, 4000);

      await waitForConfirmButtonEnabled(page, 30000);
      await page.click(SEL.confirmButton, { timeout: 10000 });
      await randomDelay(2000, 3000);
      await waitForModalToClose(page, 120000);
      await randomDelay(3000, 5000);

      await logStep(page, result, "send_to_budget", "success", Date.now() - budgetStart);
    }
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "phase2-send-to-budget");
    await logStep(page, result, "send_to_budget", "failed", Date.now() - budgetStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
    await page.keyboard.press("Escape");
    await randomDelay(1000, 2000);
  }

  const primeStart = Date.now();
  try {
    // Reload page after Send to Budget — "Create Prime Contract" is disabled until
    // the estimate is in budget and the page reflects the new state
    await page.reload({ waitUntil: "load" }).catch(() => {});
    await randomDelay(3000, 5000);
    const estTab = await page.$(SEL.portfolioEstimating.estimatingTab) || await page.$('.aid-tab:has-text("Estimating")');
    if (estTab) await estTab.click();
    await randomDelay(2000, 3000);

    await page.click(SEL.portfolioEstimating.actionsButton, { timeout: 10000 });
    await randomDelay(1000, 2000);

    // Check if Create Prime Contract exists in the menu at all
    const primeItemAny = await page.$(SEL.portfolioEstimating.createPrimeContract)
      || await page.$(SEL.portfolioEstimating.createPrimeContractFallback);

    if (!primeItemAny) {
      // Menu item completely absent → prime contract already created, skip
      log(`[phase2] Create Prime Contract not in Actions menu — already created, skipping`, "playwright");
      await page.keyboard.press("Escape");
      await logStep(page, result, "create_prime_contract", "skipped", Date.now() - primeStart, {
        metadata: { reason: "Prime contract already exists" },
      });
    } else {
      // Check if enabled; if disabled, wait and retry
      let primeMenuItem = await page.$(SEL.portfolioEstimating.createPrimeContract + ':not([aria-disabled="true"])');
      if (!primeMenuItem) {
        log(`[phase2] Create Prime Contract is disabled — waiting for budget sync`, "playwright");
        await page.keyboard.press("Escape");
        for (let attempt = 1; attempt <= 5; attempt++) {
          await new Promise((r) => setTimeout(r, 15000));
          await page.reload({ waitUntil: "load" }).catch(() => {});
          await randomDelay(3000, 5000);
          const tab = await page.$(SEL.portfolioEstimating.estimatingTab) || await page.$('.aid-tab:has-text("Estimating")');
          if (tab) await tab.click();
          await randomDelay(2000, 3000);
          await page.click(SEL.portfolioEstimating.actionsButton, { timeout: 10000 });
          await randomDelay(1000, 2000);
          primeMenuItem = await page.$(SEL.portfolioEstimating.createPrimeContract + ':not([aria-disabled="true"])');
          if (primeMenuItem) {
            log(`[phase2] Create Prime Contract enabled (attempt ${attempt})`, "playwright");
            break;
          }
          await page.keyboard.press("Escape");
        }
      }

      await clickMenuItem(
        page,
        SEL.portfolioEstimating.createPrimeContract,
        SEL.portfolioEstimating.createPrimeContractFallback,
        "Create Prime Contract"
      );
      await randomDelay(2000, 4000);

      await waitForConfirmButtonEnabled(page, 30000);
      await page.click(SEL.confirmButton, { timeout: 10000 });
      await randomDelay(2000, 3000);
      await waitForModalToClose(page, 120000);
      await randomDelay(3000, 5000);

      await logStep(page, result, "create_prime_contract", "success", Date.now() - primeStart);

      // Immediately sync prime contract amount to HubSpot (non-blocking)
      try {
        const { syncChangeOrdersToHubSpot } = await import("../change-order-sync");
        const syncResult = await syncChangeOrdersToHubSpot(portfolioProjectId);
        if (syncResult.success) {
          log(`[portfolio-auto] Prime contract amount synced to HubSpot: $${(syncResult.newAmount ?? 0).toLocaleString()} (deal ${syncResult.dealId})`, "playwright");
        } else {
          log(`[portfolio-auto] Prime contract amount sync skipped: ${syncResult.error}`, "playwright");
        }
      } catch (syncErr: any) {
        log(`[portfolio-auto] WARNING: Could not sync prime contract amount to HubSpot: ${syncErr.message}`, "playwright");
      }
    }
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "phase2-create-prime-contract");
    await logStep(page, result, "create_prime_contract", "failed", Date.now() - primeStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2.5: Scrape Bid Board Data
// ═══════════════════════════════════════════════════════════════

function deriveContractNumber(projectNumber: string | null): string | null {
  if (!projectNumber) return null;
  const parts = projectNumber.split("-");
  if (parts.length >= 4) {
    return `${parts[2]}-${parts[3]}-PC-01`;
  } else if (parts.length >= 3) {
    return `${parts[parts.length - 2]}-${parts[parts.length - 1]}-PC-01`;
  }
  return `${projectNumber}-PC-01`;
}

export async function scrapeBidBoardData(
  page: Page,
  bidboardProjectUrl: string,
  result: PortfolioAutomationResult,
  opts?: { companyId?: string; portfolioProjectId?: string }
): Promise<BidBoardScrapedData> {
  const scrapeStart = Date.now();
  const scrapedData: BidBoardScrapedData = {
    customerCompanyName: null,
    projectNumber: null,
    scopeOfWork: null,
    inclusions: [],
    exclusions: [],
  };

  try {
    await page.goto(bidboardProjectUrl, { waitUntil: "load", timeout: 60000 });
    const bidboardSpaSelectors = [
      ".aid-projBarOverview",
      ".aid-projBarEstimation",
      ".aid-tab",
      '[data-qa="ci-EllipsisVertical"]',
    ];
    await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board (scrape)");

    // Step A: Customer Company, Project Number
    // Scrape customer on current tab FIRST (page often lands on Estimating where customer is visible),
    // then try Overview tab if not found.

    const scrapeCustomerFromDOM = async (): Promise<string | null> => {
      // Strategy A: MUI list item — role in secondary text, company in div[style*="word-break"]
      try {
        const val = await page.evaluate(() => {
          const roles = ["Owner/Client", "General Contractor", "Subcontractor", "Sub-contractor", "Architect", "Engineer", "Developer", "Vendor"];
          // Find MuiListItem or li that contains a role label
          const listItems = document.querySelectorAll('.MuiListItem-root, li, [role="listitem"]');
          for (const li of listItems) {
            const liText = li.textContent || '';
            for (const role of roles) {
              if (liText.includes(role)) {
                // Look for company name in div[style*="word-break"] or MuiListItemText-primary
                const nameEl = li.querySelector('div[style*="word-break"], .MuiListItemText-primary div, .MuiListItemText-primary');
                const name = nameEl?.textContent?.trim();
                if (name && name !== role && !roles.includes(name) && name.length > 1 && name.length < 100) {
                  return name;
                }
              }
            }
          }
          return null;
        });
        if (val) return val;
      } catch { /* optional */ }

      // Strategy B: Input field (client_name / owner_name)
      try {
        const clientInput = page.locator(
          '[data-testid="client-name"], input[name="client_name"], #client_name, input[name="owner_name"], input[placeholder*="Client"], input[placeholder*="Owner"]'
        );
        if ((await clientInput.count()) > 0) {
          const val = await clientInput.first().inputValue().catch(() => "");
          if (val?.trim()) return val.trim();
        }
      } catch { /* optional */ }

      // Strategy C: Text nodes ending with role name (e.g. "Acme Corp Owner/Client")
      // Strategy D: Role label element, grab company from parent container
      try {
        const val = await page.evaluate(() => {
          const roles = ["Owner/Client", "General Contractor", "Subcontractor", "Sub-contractor", "Architect", "Engineer", "Developer", "Vendor"];

          const candidates = document.querySelectorAll('div[style*="word-break"], div, span');
          for (const el of candidates) {
            const directText =
              el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE
                ? el.childNodes[0].textContent?.trim()
                : null;
            if (!directText) continue;
            for (const role of roles) {
              if (directText.endsWith(role)) {
                return directText
                  .replace(new RegExp("\\s*" + role.replace("/", "\\/") + "\\s*$", "i"), "")
                  .trim();
              }
            }
          }

          for (const role of roles) {
            const roleEls = document.querySelectorAll('span, div, p');
            for (const el of roleEls) {
              const text = el.textContent?.trim();
              if (text === role || text === `(${role})`) {
                const container = el.closest('div[class]') ?? el.parentElement;
                if (container) {
                  const allText = container.textContent?.trim() ?? '';
                  const cleaned = allText.replace(role, '').replace(/[()]/g, '').trim();
                  if (cleaned && cleaned.length > 1 && cleaned.length < 100) {
                    return cleaned;
                  }
                }
              }
            }
          }

          return null;
        });
        if (val) return val;
      } catch { /* optional */ }

      return null;
    };

    // Try scraping on current tab first (often Estimating tab where customer is visible)
    scrapedData.customerCompanyName = await scrapeCustomerFromDOM();
    if (scrapedData.customerCompanyName) {
      log(`[portfolio-auto] Found customer on current tab: "${scrapedData.customerCompanyName}"`, "playwright");
    }

    // If not found, try Overview tab
    if (!scrapedData.customerCompanyName) {
      try {
        const overviewTab = page.locator(SEL.tabs.overview);
        if ((await overviewTab.count()) > 0) {
          await overviewTab.click({ timeout: 8000 });
          await randomDelay(2000, 3000);
        }
      } catch {
        /* Overview tab may not exist or already be active */
      }
      scrapedData.customerCompanyName = await scrapeCustomerFromDOM();
      if (scrapedData.customerCompanyName) {
        log(`[portfolio-auto] Found customer on Overview tab: "${scrapedData.customerCompanyName}"`, "playwright");
      }
    }

    if (!scrapedData.customerCompanyName) {
      log(`[portfolio-auto] Customer company not found on any tab`, "playwright");
    }

    try {
      const projectNumInput = page.locator('input[name="projectNumber"]');
      if ((await projectNumInput.count()) > 0) {
        scrapedData.projectNumber = await projectNumInput.inputValue().catch(() => null);
      }
    } catch {
      /* optional */
    }

    // Step B: Proposal tab — Inclusions, Exclusions, Scope of Work
    await page.click(SEL.tabs.proposal, { timeout: 10000 }).catch(() => {});
    await randomDelay(2000, 4000);

    const inclusionTextareas = page.locator(".aid-inclusions .aid-item textarea");
    const incCount = await inclusionTextareas.count();
    for (let i = 0; i < incCount; i++) {
      const text = await inclusionTextareas.nth(i).inputValue().catch(() => "");
      if (text?.trim()) scrapedData.inclusions.push(text.trim());
    }

    const exclusionTextareas = page.locator(".aid-exclusions .aid-item textarea");
    const excCount = await exclusionTextareas.count();
    for (let i = 0; i < excCount; i++) {
      const text = await exclusionTextareas.nth(i).inputValue().catch(() => "");
      if (text?.trim()) scrapedData.exclusions.push(text.trim());
    }

    const tinyFrames = page.locator("iframe.tox-edit-area__iframe");
    if ((await tinyFrames.count()) > 0) {
      const frame = await tinyFrames.first().elementHandle();
      const contentFrame = await frame?.contentFrame();
      if (contentFrame) {
        const bodyText = await contentFrame.locator("body#tinymce").textContent().catch(() => null);
        if (bodyText?.trim()) scrapedData.scopeOfWork = bodyText.trim();
      }
    }

    // Step C: Try Portfolio Estimating page for customer info and/or inclusions/exclusions
    const needsEstimatingScrape =
      scrapedData.inclusions.length === 0 &&
      scrapedData.exclusions.length === 0 &&
      !scrapedData.scopeOfWork;
    const needsCustomerScrape = !scrapedData.customerCompanyName;
    const canScrapeEstimating = opts?.companyId && opts?.portfolioProjectId;

    if ((needsEstimatingScrape || needsCustomerScrape) && canScrapeEstimating) {
      log("[portfolio-auto] Scraping from Portfolio Estimating page", "playwright");

      // First: scrape customer from Portfolio Estimating Overview (Details) tab
      if (needsCustomerScrape) {
        try {
          const detailsUrl = `https://us02.procore.com/webclients/host/companies/${opts!.companyId}/projects/${opts!.portfolioProjectId}/tools/estimating/details`;
          await page.goto(detailsUrl, { waitUntil: "load", timeout: 60000 });
          await waitForProcoreSpaLoaded(page, [".aid-customerInformation", ".aid-projBarDetails", ".aid-tab"], "Portfolio Estimating Details");

          const customerEl = page.locator('.aid-customerInformation .aid-listItem .MuiListItemText-primary div[style*="word-break"]').first();
          if ((await customerEl.count()) > 0) {
            const name = await customerEl.textContent().catch(() => null);
            if (name?.trim()) {
              scrapedData.customerCompanyName = name.trim();
              log(`[portfolio-auto] Found customer on Portfolio Estimating Overview: "${scrapedData.customerCompanyName}"`, "playwright");
            }
          }
        } catch (err: unknown) {
          log(`[portfolio-auto] Customer scrape from Estimating Overview failed: ${err instanceof Error ? err.message : String(err)}`, "playwright");
        }
      }

      // Second: scrape inclusions/exclusions/scope from Estimating tab
      if (!needsEstimatingScrape) {
        // Skip notes scrape — we only came here for the customer
      } else {
      const estimatingUrl = `https://us02.procore.com/webclients/host/companies/${opts!.companyId}/projects/${opts!.portfolioProjectId}/tools/estimating/estimate`;
      try {
        await page.goto(estimatingUrl, { waitUntil: "load", timeout: 60000 });
        const estimatingSpaSelectors = [
          'button.aid-actions, button:has-text("Actions")',
          ".aid-tab-title",
          ".aid-inclusions",
          ".aid-exclusions",
        ];
        await waitForProcoreSpaLoaded(page, estimatingSpaSelectors, "Portfolio Estimating (scrape)");

        // Expand Notes section if collapsed
        try {
          const notesToggle = page
            .locator('button:has-text("Notes"), [role="button"]:has-text("Notes")')
            .first();
          if ((await notesToggle.count()) > 0) {
            await notesToggle.click({ timeout: 5000 });
            await randomDelay(1000, 2000);
            log("[portfolio-auto] Expanded Notes section", "playwright");
          }
        } catch {
          /* Notes may already be expanded */
        }

        const incTextareas = page.locator(".aid-inclusions .aid-item textarea");
        const incCnt = await incTextareas.count();
        for (let i = 0; i < incCnt; i++) {
          const text = await incTextareas.nth(i).inputValue().catch(() => "");
          if (text?.trim()) scrapedData.inclusions.push(text.trim());
        }

        const excTextareas = page.locator(".aid-exclusions .aid-item textarea");
        const excCnt = await excTextareas.count();
        for (let i = 0; i < excCnt; i++) {
          const text = await excTextareas.nth(i).inputValue().catch(() => "");
          if (text?.trim()) scrapedData.exclusions.push(text.trim());
        }

        const scopeFrames = page.locator("iframe.tox-edit-area__iframe");
        if ((await scopeFrames.count()) > 0) {
          const frame = await scopeFrames.first().elementHandle();
          const contentFrame = await frame?.contentFrame();
          if (contentFrame) {
            const bodyText = await contentFrame.locator("body#tinymce").textContent().catch(() => null);
            if (bodyText?.trim()) scrapedData.scopeOfWork = bodyText.trim();
          }
        }
      } catch (err: unknown) {
        log(
          `[portfolio-auto] Estimating scrape fallback failed: ${err instanceof Error ? err.message : String(err)}`,
          "playwright"
        );
      }
      } // end else (needsEstimatingScrape)
    }

    log(`[portfolio-auto] Scraped Bid Board data summary:`, "playwright");
    log(`  Customer Company: ${scrapedData.customerCompanyName || "NOT FOUND"}`, "playwright");
    log(`  Project Number: ${scrapedData.projectNumber || "NOT FOUND"}`, "playwright");
    log(
      `  Scope of Work: ${scrapedData.scopeOfWork ? scrapedData.scopeOfWork.substring(0, 100) + "..." : "NOT FOUND"}`,
      "playwright"
    );
    log(
      `  Inclusions: ${scrapedData.inclusions.length} items${scrapedData.inclusions.length > 0 ? " (" + scrapedData.inclusions.map((i) => i.substring(0, 30)).join(", ") + ")" : ""}`,
      "playwright"
    );
    log(
      `  Exclusions: ${scrapedData.exclusions.length} items${scrapedData.exclusions.length > 0 ? " (" + scrapedData.exclusions.map((e) => e.substring(0, 30)).join(", ") + ")" : ""}`,
      "playwright"
    );

    await logStep(page, result, "scrape_bidboard_data", "success", Date.now() - scrapeStart, {
      metadata: {
        customerCompanyName: scrapedData.customerCompanyName,
        projectNumber: scrapedData.projectNumber,
        scopeOfWorkLength: scrapedData.scopeOfWork?.length || 0,
        inclusionsCount: scrapedData.inclusions.length,
        exclusionsCount: scrapedData.exclusions.length,
        scopeOfWorkPreview: scrapedData.scopeOfWork?.substring(0, 200),
        inclusionsPreview: scrapedData.inclusions.map((i) => i.substring(0, 50)),
        exclusionsPreview: scrapedData.exclusions.map((e) => e.substring(0, 50)),
      },
    });
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "scrape-bidboard-data");
    await logStep(page, result, "scrape_bidboard_data", "failed", Date.now() - scrapeStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }

  return scrapedData;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3A: Add Customer to Directory
// ═══════════════════════════════════════════════════════════════

export async function addCustomerToDirectory(
  page: Page,
  companyId: string,
  portfolioProjectId: string,
  customerCompanyName: string,
  result: PortfolioAutomationResult
): Promise<void> {
  const stepStart = Date.now();
  const dirUrl = `https://us02.procore.com/${portfolioProjectId}/project/directory/groups/users?page=1&per_page=150&search=&group_by=vendor.id&sort=vendor_name%2Cname`;

  try {
    await page.goto(dirUrl, { waitUntil: "load", timeout: 60000 });
    const directorySpaSelectors = [
      "#new-add-company-btn button",
      '[data-pendo="new-add-company-open-modal-button"]',
    ];
    await waitForProcoreSpaLoaded(page, directorySpaSelectors, "Project Directory");
    await randomDelay(3000, 4000);

    // Step 1: Click Add Company button
    await page.click('#new-add-company-btn button, [data-pendo="new-add-company-open-modal-button"]', {
      force: true,
      timeout: 10000,
    });
    log("[portfolio-auto] Clicked Add Company button", "playwright");
    await randomDelay(2000, 3000);

    // Step 2: Promo modal may appear — click "Get Started" if present
    try {
      const getStartedBtn = page
        .locator('button[data-a11y-skip="color-contrast"]:has(span:has-text("Get Started"))')
        .first();
      if ((await getStartedBtn.count()) > 0) {
        await getStartedBtn.click({ force: true, timeout: 5000 });
        log("[portfolio-auto] Clicked Get Started to dismiss promo modal", "playwright");
        await randomDelay(2000, 3000);
      }
    } catch {
      try {
        await page
          .locator('button:has(span:has-text("Get Started"))')
          .first()
          .click({ force: true, timeout: 3000 });
        log("[portfolio-auto] Clicked Get Started via broad selector", "playwright");
        await randomDelay(2000, 3000);
      } catch {
        log("[portfolio-auto] No Get Started button found — proceeding", "playwright");
      }
    }

    // Step 3: The "Add Company to Project" modal should now be open
    const modalSearchInput = page
      .locator('input[placeholder="Enter company name"], input[placeholder*="company name" i]')
      .first();
    await modalSearchInput.waitFor({ state: "visible", timeout: 15000 });
    await modalSearchInput.fill(customerCompanyName, { timeout: 5000 });
    log(`[portfolio-auto] Searched for company: ${customerCompanyName}`, "playwright");
    await randomDelay(3000, 4000);

    // Step 4: Click "Add to Project" next to the matching company result
    const addToProjectBtn = page.locator('button:has-text("Add to Project")').first();
    if ((await addToProjectBtn.count()) > 0 && (await addToProjectBtn.isVisible())) {
      await addToProjectBtn.click({ timeout: 8000 });
      log("[portfolio-auto] Clicked Add to Project", "playwright");
    } else {
      const createNewBtn = page.locator('button:has-text("Create New Company")').first();
      if ((await createNewBtn.count()) > 0 && (await createNewBtn.isVisible())) {
        await createNewBtn.click({ timeout: 8000 });
        log("[portfolio-auto] Clicked Create New Company", "playwright");
        await randomDelay(2000, 3000);
        const companyNameInput = page
          .locator('input[name="name"], input[placeholder*="Company Name" i]')
          .first();
        if ((await companyNameInput.count()) > 0) {
          await companyNameInput.fill(customerCompanyName, { timeout: 5000 });
        }
        await page
          .click('button:has-text("Save"), button:has-text("Create"), button[type="submit"]', {
            timeout: 10000,
          })
          .catch(() => {});
      } else {
        log("[portfolio-auto] No Add to Project or Create New Company button found", "playwright");
      }
    }

    await randomDelay(3000, 5000);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await logStep(page, result, "add_customer_to_directory", "success", Date.now() - stepStart);
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "add-customer-to-directory");
    await logStep(page, result, "add_customer_to_directory", "failed", Date.now() - stepStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3B: Edit Prime Contract
// ═══════════════════════════════════════════════════════════════

export async function editPrimeContract(
  page: Page,
  companyId: string,
  portfolioProjectId: string,
  scrapedData: BidBoardScrapedData,
  proposalPdfPath: string | null,
  result: PortfolioAutomationResult
): Promise<void> {
  const editStart = Date.now();
  const pcUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${portfolioProjectId}/tools/contracts/prime_contracts`;

  try {
    await page.goto(pcUrl, { waitUntil: "load", timeout: 60000 });
    const primeContractSpaSelectors = [
      ".ag-row-first a[href*='prime_contracts/']",
      'a[href*="prime_contracts/"]:not([href*="/edit"])',
    ];
    await waitForProcoreSpaLoaded(page, primeContractSpaSelectors, "Prime Contracts");

    const firstLink = page.locator(SEL.primeContract.firstRowLink).first();
    const fallback = page.locator(SEL.primeContract.fallbackLink).first();
    if ((await firstLink.count()) > 0) {
      await firstLink.click({ timeout: 10000 });
    } else {
      await fallback.click({ timeout: 10000 });
    }
    await randomDelay(3000, 5000);

    await page.click(SEL.primeContract.editButton, { timeout: 10000 });
    await randomDelay(3000, 5000);

    const contractNumber = deriveContractNumber(scrapedData.projectNumber);
    if (contractNumber) {
      const contractNumInput = page.locator(SEL.primeContract.contractNumInput);
      await contractNumInput.clear();
      await contractNumInput.fill(contractNumber);
      const actualValue = await contractNumInput.inputValue();
      if (actualValue !== contractNumber) {
        log(
          `[portfolio-auto] WARNING: Contract # fill mismatch. Expected: "${contractNumber}", Got: "${actualValue}"`,
          "playwright"
        );
      }
      await randomDelay(500, 1000);
    }

    if (scrapedData.customerCompanyName) {
      await page.click(SEL.primeContract.vendorField, { timeout: 8000 });
      await randomDelay(1000, 2000);
      const dropdownSearch = page.locator('input[placeholder="Search"]').last();
      if ((await dropdownSearch.count()) > 0) {
        await dropdownSearch.fill(scrapedData.customerCompanyName);
        await randomDelay(1000, 2000);
      }
      const option = page
        .locator('[role="option"]')
        .filter({ hasText: scrapedData.customerCompanyName })
        .first();
      await option.click({ timeout: 8000 });
      await randomDelay(500, 1000);
      const selectedVendor = await page.locator(SEL.primeContract.vendorField).textContent();
      log(`[portfolio-auto] Owner/Client set to: "${selectedVendor?.trim()}"`, "playwright");
    }

    await page.click(SEL.primeContract.contractorField, { timeout: 8000 });
    await randomDelay(1000, 2000);
    const contractorSearch = page.locator('input[placeholder="Search"]').last();
    if ((await contractorSearch.count()) > 0) {
      await contractorSearch.fill("T-Rock Construction");
      await randomDelay(1000, 2000);
    }
    const trockOption = page.locator('[role="option"]:has-text("T-Rock Construction")').first();
    await trockOption.click({ timeout: 8000 });
    await randomDelay(500, 1000);
    const selectedContractor = await page.locator(SEL.primeContract.contractorField).textContent();
    log(`[portfolio-auto] Contractor set to: "${selectedContractor?.trim()}"`, "playwright");

    if (scrapedData.scopeOfWork) {
      const descFrames = page.locator(SEL.primeContract.tinyMceFrame);
      const descFrame = descFrames.first();
      // Wait for TinyMCE iframe to appear and be ready
      await descFrame.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
      await randomDelay(3000, 5000); // TinyMCE needs extra time after modal dismissal
      const frameHandle = await descFrame.elementHandle();
      const descContent = await frameHandle?.contentFrame();
      if (descContent) {
        await descContent.waitForSelector("body#tinymce, body[contenteditable='true']", { state: 'visible', timeout: 20000 }).catch(() => {});
        try {
          await descContent.click("body#tinymce", { timeout: 15000 });
        } catch {
          // Fallback: click contenteditable body
          await descContent.click("body[contenteditable='true']", { timeout: 10000 }).catch(() => {});
        }
        const scope = scrapedData.scopeOfWork!;
        await descContent.fill("body#tinymce", scope).catch(async () => {
          // Fallback: type into the contenteditable body
          await descContent!.fill("body[contenteditable='true']", scope).catch(() => {});
        });
        log(`[portfolio-auto] Description/scope filled: ${scrapedData.scopeOfWork.slice(0, 80)}...`, "playwright");
      }
      await randomDelay(500, 1000);
    }

    if (proposalPdfPath) {
      try {
        await page.click('button:has-text("Attach Files")', { timeout: 8000 });
        await randomDelay(2000, 3000);
        // Scope file input to the MuiDialog modal to avoid strict mode violation
        // (page has multiple input[type="file"] — one inside modal, one on the form)
        const modalFileInput = page.locator('.MuiDialog-root input[type="file"], [role="dialog"] input[type="file"]').first();
        if ((await modalFileInput.count()) > 0) {
          await modalFileInput.setInputFiles(proposalPdfPath);
        } else {
          const [fileChooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10000 }),
            page.click('button:has-text("Upload Files"), button:has-text("Attach Files")'),
          ]);
          await fileChooser.setFiles(proposalPdfPath);
        }
        await randomDelay(3000, 5000);
        await page
          .click('button:has-text("Attach"):not(:has-text("Attach Files"))', { timeout: 15000 })
          .catch(() => {});
        await randomDelay(3000, 5000);
      } catch (err: unknown) {
        log(
          `[portfolio-auto] Failed to attach proposal PDF (best-effort): ${err instanceof Error ? err.message : String(err)}`,
          "playwright"
        );
        // Aggressively dismiss the Attach Files modal so it doesn't block TinyMCE/Save
        // Try Cancel button, Close button, then Escape (always attempt all)
        const modalCancel = page.locator('.MuiDialog-root button:has-text("Cancel"), [role="dialog"] button:has-text("Cancel"), [role="presentation"] button:has-text("Cancel")').first();
        if ((await modalCancel.count()) > 0) {
          await modalCancel.click({ timeout: 3000 }).catch(() => {});
          await randomDelay(500, 1000);
        }
        const closeBtn = page.locator('.MuiDialog-root [data-qa="ci-Close"], [role="dialog"] button[aria-label="Close"], button:has-text("Close")').first();
        if ((await closeBtn.count()) > 0) {
          await closeBtn.click({ timeout: 3000 }).catch(() => {});
          await randomDelay(500, 1000);
        }
        // Always press Escape twice to ensure any overlay is dismissed
        await page.keyboard.press("Escape").catch(() => {});
        await randomDelay(500, 800);
        await page.keyboard.press("Escape").catch(() => {});
        await randomDelay(500, 800);
        // Wait for any modal/overlay to be gone
        await page.waitForFunction(
          () => document.querySelectorAll('.MuiDialog-root, .MuiModal-root, [role="dialog"]').length === 0,
          { timeout: 5000 }
        ).catch(() => {});
        log("[portfolio-auto] Attach Files modal dismissed after PDF failure", "playwright");
      }
    }

    if (scrapedData.inclusions.length > 0) {
      await page.locator("text=Inclusions & Exclusions").scrollIntoViewIfNeeded().catch(() => {});
      await randomDelay(500, 1000);
      const allFrames = page.locator(SEL.primeContract.tinyMceFrame);
      const inclusionsFrame = allFrames.nth(1);
      await inclusionsFrame.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
      await randomDelay(1000, 2000);
      const inclHandle = await inclusionsFrame.elementHandle();
      const inclContent = await inclHandle?.contentFrame();
      if (inclContent) {
        await inclContent.waitForSelector("body#tinymce", { state: 'visible', timeout: 15000 }).catch(() => {});
        await inclContent.click("body#tinymce", { timeout: 10000 });
        await inclContent.fill("body#tinymce", scrapedData.inclusions.join("\n"));
      }
      await randomDelay(500, 1000);
    }

    if (scrapedData.exclusions.length > 0) {
      const allFrames = page.locator(SEL.primeContract.tinyMceFrame);
      const exclusionsFrame = allFrames.nth(2);
      await exclusionsFrame.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
      await randomDelay(1000, 2000);
      const exclHandle = await exclusionsFrame.elementHandle();
      const exclContent = await exclHandle?.contentFrame();
      if (exclContent) {
        await exclContent.waitForSelector("body#tinymce", { state: 'visible', timeout: 15000 }).catch(() => {});
        await exclContent.click("body#tinymce", { timeout: 10000 });
        await exclContent.fill("body#tinymce", scrapedData.exclusions.join("\n"));
      }
      await randomDelay(500, 1000);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await randomDelay(2000, 3000);
    await page.locator('button:has-text("Save"):not([disabled])').last().click({ timeout: 15000 });
    await randomDelay(3000, 5000);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    await logStep(page, result, "edit_prime_contract", "success", Date.now() - editStart);
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "edit-prime-contract");
    await logStep(page, result, "edit_prime_contract", "failed", Date.now() - editStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// PHASE 3: Full orchestrator
// ═══════════════════════════════════════════════════════════════

export async function runPhase3(
  companyId: string,
  portfolioProjectId: string,
  bidboardProjectUrl: string,
  proposalPdfPath: string | null,
  bidboardProjectId?: string,
  existingPage?: Page,
  customerName?: string
): Promise<PortfolioAutomationResult> {
  const result: PortfolioAutomationResult = {
    success: false,
    bidboardProjectId: bidboardProjectId || "unknown",
    portfolioProjectId,
    steps: [],
    startedAt: new Date(),
  };

  let page = existingPage;
  if (!page) {
    const { page: p, success, error } = await ensureLoggedIn();
    if (!success || !p) {
      result.error = error || "Failed to log in";
      result.completedAt = new Date();
      logAutomationSummary(result);
      return result;
    }
    page = p;
  }

  try {
    if (!(await ensureStillLoggedIn(page))) {
      const reauth = await ensureLoggedIn();
      if (!reauth.success || !reauth.page) {
        result.error = "Session expired and re-login failed";
        result.completedAt = new Date();
        logAutomationSummary(result);
        return result;
      }
      page = reauth.page;
    }

    const scrapedData = await scrapeBidBoardData(page, bidboardProjectUrl, result, {
      companyId,
      portfolioProjectId,
    });

    // Use HubSpot customer name as fallback if DOM scrape didn't find it
    if (!scrapedData.customerCompanyName && customerName) {
      scrapedData.customerCompanyName = customerName;
      log(`[portfolio-auto] Using HubSpot customer name as fallback: ${customerName}`, "playwright");
    }

    if (scrapedData.customerCompanyName) {
      await addCustomerToDirectory(
        page,
        companyId,
        portfolioProjectId,
        scrapedData.customerCompanyName,
        result
      );
    } else {
      await logStep(page, result, "add_customer_to_directory", "skipped", 0, {
        metadata: { reason: "No customer company name scraped" },
      });
    }

    await editPrimeContract(
      page,
      companyId,
      portfolioProjectId,
      scrapedData,
      proposalPdfPath,
      result
    );

    result.success = result.steps.every(
      (s) => s.status === "success" || s.status === "skipped"
    );
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.completedAt = new Date();

  await storage.createAuditLog({
    action: "portfolio_automation_phase3",
    entityType: "portfolio_project",
    entityId: portfolioProjectId,
    source: "automation",
    status: result.success ? "success" : "failed",
    details: {
      steps: result.steps.map((s) => ({ step: s.step, status: s.status, duration: s.duration })),
      duration: result.completedAt.getTime() - result.startedAt.getTime(),
    },
  });

  logAutomationSummary(result);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// FULL ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

export interface Phase1Output {
  result: PortfolioAutomationResult;
  estimateExcelPath: string | null;
  proposalPdfPath: string | null;
}

export interface Phase1RetryOptions {
  completedStepNames: string[];
  previousOutput?: {
    estimateExcelPath: string | null;
    proposalPdfPath: string | null;
  };
}

/**
 * Run the complete Phase 1 automation from a Bid Board project URL.
 * Phase 2 is triggered separately by the webhook handler.
 * On retry, pass completedStepNames and previousOutput to resume from the failed step.
 */
export async function runPhase1(
  bidboardProjectUrl: string,
  bidboardProjectId: string,
  retryOptions?: Phase1RetryOptions
): Promise<Phase1Output> {
  const result: PortfolioAutomationResult = {
    success: false,
    bidboardProjectId,
    steps: [],
    startedAt: new Date(),
  };
  let estimateExcelPath: string | null = null;
  let proposalPdfPath: string | null = null;

  try {
    const { page, success, error } = await ensureLoggedIn();
    if (!success || !page) {
      result.error = error || "Failed to log in";
      await logStep(page ?? null, result, "login", "failed", 0, { error: result.error });
      result.completedAt = new Date();
      logAutomationSummary(result);
      return { result, estimateExcelPath, proposalPdfPath };
    }
    await logStep(page, result, "login", "success", 0);

    const phase1Out = await runPhase1BidBoardActions(page, bidboardProjectUrl, result, retryOptions);
    estimateExcelPath = phase1Out.estimateExcelPath;
    proposalPdfPath = phase1Out.proposalPdfPath;

    // Non-critical steps that should not block success or trigger retries
    const NON_CRITICAL_STEPS = new Set(["send_to_documents_tool"]);
    result.success = result.steps.every(
      (s) => s.status === "success" || s.status === "skipped" || (s.status === "failed" && NON_CRITICAL_STEPS.has(s.step))
    );
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.completedAt = new Date();

  await storage.createAuditLog({
    action: "portfolio_automation_phase1",
    entityType: "bidboard_project",
    entityId: bidboardProjectId,
    source: "automation",
    status: result.success ? "success" : "failed",
    details: {
      steps: result.steps.map((s) => ({ step: s.step, status: s.status, duration: s.duration })),
      duration: result.completedAt.getTime() - result.startedAt.getTime(),
      proposalPdfPath,
      estimateExcelPath,
    },
  });

  logAutomationSummary(result);
  return { result, estimateExcelPath, proposalPdfPath };
}

export interface Phase2Input {
  proposalPdfPath?: string | null;
  bidboardProjectUrl?: string;
  customerName?: string;
}

/**
 * Run Phase 2 from a webhook-provided portfolio project ID.
 * Optionally runs Phase 3 after Phase 2 if proposalPdfPath and bidboardProjectUrl are provided.
 */
export async function runPhase2(
  companyId: string,
  portfolioProjectId: string,
  bidboardProjectId?: string,
  phase2Input?: Phase2Input
): Promise<PortfolioAutomationResult> {
  const result: PortfolioAutomationResult = {
    success: false,
    bidboardProjectId: bidboardProjectId || "unknown",
    portfolioProjectId,
    steps: [],
    startedAt: new Date(),
  };

  try {
    let page: Page | null = null;
    const { page: p, success, error } = await ensureLoggedIn();
    page = p;
    if (!success || !page) {
      result.error = error || "Failed to log in";
      await logStep(page, result, "login", "failed", 0, { error: result.error });
      result.completedAt = new Date();
      logAutomationSummary(result);
      return result;
    }
    await logStep(page, result, "login", "success", 0);

    if (!(await ensureStillLoggedIn(page))) {
      const reauth = await ensureLoggedIn();
      if (!reauth.success || !reauth.page) {
        result.error = "Session expired and re-login failed";
        result.completedAt = new Date();
        logAutomationSummary(result);
        return result;
      }
      page = reauth.page;
    }

    await runPhase2PortfolioActions(page, companyId, portfolioProjectId, result);

    result.success = result.steps.every(
      (s) => s.status === "success" || s.status === "skipped"
    );
    result.completedAt = new Date();

    await storage.createAuditLog({
      action: "portfolio_automation_phase2",
      entityType: "portfolio_project",
      entityId: portfolioProjectId,
      source: "webhook",
      status: result.success ? "success" : "failed",
      details: {
        steps: result.steps.map((s) => ({ step: s.step, status: s.status, duration: s.duration })),
        duration: result.completedAt.getTime() - result.startedAt.getTime(),
      },
    });

    logAutomationSummary(result);

    // Phase 3: always run after Phase 2 succeeds — construct missing inputs if needed
    if (result.success) {
      let bbUrl = phase2Input?.bidboardProjectUrl;
      // Construct bidboardProjectUrl if not provided but we have the project ID
      if (!bbUrl && bidboardProjectId && bidboardProjectId !== "unknown") {
        const mapping = await storage.getSyncMappingByBidboardProjectId(bidboardProjectId);
        const proposalId = (mapping?.metadata as any)?.proposalId;
        bbUrl = proposalId
          ? `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details?proposalId=${proposalId}`
          : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details`;
        log(`[portfolio-auto] Constructed bidboardProjectUrl for Phase 3: ${bbUrl}`, "playwright");
      }
      if (bbUrl) {
        const phase3Result = await runPhase3(
          companyId,
          portfolioProjectId,
          bbUrl,
          phase2Input?.proposalPdfPath ?? null,
          bidboardProjectId,
          page,
          phase2Input?.customerName
        );
        phase3Result.steps.forEach((s) => result.steps.push(s));
        result.success = result.success && phase3Result.success;
        result.completedAt = phase3Result.completedAt || result.completedAt;
        if (phase3Result.error) result.error = phase3Result.error;
      } else {
        log(`[portfolio-auto] WARNING: Cannot run Phase 3 — no bidboardProjectUrl and no bidboardProjectId to construct one`, "playwright");
      }
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = new Date();
    logAutomationSummary(result);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER FROM STAGE CHANGE (Excel export detection)
// ═══════════════════════════════════════════════════════════════

function normalizeKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Trigger portfolio automation when stage changes to "Sent to Production".
 * Called from bidboard-stage-sync after successful HubSpot stage update.
 */
export async function triggerPortfolioAutomationFromStageChange(
  projectName: string,
  projectNumber: string | null,
  customerName: string,
  hubspotDealId?: string
): Promise<PortfolioAutomationResult | null> {
  let mapping = null;

  // Try by HubSpot deal ID first (most reliable — passed from stage sync)
  if (hubspotDealId) {
    mapping = await storage.getSyncMappingByHubspotDealId(hubspotDealId);
  }

  if (!mapping && projectNumber?.trim()) {
    // Prefer mapping with bidboardProjectId — we need it for the URL
    const pnMapping = await storage.getSyncMappingByProcoreProjectNumber(projectNumber.trim());
    if (pnMapping?.bidboardProjectId) {
      mapping = pnMapping;
    } else {
      // Search all mappings with this project number for one that has a bidboardProjectId
      const allMappings = await storage.getSyncMappings();
      const withBidboard = allMappings.find(
        (m) => m.procoreProjectNumber === projectNumber.trim() && m.bidboardProjectId
      );
      mapping = withBidboard ?? pnMapping;
    }
  }

  // Try finding deal by project number — if found but no mapping exists, create one
  if (!mapping?.bidboardProjectId && projectNumber?.trim()) {
    const deal = await storage.getHubspotDealByProjectNumber(projectNumber.trim());
    if (deal?.hubspotId) {
      mapping = await storage.getSyncMappingByHubspotDealId(deal.hubspotId);
      if (!mapping) {
        // Auto-create mapping so the automation can proceed
        log(`[portfolio-auto] No sync mapping for deal ${deal.hubspotId} — creating from project number ${projectNumber}`, "playwright");
        mapping = await storage.createSyncMapping({
          hubspotDealId: deal.hubspotId,
          hubspotDealName: deal.dealName,
          bidboardProjectName: projectName,
          procoreProjectNumber: projectNumber.trim(),
          projectPhase: "bidboard",
          lastSyncAt: new Date(),
          lastSyncStatus: "auto_created_from_stage_sync",
          lastSyncDirection: "procore_to_hubspot",
        });
      }
    }
  }

  if (!mapping) {
    const name = projectName?.toString()?.trim() || "";
    const customer = customerName?.toString()?.trim() || "";
    const key = `${normalizeKey(name)}|||${normalizeKey(customer)}`;
    if (key && key !== "|||") {
      const all = await storage.getSyncMappings();
      const match = all.find((m) => {
        const n = normalizeKey(
          m.procoreProjectName || m.bidboardProjectName || m.hubspotDealName || ""
        );
        const mk = `${n}|||`;
        return (n && normalizeKey(name) === n) || mk === key;
      });
      mapping = match ?? null;
    }

    // Narrow fallback: "Copy of..." prefix match only (prevents false matches like "rfp tests" → "test")
    if (!mapping && name) {
        const nameLower = normalizeKey(name);
        const all = await storage.getSyncMappings();
        const partialMatch = all.find((m) => {
          const n = normalizeKey(
            m.procoreProjectName || m.bidboardProjectName || m.hubspotDealName || ""
          );
          if (!n || n.length < 3) return false;
          const shorter = nameLower.length <= n.length ? nameLower : n;
          const longer = nameLower.length > n.length ? nameLower : n;
          if (shorter.length / longer.length < 0.8) return false;
          return longer.includes(shorter);
        });
        mapping = partialMatch ?? null;
        if (mapping) {
          log(
            `[portfolio-auto] Found partial name match: "${projectName}" matched mapping for "${mapping.procoreProjectName || mapping.bidboardProjectName}"`,
            "playwright"
          );
        }
    }
  }

  // Only use bidboardProjectId — procoreProjectId is a portfolio project ID and cannot be used for BidBoard URLs
  const bidboardProjectId = mapping?.bidboardProjectId;

  const config = await storage.getAutomationConfig("procore_config");
  const companyId = (config?.value as { companyId?: string })?.companyId;
  if (!companyId) {
    log("[portfolio-auto] Procore company ID not configured — skipping automation", "playwright");
    return null;
  }

  if (!bidboardProjectId) {
    log(
      `[portfolio-auto] No bidboard project ID found for project (name: ${projectName}, #: ${projectNumber}, customer: ${customerName}) — skipping automation`,
      "playwright"
    );
    return null;
  }

  // Build URL with proposalId if available (Procore crashes without it)
  const proposalId = (mapping?.metadata as any)?.proposalId;
  const bidboardProjectUrl = proposalId
    ? `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details?proposalId=${proposalId}`
    : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}/details`;

  log(
    `[portfolio-auto] Triggering Phase 1 for bidboard project ${bidboardProjectId} (${projectName})${proposalId ? ` [proposalId=${proposalId}]` : ' [no proposalId]'}`,
    "playwright"
  );

  const { runPhase1WithRetry } = await import("../portfolio-automation-runner");
  const { result } = await runPhase1WithRetry(
    bidboardProjectUrl,
    bidboardProjectId,
    {
      projectName,
      projectNumber: projectNumber || undefined,
      customerName,
      triggerSource: "stage_sync",
    }
  );

  return result;
}
