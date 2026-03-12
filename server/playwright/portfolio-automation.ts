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
import { registerPendingPhase2 } from "../orchestrator/portfolio-orchestrator";

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
    actionsButton: "button.aid-actions",
    sendToBudget: ".aid-send-to-budget[role='menuitem']",
    sendToBudgetFallback: '[role="menuitem"] a:has-text("Send to Budget")',
    createPrimeContract: ".aid-create-prime-contract[role='menuitem']",
    createPrimeContractFallback: '[role="menuitem"] a:has-text("Create Prime Contract")',
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

async function waitForProcoreSpaLoaded(
  page: Page,
  selectors: string[],
  logContext: string,
  fallbackDelay: [number, number] = [15000, 18000]
): Promise<void> {
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

/**
 * Phase 1: Runs in the Bid Board context.
 * Steps: Add to Portfolio → Export Estimate → Export Proposal → Upload Docs → Send to Documents Tool
 */
export async function runPhase1BidBoardActions(
  page: Page,
  bidboardProjectUrl: string,
  result: PortfolioAutomationResult
): Promise<{ estimateExcelPath: string | null; proposalPdfPath: string | null }> {
  let estimateExcelPath: string | null = null;
  let proposalPdfPath: string | null = null;

  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  // ── Step 2: Click ellipsis → Add to Portfolio ─────────────
  const step2Start = Date.now();
  try {
    await page.goto(bidboardProjectUrl, { waitUntil: "load", timeout: 60000 });
    const bidboardSpaSelectors = [
      ".aid-projBarOverview",
      ".aid-projBarEstimation",
      ".aid-tab",
      '[data-qa="ci-EllipsisVertical"]',
    ];
    await waitForProcoreSpaLoaded(page, bidboardSpaSelectors, "Bid Board project");

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

    await logStep(page, result, "wait_portfolio_creation", "success", Date.now() - step4Start, {
      metadata: { url: currentUrl },
    });
  } catch (err: unknown) {
    const { screenshotPath, diagnostics } = await captureFailureContext(page, "step4-wait-portfolio");
    await logStep(page, result, "wait_portfolio_creation", "failed", Date.now() - step4Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath,
      metadata: { diagnostics },
    });
  }

  // ── Step 5-6: Go to Estimating tab → Export Excel ─────────
  const step6Start = Date.now();
  try {
    await page.click(SEL.tabs.estimating, { timeout: 10000 });
    await randomDelay(3000, 5000);

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

  // ── Step 7-8: Go to Proposal tab → Handle warning → Export PDF ──
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

  // ── Step 9-11: Go to Documents tab → Upload files ─────────
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
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 10000 }),
        page.click('button:has-text("Upload Files")'),
      ]);
      await fileChooser.setFiles(filesToUpload);

      const fileCount = filesToUpload.length;
      const fileCountText = fileCount === 1 ? "1 file selected" : `${fileCount} files selected`;
      await page.waitForSelector(`text="${fileCountText}"`, { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 1000);

      await page.waitForSelector(`${SEL.documents.attachButton}:not([disabled])`, { timeout: 15000 });
      await page.click(SEL.documents.attachButton, { timeout: 10000 });
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

  // ── Step 12: Send Drawings folder to Documents Tool ───────
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

  const estimatingUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${portfolioProjectId}/tools/estimating/estimate`;

  const navStart = Date.now();
  try {
    await page.goto(estimatingUrl, { waitUntil: "load", timeout: 60000 });
    const portfolioEstimatingSpaSelectors = [
      "button.aid-actions",
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
    await page.click(SEL.portfolioEstimating.actionsButton, { timeout: 10000 });
    await randomDelay(1000, 2000);

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
    await page.click(SEL.portfolioEstimating.actionsButton, { timeout: 10000 });
    await randomDelay(1000, 2000);

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
    return `${parts[2]}-${parts[3]}-PO-01`;
  } else if (parts.length >= 3) {
    return `${parts[parts.length - 2]}-${parts[parts.length - 1]}-PO-01`;
  }
  return `${projectNumber}-PO-01`;
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

    // Step A: Overview tab — Customer Company, Project Number
    try {
      scrapedData.customerCompanyName = await page.evaluate(() => {
        const roles = [
          "Owner/Client",
          "General Contractor",
          "Subcontractor",
          "Sub-contractor",
          "Architect",
          "Engineer",
          "Developer",
          "Vendor",
        ];
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
        return null;
      });
    } catch {
      /* optional */
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

    // Step C: If inclusions/exclusions/scope still empty, try Portfolio Estimating page (Notes section)
    const needsEstimatingScrape =
      scrapedData.inclusions.length === 0 &&
      scrapedData.exclusions.length === 0 &&
      !scrapedData.scopeOfWork &&
      opts?.companyId &&
      opts?.portfolioProjectId;

    if (needsEstimatingScrape) {
      log("[portfolio-auto] Bid Board Proposal empty — scraping from Portfolio Estimating Notes", "playwright");
      const estimatingUrl = `https://us02.procore.com/webclients/host/companies/${opts.companyId}/projects/${opts.portfolioProjectId}/tools/estimating/estimate`;
      try {
        await page.goto(estimatingUrl, { waitUntil: "load", timeout: 60000 });
        const estimatingSpaSelectors = [
          "button.aid-actions",
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
      const frameHandle = await descFrame.elementHandle();
      const descContent = await frameHandle?.contentFrame();
      if (descContent) {
        await descContent.click("body#tinymce");
        await descContent.fill("body#tinymce", scrapedData.scopeOfWork);
      }
      await randomDelay(500, 1000);
    }

    if (proposalPdfPath) {
      try {
        await page.click('button:has-text("Attach Files")', { timeout: 8000 });
        await randomDelay(2000, 3000);
        const fileInput = page.locator('input[type="file"]');
        if ((await fileInput.count()) > 0) {
          await fileInput.setInputFiles(proposalPdfPath);
        } else {
          const [fileChooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10000 }),
            page.click('button:has-text("Upload Files")'),
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
          `[portfolio-auto] Failed to attach proposal PDF: ${err instanceof Error ? err.message : String(err)}`,
          "playwright"
        );
      }
    }

    if (scrapedData.inclusions.length > 0) {
      await page.locator("text=Inclusions & Exclusions").scrollIntoViewIfNeeded().catch(() => {});
      await randomDelay(500, 1000);
      const allFrames = page.locator(SEL.primeContract.tinyMceFrame);
      const inclusionsFrame = allFrames.nth(1);
      const inclHandle = await inclusionsFrame.elementHandle();
      const inclContent = await inclHandle?.contentFrame();
      if (inclContent) {
        await inclContent.click("body#tinymce");
        await inclContent.fill("body#tinymce", scrapedData.inclusions.join("\n"));
      }
      await randomDelay(500, 1000);
    }

    if (scrapedData.exclusions.length > 0) {
      const allFrames = page.locator(SEL.primeContract.tinyMceFrame);
      const exclusionsFrame = allFrames.nth(2);
      const exclHandle = await exclusionsFrame.elementHandle();
      const exclContent = await exclHandle?.contentFrame();
      if (exclContent) {
        await exclContent.click("body#tinymce");
        await exclContent.fill("body#tinymce", scrapedData.exclusions.join("\n"));
      }
      await randomDelay(500, 1000);
    }

    await page.click(SEL.primeContract.saveButton, { timeout: 10000 });
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
  existingPage?: Page
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

/**
 * Run the complete Phase 1 automation from a Bid Board project URL.
 * Phase 2 is triggered separately by the webhook handler.
 */
export async function runPhase1(
  bidboardProjectUrl: string,
  bidboardProjectId: string
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

    const phase1Out = await runPhase1BidBoardActions(page, bidboardProjectUrl, result);
    estimateExcelPath = phase1Out.estimateExcelPath;
    proposalPdfPath = phase1Out.proposalPdfPath;

    result.success = result.steps.every(
      (s) => s.status === "success" || s.status === "skipped"
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

    // Phase 3: run if Phase 2 succeeded and we have required data
    if (
      result.success &&
      phase2Input?.bidboardProjectUrl &&
      phase2Input?.proposalPdfPath !== undefined
    ) {
      const phase3Result = await runPhase3(
        companyId,
        portfolioProjectId,
        phase2Input.bidboardProjectUrl,
        phase2Input.proposalPdfPath,
        bidboardProjectId,
        page
      );
      phase3Result.steps.forEach((s) => result.steps.push(s));
      result.success = result.success && phase3Result.success;
      result.completedAt = phase3Result.completedAt || result.completedAt;
      if (phase3Result.error) result.error = phase3Result.error;
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
  customerName: string
): Promise<PortfolioAutomationResult | null> {
  let mapping = null;

  if (projectNumber?.trim()) {
    mapping = await storage.getSyncMappingByProcoreProjectNumber(projectNumber.trim());
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
  }

  const bidboardProjectId = mapping?.bidboardProjectId || mapping?.procoreProjectId;
  if (!bidboardProjectId) {
    log(
      `[portfolio-auto] No sync mapping found for project (name: ${projectName}, #: ${projectNumber}, customer: ${customerName}) — skipping automation`,
      "playwright"
    );
    return null;
  }

  const config = await storage.getAutomationConfig("procore_config");
  const companyId = (config?.value as { companyId?: string })?.companyId;
  if (!companyId) {
    log("[portfolio-auto] Procore company ID not configured — skipping automation", "playwright");
    return null;
  }

  const bidboardProjectUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board/project/${bidboardProjectId}`;

  log(
    `[portfolio-auto] Triggering Phase 1 for bidboard project ${bidboardProjectId} (${projectName})`,
    "playwright"
  );

  const { result, proposalPdfPath, estimateExcelPath } = await runPhase1(bidboardProjectUrl, bidboardProjectId);

  if (result.completedAt) {
    registerPendingPhase2(bidboardProjectId, {
      bidboardProjectUrl,
      proposalPdfPath,
      estimateExcelPath,
    });
  }

  return result;
}
