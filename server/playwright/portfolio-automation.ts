/**
 * Portfolio Automation Module
 * ===========================
 *
 * Complete Playwright automation for the Bid Board → Portfolio workflow.
 * Two phases:
 *   Phase 1 (Bid Board context): Add to Portfolio, export docs, upload docs
 *   Phase 2 (Portfolio context): Send to Budget, Create Prime Contract
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
};

// ─── Types ──────────────────────────────────────────────────────

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

// ─── Step Logger ────────────────────────────────────────────────

async function logStep(
  result: PortfolioAutomationResult,
  step: string,
  status: "success" | "failed" | "skipped",
  duration: number,
  opts?: { error?: string; screenshotPath?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  const stepResult: StepResult = { step, status, duration, ...opts };
  result.steps.push(stepResult);

  await storage.createBidboardAutomationLog({
    projectId: result.bidboardProjectId,
    projectName: result.bidboardProjectId,
    action: `portfolio_automation:${step}`,
    status,
    details: { duration, ...opts?.metadata },
    errorMessage: opts?.error,
    screenshotPath: opts?.screenshotPath,
  });

  if (status === "failed") {
    log(`[portfolio-auto] FAILED step "${step}": ${opts?.error}`, "playwright");
  } else {
    log(`[portfolio-auto] ${status} step "${step}" (${duration}ms)`, "playwright");
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
    await randomDelay(3000, 5000);

    await page.keyboard.press("Escape");
    await randomDelay(500, 1000);

    const ellipsisButtons = page.locator(SEL.ellipsisButton);
    const count = await ellipsisButtons.count();
    if (count > 0) {
      await ellipsisButtons.nth(count - 1).click({ timeout: 8000 });
    } else {
      throw new Error("No ellipsis button found on page");
    }
    await randomDelay(1000, 2000);

    await clickMenuItem(
      page,
      SEL.addToPortfolio.menuItem,
      'li[role="menuitem"]:has-text("Add To Portfolio")',
      "Add to Portfolio"
    );
    await randomDelay(1000, 2000);

    await logStep(result, "click_add_to_portfolio", "success", Date.now() - step2Start);
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step2-add-to-portfolio-failed");
    await logStep(result, "click_add_to_portfolio", "failed", Date.now() - step2Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
    });
    throw err;
  }

  // ── Step 3: Confirm "Add To Portfolio" modal ──────────────
  const step3Start = Date.now();
  try {
    await waitForConfirmButtonEnabled(page, 30000);
    await page.click(SEL.confirmButton, { timeout: 10000 });
    await logStep(result, "confirm_add_to_portfolio", "success", Date.now() - step3Start);
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step3-confirm-portfolio-failed");
    await logStep(result, "confirm_add_to_portfolio", "failed", Date.now() - step3Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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

    await logStep(result, "wait_portfolio_creation", "success", Date.now() - step4Start, {
      metadata: { url: currentUrl },
    });
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step4-wait-portfolio-failed");
    await logStep(result, "wait_portfolio_creation", "failed", Date.now() - step4Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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

    await logStep(result, "export_estimate_excel", "success", Date.now() - step6Start, {
      metadata: { filePath: estimateExcelPath },
    });
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step6-export-estimate-failed");
    await logStep(result, "export_estimate_excel", "failed", Date.now() - step6Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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

    await logStep(result, "export_proposal_pdf", "success", Date.now() - step8Start, {
      metadata: { filePath: proposalPdfPath },
    });
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step8-export-proposal-failed");
    await logStep(result, "export_proposal_pdf", "failed", Date.now() - step8Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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
      const fileInput = await page.$(SEL.documents.fileInput);
      if (fileInput) {
        await fileInput.setInputFiles(filesToUpload);
      } else {
        const uploadFilesButton = page.locator('button:has-text("Upload Files")');
        if ((await uploadFilesButton.count()) > 0) {
          const [fileChooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 10000 }),
            uploadFilesButton.click(),
          ]);
          await fileChooser.setFiles(filesToUpload);
        } else {
          throw new Error("Could not find file input or Upload Files button in dialog");
        }
      }

      await randomDelay(3000, 5000);
      await page.click(SEL.documents.attachButton, { timeout: 30000 });
      await randomDelay(3000, 5000);
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await randomDelay(2000, 3000);

      await logStep(result, "upload_documents", "success", Date.now() - step11Start, {
        metadata: { filesUploaded: filesToUpload.length },
      });
    } else {
      await logStep(result, "upload_documents", "skipped", Date.now() - step11Start, {
        metadata: { reason: "No files to upload" },
      });
    }
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step11-upload-docs-failed");
    await logStep(result, "upload_documents", "failed", Date.now() - step11Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
    });
  }

  // ── Step 12: Send Drawings folder to Documents Tool ───────
  const step12Start = Date.now();
  try {
    const folderEllipsisButtons = page.locator('.aid-menuItem [data-qa="ci-EllipsisVertical"]');
    let clicked = false;
    if ((await folderEllipsisButtons.count()) > 0) {
      await folderEllipsisButtons.first().click({ timeout: 8000 });
      clicked = true;
    } else {
      const drawingsRow = page
        .locator('text="Drawings"')
        .locator("..")
        .locator('[data-qa="ci-EllipsisVertical"]');
      if ((await drawingsRow.count()) > 0) {
        await drawingsRow.first().click({ timeout: 8000 });
        clicked = true;
      } else {
        const allEllipsis = page.locator('[data-qa="ci-EllipsisVertical"]');
        if ((await allEllipsis.count()) > 1) {
          await allEllipsis.first().click({ timeout: 8000 });
          clicked = true;
        }
      }
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

    await logStep(result, "send_to_documents_tool", "success", Date.now() - step12Start);
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "step12-send-docs-tool-failed");
    await logStep(result, "send_to_documents_tool", "failed", Date.now() - step12Start, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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
    await randomDelay(5000, 8000);

    try {
      const estimatingTab = page.locator(SEL.portfolioEstimating.estimatingTab);
      if ((await estimatingTab.count()) > 0) {
        await estimatingTab.click({ timeout: 8000 });
        await randomDelay(3000, 5000);
      }
    } catch {
      /* May already be on the Estimating tab */
    }

    await logStep(result, "navigate_portfolio_estimating", "success", Date.now() - navStart, {
      metadata: { url: estimatingUrl },
    });
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "phase2-navigate-failed");
    await logStep(result, "navigate_portfolio_estimating", "failed", Date.now() - navStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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

    await logStep(result, "send_to_budget", "success", Date.now() - budgetStart);
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "phase2-send-to-budget-failed");
    await logStep(result, "send_to_budget", "failed", Date.now() - budgetStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
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

    await logStep(result, "create_prime_contract", "success", Date.now() - primeStart);
  } catch (err: unknown) {
    const screenshot = await takeScreenshot(page, "phase2-create-prime-contract-failed");
    await logStep(result, "create_prime_contract", "failed", Date.now() - primeStart, {
      error: err instanceof Error ? err.message : String(err),
      screenshotPath: screenshot,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// FULL ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Run the complete Phase 1 automation from a Bid Board project URL.
 * Phase 2 is triggered separately by the webhook handler.
 */
export async function runPhase1(
  bidboardProjectUrl: string,
  bidboardProjectId: string
): Promise<PortfolioAutomationResult> {
  const result: PortfolioAutomationResult = {
    success: false,
    bidboardProjectId,
    steps: [],
    startedAt: new Date(),
  };

  try {
    const { page, success, error } = await ensureLoggedIn();
    if (!success || !page) {
      result.error = error || "Failed to log in";
      await logStep(result, "login", "failed", 0, { error: result.error });
      return result;
    }
    await logStep(result, "login", "success", 0);

    await runPhase1BidBoardActions(page, bidboardProjectUrl, result);

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
    },
  });

  return result;
}

/**
 * Run Phase 2 from a webhook-provided portfolio project ID.
 */
export async function runPhase2(
  companyId: string,
  portfolioProjectId: string,
  bidboardProjectId?: string
): Promise<PortfolioAutomationResult> {
  const result: PortfolioAutomationResult = {
    success: false,
    bidboardProjectId: bidboardProjectId || "unknown",
    portfolioProjectId,
    steps: [],
    startedAt: new Date(),
  };

  try {
    const { page, success, error } = await ensureLoggedIn();
    if (!success || !page) {
      result.error = error || "Failed to log in";
      await logStep(result, "login", "failed", 0, { error: result.error });
      return result;
    }
    await logStep(result, "login", "success", 0);

    await runPhase2PortfolioActions(page, companyId, portfolioProjectId, result);

    result.success = result.steps.every(
      (s) => s.status === "success" || s.status === "skipped"
    );
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

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

  const result = await runPhase1(bidboardProjectUrl, bidboardProjectId);

  if (result.completedAt) {
    registerPendingPhase2(bidboardProjectId);
  }

  return result;
}
