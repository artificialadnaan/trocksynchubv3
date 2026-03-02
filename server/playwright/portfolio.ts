/**
 * Playwright Portfolio Module
 * ===========================
 * 
 * This module handles browser automation for Procore Portfolio (Active Projects).
 * Portfolio is where T-Rock manages awarded/active construction projects.
 * 
 * Project Lifecycle Transition:
 * When a project wins in BidBoard (stage "Sent to production"), it transitions
 * to Portfolio. This module automates that transition and subsequent operations.
 * 
 * Key Operations:
 * 
 * 1. BidBoard → Portfolio Transition:
 *    - Click "Send to Portfolio" button in BidBoard
 *    - Verify project appears in Portfolio
 *    - Update sync mapping with portfolio project ID
 * 
 * 2. Directory Management:
 *    - Add contacts to project directory
 *    - Sync client/vendor information
 * 
 * 3. Estimate Export:
 *    - Export estimate as CSV/Excel
 *    - Import estimate into project budget
 * 
 * 4. Full Portfolio Workflow:
 *    - Combines all above steps into one automated workflow
 *    - Sends kickoff emails to project team
 * 
 * Key Functions:
 * - runPortfolioTransition(): Transition project from BidBoard to Portfolio
 * - runFullPortfolioWorkflow(): Complete post-award workflow
 * - addContactToDirectory(): Add person to project directory
 * - exportEstimateToCsv(): Download estimate as CSV
 * - importEstimateToBudget(): Import estimate into budget tool
 * - sendToPortfolio(): Click send to portfolio button
 * 
 * URL Patterns:
 * - Portfolio Project: /projects/{projectId}
 * - Project Directory: /projects/{projectId}/directory
 * - Project Budget: /projects/{projectId}/budget
 * 
 * @module playwright/portfolio
 */

import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { PROCORE_SELECTORS, getPortfolioProjectUrl } from "./selectors";
import { randomDelay, takeScreenshot, withRetry } from "./browser";
import { navigateToProject } from "./bidboard";
import { log } from "../index";
import { storage } from "../storage";
import { getProjectTeamMembers, fetchProcoreProjectDetail } from "../procore";
import { sendKickoffEmails } from "../email-notifications";

/** Result of adding contact to project directory */
export interface DirectoryAddResult {
  success: boolean;
  portfolioProjectId: string;
  error?: string;
  screenshotPath?: string;
}

export interface PortfolioTransitionResult {
  success: boolean;
  bidboardProjectId: string;
  portfolioProjectId?: string;
  error?: string;
  screenshotPath?: string;
}

export interface EstimateData {
  totalAmount: number;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  inclusions?: string;
  exclusions?: string;
  scopeOfWork?: string;
}

async function getCompanyId(): Promise<string | null> {
  const config = await storage.getAutomationConfig("procore_config");
  return (config?.value as any)?.companyId || null;
}

async function isSandbox(): Promise<boolean> {
  const credentials = await storage.getAutomationConfig("procore_browser_credentials");
  return (credentials?.value as any)?.sandbox || false;
}

async function logPortfolioAction(
  projectId: string,
  action: string,
  status: "success" | "failed",
  details?: Record<string, any>,
  errorMessage?: string,
  screenshotPath?: string
): Promise<void> {
  await storage.createBidboardAutomationLog({
    projectId,
    action,
    status,
    details,
    errorMessage,
    screenshotPath,
  });
}

export async function sendToPortfolio(
  page: Page,
  bidboardProjectId: string
): Promise<PortfolioTransitionResult> {
  const result: PortfolioTransitionResult = {
    success: false,
    bidboardProjectId,
  };
  
  try {
    // Navigate to the BidBoard project
    await navigateToProject(page, bidboardProjectId);
    await randomDelay(2000, 3000);
    
    // Look for "Send to Portfolio" button
    const sendButton = await page.$(PROCORE_SELECTORS.bidboard.sendToPortfolioButton);
    
    if (!sendButton) {
      result.error = "Send to Portfolio button not found";
      result.screenshotPath = await takeScreenshot(page, `portfolio-no-button-${bidboardProjectId}`);
      await logPortfolioAction(bidboardProjectId, "send_to_portfolio", "failed", {}, result.error, result.screenshotPath);
      return result;
    }
    
    // Click the button
    await sendButton.click();
    await randomDelay(1000, 2000);
    
    // Handle confirmation dialog if present
    const confirmButton = await page.$(PROCORE_SELECTORS.common.confirmButton);
    if (confirmButton) {
      await confirmButton.click();
      await randomDelay(2000, 3000);
    }
    
    // Wait for the transition to complete
    await page.waitForLoadState("networkidle");
    
    // Check for success - look for Portfolio project URL or success message
    const currentUrl = page.url();
    const portfolioMatch = currentUrl.match(/\/projects?\/(\d+)/);
    
    if (portfolioMatch) {
      result.portfolioProjectId = portfolioMatch[1];
      result.success = true;
      
      await logPortfolioAction(
        bidboardProjectId,
        "send_to_portfolio",
        "success",
        { portfolioProjectId: result.portfolioProjectId }
      );
      
      log(`Successfully sent project ${bidboardProjectId} to Portfolio (ID: ${result.portfolioProjectId})`, "playwright");
    } else {
      // Check for success toast or message
      const toast = await page.$(PROCORE_SELECTORS.common.toast);
      const toastText = toast ? await toast.textContent() : null;
      
      if (toastText?.toLowerCase().includes("success") || toastText?.toLowerCase().includes("created")) {
        // Try to extract portfolio project ID from current URL
        const currentUrl = page.url();
        const urlMatch = currentUrl.match(/\/projects\/(\d+)/);
        if (urlMatch) {
          result.portfolioProjectId = urlMatch[1];
        }
        
        if (result.portfolioProjectId) {
          result.success = true;
          await logPortfolioAction(bidboardProjectId, "send_to_portfolio", "success", { 
            portfolioProjectId: result.portfolioProjectId,
            message: toastText 
          });
          log(`Project ${bidboardProjectId} sent to Portfolio (ID: ${result.portfolioProjectId}, confirmation: ${toastText})`, "playwright");
        } else {
          // Success toast but no project ID - workflow cannot continue
          result.success = false;
          result.error = "Portfolio project created but ID could not be extracted from URL";
          result.screenshotPath = await takeScreenshot(page, `portfolio-no-id-${bidboardProjectId}`);
          await logPortfolioAction(bidboardProjectId, "send_to_portfolio", "partial", { message: toastText }, result.error, result.screenshotPath);
          log(`Project ${bidboardProjectId} sent to Portfolio but ID extraction failed`, "playwright");
        }
      } else {
        result.error = "Portfolio transition did not complete as expected";
        result.screenshotPath = await takeScreenshot(page, `portfolio-unknown-${bidboardProjectId}`);
        await logPortfolioAction(bidboardProjectId, "send_to_portfolio", "failed", {}, result.error, result.screenshotPath);
      }
    }
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.screenshotPath = await takeScreenshot(page, `portfolio-error-${bidboardProjectId}`);
    await logPortfolioAction(bidboardProjectId, "send_to_portfolio", "failed", {}, result.error, result.screenshotPath);
    log(`Error sending project to Portfolio: ${result.error}`, "playwright");
  }
  
  return result;
}

export async function navigateToPortfolioProject(
  page: Page,
  portfolioProjectId: string
): Promise<boolean> {
  const sandbox = await isSandbox();
  const projectUrl = getPortfolioProjectUrl(portfolioProjectId, sandbox);
  
  log(`Navigating to Portfolio project: ${projectUrl}`, "playwright");
  await page.goto(projectUrl, { waitUntil: "networkidle" });
  
  await randomDelay(2000, 3000);
  
  // Verify we're on the project page
  try {
    await page.waitForSelector(PROCORE_SELECTORS.portfolio.container, { timeout: 10000 });
    return true;
  } catch {
    const screenshotPath = await takeScreenshot(page, `portfolio-nav-failed-${portfolioProjectId}`);
    log(`Failed to navigate to Portfolio project. Screenshot: ${screenshotPath}`, "playwright");
    return false;
  }
}

export async function extractEstimateData(page: Page, bidboardProjectId: string): Promise<EstimateData | null> {
  try {
    await navigateToProject(page, bidboardProjectId);
    
    // Click on Estimate tab
    const estimateTab = await page.$(PROCORE_SELECTORS.bidboard.estimateTab);
    if (estimateTab) {
      await estimateTab.click();
      await randomDelay(2000, 3000);
    }
    
    const estimate: EstimateData = {
      totalAmount: 0,
      lineItems: [],
    };
    
    // Get total amount
    const totalElement = await page.$(PROCORE_SELECTORS.estimate.totalAmount);
    if (totalElement) {
      const totalText = await totalElement.textContent();
      const numericValue = totalText?.replace(/[^0-9.-]/g, "");
      estimate.totalAmount = parseFloat(numericValue || "0");
    }
    
    // Get line items
    const lineItemRows = await page.$$(`${PROCORE_SELECTORS.estimate.lineItems} tr`);
    for (const row of lineItemRows) {
      const cells = await row.$$("td");
      if (cells.length >= 4) {
        const description = await cells[0].textContent();
        const quantity = await cells[1].textContent();
        const unitPrice = await cells[2].textContent();
        const total = await cells[3].textContent();
        
        if (description) {
          estimate.lineItems.push({
            description: description.trim(),
            quantity: parseFloat(quantity?.replace(/[^0-9.-]/g, "") || "1"),
            unitPrice: parseFloat(unitPrice?.replace(/[^0-9.-]/g, "") || "0"),
            total: parseFloat(total?.replace(/[^0-9.-]/g, "") || "0"),
          });
        }
      }
    }
    
    // Get inclusions
    const inclusionsElement = await page.$(PROCORE_SELECTORS.estimate.inclusionsSection);
    if (inclusionsElement) {
      estimate.inclusions = (await inclusionsElement.textContent())?.trim();
    }
    
    // Get exclusions
    const exclusionsElement = await page.$(PROCORE_SELECTORS.estimate.exclusionsSection);
    if (exclusionsElement) {
      estimate.exclusions = (await exclusionsElement.textContent())?.trim();
    }
    
    // Get scope of work
    const scopeElement = await page.$(PROCORE_SELECTORS.estimate.scopeOfWork);
    if (scopeElement) {
      estimate.scopeOfWork = (await scopeElement.textContent())?.trim();
    }
    
    log(`Extracted estimate data from project ${bidboardProjectId}: $${estimate.totalAmount}`, "playwright");
    return estimate;
  } catch (error) {
    log(`Error extracting estimate data: ${error}`, "playwright");
    return null;
  }
}

export async function exportEstimateToCsv(page: Page, bidboardProjectId: string): Promise<string | null> {
  try {
    await navigateToProject(page, bidboardProjectId);
    
    // Click on Estimate tab
    const estimateTab = await page.$(PROCORE_SELECTORS.bidboard.estimateTab);
    if (estimateTab) {
      await estimateTab.click();
      await randomDelay(2000, 3000);
    }
    
    // Click export button
    const exportButton = await page.$(PROCORE_SELECTORS.estimate.exportButton);
    if (!exportButton) {
      log("Estimate export button not found", "playwright");
      return null;
    }
    
    // First click to open dropdown menu (if any)
    await exportButton.click();
    await randomDelay(500, 1000);
    
    // Check if CSV option appears in dropdown
    const csvOption = await page.$(PROCORE_SELECTORS.estimate.exportCsvOption);
    if (csvOption) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        csvOption.click(),
      ]);
      
      const downloadPath = await download.path();
      log(`Estimate CSV downloaded to: ${downloadPath}`, "playwright");
      return downloadPath;
    } else {
      // No dropdown - button triggers direct download
      // Re-click with download listener since initial click may have only opened a menu
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exportButton.click(),
      ]);
      
      const downloadPath = await download.path();
      log(`Estimate CSV downloaded directly to: ${downloadPath}`, "playwright");
      return downloadPath;
    }
  } catch (error) {
    log(`Error exporting estimate CSV: ${error}`, "playwright");
    return null;
  }
}

export async function runPortfolioTransition(bidboardProjectId: string): Promise<PortfolioTransitionResult> {
  const { page, success, error } = await ensureLoggedIn();
  
  if (!success) {
    return {
      success: false,
      bidboardProjectId,
      error: error || "Failed to log in",
    };
  }
  
  return await withRetry(
    () => sendToPortfolio(page, bidboardProjectId),
    2,
    3000
  );
}

// ============================================
// Budget and Prime Contract Automation
// ============================================

export interface BudgetImportResult {
  success: boolean;
  portfolioProjectId: string;
  error?: string;
  screenshotPath?: string;
}

export interface PrimeContractResult {
  success: boolean;
  portfolioProjectId: string;
  contractId?: string;
  error?: string;
  screenshotPath?: string;
}

export async function importEstimateToBudget(
  page: Page,
  portfolioProjectId: string,
  estimateCsvPath: string
): Promise<BudgetImportResult> {
  const result: BudgetImportResult = {
    success: false,
    portfolioProjectId,
  };
  
  try {
    // Navigate to Portfolio project
    const navigated = await navigateToPortfolioProject(page, portfolioProjectId);
    if (!navigated) {
      result.error = "Failed to navigate to Portfolio project";
      return result;
    }
    
    // Click on Budget tab
    const budgetTab = await page.$(PROCORE_SELECTORS.portfolio.budgetTab);
    if (budgetTab) {
      await budgetTab.click();
      await randomDelay(2000, 3000);
    } else {
      result.error = "Budget tab not found";
      result.screenshotPath = await takeScreenshot(page, `budget-no-tab-${portfolioProjectId}`);
      return result;
    }
    
    // Click Import button
    const importButton = await page.$(PROCORE_SELECTORS.budget.importButton);
    if (!importButton) {
      result.error = "Budget import button not found";
      result.screenshotPath = await takeScreenshot(page, `budget-no-import-${portfolioProjectId}`);
      return result;
    }
    
    await importButton.click();
    await randomDelay(1000, 2000);
    
    // Upload file
    const fileInput = await page.$(PROCORE_SELECTORS.budget.fileInput);
    if (fileInput) {
      await fileInput.setInputFiles(estimateCsvPath);
      await randomDelay(2000, 3000);
    }
    
    // Confirm import
    const confirmButton = await page.$(PROCORE_SELECTORS.budget.confirmImport);
    if (confirmButton) {
      await confirmButton.click();
      await randomDelay(3000, 5000);
    }
    
    // Wait for import to complete
    await page.waitForLoadState("networkidle");
    
    // Check for success or error toast
    const toast = await page.$(PROCORE_SELECTORS.common.toast);
    const toastText = toast ? (await toast.textContent())?.toLowerCase() : null;
    
    if (toastText?.includes("success") || toastText?.includes("imported")) {
      result.success = true;
      await logPortfolioAction(portfolioProjectId, "import_to_budget", "success", {});
      log(`Successfully imported estimate to Budget for project ${portfolioProjectId}`, "playwright");
    } else if (toastText?.includes("error") || toastText?.includes("failed") || toastText?.includes("invalid")) {
      result.success = false;
      result.error = `Import failed: ${toastText}`;
      result.screenshotPath = await takeScreenshot(page, `budget-import-failed-${portfolioProjectId}`);
      await logPortfolioAction(portfolioProjectId, "import_to_budget", "failed", {}, result.error, result.screenshotPath);
      log(`Budget import failed for project ${portfolioProjectId}: ${toastText}`, "playwright");
    } else {
      // No confirmation toast - do not assume success
      result.success = false;
      result.error = "Import completed without confirmation. Manual verification required.";
      result.screenshotPath = await takeScreenshot(page, `budget-no-confirmation-${portfolioProjectId}`);
      await logPortfolioAction(portfolioProjectId, "import_to_budget", "uncertain", { message: "No confirmation toast received" });
      log(`Budget import uncertain for project ${portfolioProjectId}: no confirmation received`, "playwright");
    }
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.screenshotPath = await takeScreenshot(page, `budget-error-${portfolioProjectId}`);
    await logPortfolioAction(portfolioProjectId, "import_to_budget", "failed", {}, result.error, result.screenshotPath);
    log(`Error importing to Budget: ${result.error}`, "playwright");
  }
  
  return result;
}

export async function createPrimeContract(
  page: Page,
  portfolioProjectId: string,
  estimateData: EstimateData,
  clientData?: { companyName?: string; contactName?: string }
): Promise<PrimeContractResult> {
  const result: PrimeContractResult = {
    success: false,
    portfolioProjectId,
  };
  
  try {
    // Navigate to Portfolio project
    const navigated = await navigateToPortfolioProject(page, portfolioProjectId);
    if (!navigated) {
      result.error = "Failed to navigate to Portfolio project";
      return result;
    }
    
    // Click on Prime Contract tab
    const primeContractTab = await page.$(PROCORE_SELECTORS.portfolio.primeContractTab);
    if (primeContractTab) {
      await primeContractTab.click();
      await randomDelay(2000, 3000);
    } else {
      result.error = "Prime Contract tab not found";
      result.screenshotPath = await takeScreenshot(page, `contract-no-tab-${portfolioProjectId}`);
      return result;
    }
    
    // Click Create button
    const createButton = await page.$(PROCORE_SELECTORS.primeContract.createButton);
    if (createButton) {
      await createButton.click();
      await randomDelay(1000, 2000);
    }
    
    // Fill contract fields
    
    // Client name
    if (clientData?.companyName) {
      const clientNameInput = await page.$(PROCORE_SELECTORS.primeContract.clientNameInput);
      if (clientNameInput) {
        await clientNameInput.fill(clientData.companyName);
        await randomDelay(300, 500);
      }
    }
    
    // Contract amount from estimate
    const amountInput = await page.$(PROCORE_SELECTORS.primeContract.contractAmountInput);
    if (amountInput) {
      await amountInput.fill(estimateData.totalAmount.toString());
      await randomDelay(300, 500);
    }
    
    // Scope of work
    if (estimateData.scopeOfWork) {
      const scopeInput = await page.$(PROCORE_SELECTORS.primeContract.scopeInput);
      if (scopeInput) {
        await scopeInput.fill(estimateData.scopeOfWork);
        await randomDelay(300, 500);
      }
    }
    
    // Inclusions
    if (estimateData.inclusions) {
      const inclusionsInput = await page.$(PROCORE_SELECTORS.primeContract.inclusionsInput);
      if (inclusionsInput) {
        await inclusionsInput.fill(estimateData.inclusions);
        await randomDelay(300, 500);
      }
    }
    
    // Exclusions
    if (estimateData.exclusions) {
      const exclusionsInput = await page.$(PROCORE_SELECTORS.primeContract.exclusionsInput);
      if (exclusionsInput) {
        await exclusionsInput.fill(estimateData.exclusions);
        await randomDelay(300, 500);
      }
    }
    
    // Save the contract
    const saveButton = await page.$(PROCORE_SELECTORS.primeContract.saveButton);
    if (saveButton) {
      await saveButton.click();
      await randomDelay(2000, 3000);
    }
    
    // Wait for save to complete
    await page.waitForLoadState("networkidle");
    
    // Check for success and get contract ID from URL
    const currentUrl = page.url();
    const contractMatch = currentUrl.match(/prime_contracts?\/(\d+)/);
    
    if (contractMatch) {
      result.contractId = contractMatch[1];
      result.success = true;
      await logPortfolioAction(portfolioProjectId, "create_prime_contract", "success", { contractId: result.contractId });
      log(`Successfully created Prime Contract ${result.contractId} for project ${portfolioProjectId}`, "playwright");
    } else {
      // Check for success toast
      const toast = await page.$(PROCORE_SELECTORS.common.toast);
      const toastText = toast ? await toast.textContent() : null;
      
      if (toastText?.toLowerCase().includes("success") || toastText?.toLowerCase().includes("created")) {
        result.success = true;
        await logPortfolioAction(portfolioProjectId, "create_prime_contract", "success", { message: toastText });
      } else {
        result.error = "Prime Contract creation did not complete as expected";
        result.screenshotPath = await takeScreenshot(page, `contract-unknown-${portfolioProjectId}`);
        await logPortfolioAction(portfolioProjectId, "create_prime_contract", "failed", {}, result.error, result.screenshotPath);
      }
    }
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.screenshotPath = await takeScreenshot(page, `contract-error-${portfolioProjectId}`);
    await logPortfolioAction(portfolioProjectId, "create_prime_contract", "failed", {}, result.error, result.screenshotPath);
    log(`Error creating Prime Contract: ${result.error}`, "playwright");
  }
  
  return result;
}

export async function addClientToProjectDirectory(
  page: Page,
  portfolioProjectId: string,
  clientData: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
  }
): Promise<DirectoryAddResult> {
  const result: DirectoryAddResult = {
    success: false,
    portfolioProjectId,
  };

  try {
    const navigated = await navigateToPortfolioProject(page, portfolioProjectId);
    if (!navigated) {
      result.error = "Failed to navigate to Portfolio project";
      return result;
    }

    await randomDelay(1000, 2000);

    const directoryTab = await page.$(PROCORE_SELECTORS.directory.tab);
    if (directoryTab) {
      await directoryTab.click();
      await randomDelay(2000, 3000);
    } else {
      result.error = "Directory tab not found";
      result.screenshotPath = await takeScreenshot(page, `directory-no-tab-${portfolioProjectId}`);
      return result;
    }

    const addButton = await page.$(PROCORE_SELECTORS.directory.addButton);
    if (!addButton) {
      result.error = "Add person button not found";
      result.screenshotPath = await takeScreenshot(page, `directory-no-add-${portfolioProjectId}`);
      return result;
    }

    await addButton.click();
    await randomDelay(1000, 2000);

    const nameParts = clientData.name.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const firstNameInput = await page.$(PROCORE_SELECTORS.directory.firstNameInput);
    const lastNameInput = await page.$(PROCORE_SELECTORS.directory.lastNameInput);
    const nameInput = await page.$(PROCORE_SELECTORS.directory.nameInput);

    if (firstNameInput && lastNameInput) {
      await firstNameInput.fill(firstName);
      await randomDelay(200, 400);
      await lastNameInput.fill(lastName);
    } else if (nameInput) {
      await nameInput.fill(clientData.name);
    }
    await randomDelay(300, 500);

    if (clientData.email) {
      const emailInput = await page.$(PROCORE_SELECTORS.directory.emailInput);
      if (emailInput) {
        await emailInput.fill(clientData.email);
        await randomDelay(200, 400);
      }
    }

    if (clientData.phone) {
      const phoneInput = await page.$(PROCORE_SELECTORS.directory.phoneInput);
      if (phoneInput) {
        await phoneInput.fill(clientData.phone);
        await randomDelay(200, 400);
      }
    }

    if (clientData.company) {
      const companyInput = await page.$(PROCORE_SELECTORS.directory.companyInput);
      if (companyInput) {
        await companyInput.fill(clientData.company);
        await randomDelay(200, 400);
      }
    }

    const roleDropdown = await page.$(PROCORE_SELECTORS.directory.roleDropdown);
    if (roleDropdown) {
      let roleSelected = false;
      try {
        await roleDropdown.selectOption({ label: 'Client' });
        roleSelected = true;
      } catch {
        // Fallback: find a matching option
        const options = await page.$$(PROCORE_SELECTORS.directory.roleDropdown + ' option');
        for (const option of options) {
          const text = await option.textContent();
          if (text?.toLowerCase().includes('client') || text?.toLowerCase().includes('owner')) {
            await roleDropdown.selectOption({ label: text });
            roleSelected = true;
            break;
          }
        }
      }
      if (!roleSelected) {
        log('Warning: Could not select Client role from dropdown', 'playwright');
      }
      await randomDelay(200, 400);
    }

    const inviteCheckbox = await page.$(PROCORE_SELECTORS.directory.inviteCheckbox);
    if (inviteCheckbox) {
      const isChecked = await inviteCheckbox.isChecked();
      if (isChecked) {
        await inviteCheckbox.click();
      }
    }

    const saveButton = await page.$(PROCORE_SELECTORS.directory.saveButton);
    if (saveButton) {
      await saveButton.click();
      await randomDelay(2000, 3000);
    }

    await page.waitForLoadState("networkidle");

    const toast = await page.$(PROCORE_SELECTORS.common.toast);
    const toastText = toast ? await toast.textContent() : null;

    if (toastText?.toLowerCase().includes('error') || toastText?.toLowerCase().includes('failed')) {
      result.error = toastText || 'Unknown error adding client';
      result.screenshotPath = await takeScreenshot(page, `directory-error-${portfolioProjectId}`);
      await logPortfolioAction(portfolioProjectId, "add_client_to_directory", "failed", {}, result.error, result.screenshotPath);
    } else {
      result.success = true;
      await logPortfolioAction(portfolioProjectId, "add_client_to_directory", "success", { clientName: clientData.name });
      log(`Successfully added client ${clientData.name} to directory for project ${portfolioProjectId}`, "playwright");
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    result.screenshotPath = await takeScreenshot(page, `directory-error-${portfolioProjectId}`);
    await logPortfolioAction(portfolioProjectId, "add_client_to_directory", "failed", {}, result.error, result.screenshotPath);
    log(`Error adding client to directory: ${result.error}`, "playwright");
  }

  return result;
}

export async function runFullPortfolioWorkflow(
  bidboardProjectId: string,
  options: {
    importToBudget?: boolean;
    createPrimeContract?: boolean;
    sendKickoffEmail?: boolean;
    addClientToDirectory?: boolean;
    clientData?: { companyName?: string; contactName?: string; email?: string; phone?: string };
  } = {}
): Promise<{
  portfolioTransition: PortfolioTransitionResult;
  budgetImport?: BudgetImportResult;
  primeContract?: PrimeContractResult;
  kickoffEmails?: { sent: number; skipped: number; failed: number };
  directoryAdd?: DirectoryAddResult;
}> {
  const { page, success, error } = await ensureLoggedIn();
  
  if (!success) {
    return {
      portfolioTransition: {
        success: false,
        bidboardProjectId,
        error: error || "Failed to log in",
      },
    };
  }
  
  const result: {
    portfolioTransition: PortfolioTransitionResult;
    budgetImport?: BudgetImportResult;
    primeContract?: PrimeContractResult;
    kickoffEmails?: { sent: number; skipped: number; failed: number };
    directoryAdd?: DirectoryAddResult;
  } = {
    portfolioTransition: await sendToPortfolio(page, bidboardProjectId),
  };
  
  if (!result.portfolioTransition.success || !result.portfolioTransition.portfolioProjectId) {
    return result;
  }
  
  const portfolioProjectId = result.portfolioTransition.portfolioProjectId;
  
  // Extract estimate data for Budget and Prime Contract
  let estimateData: EstimateData | null = null;
  let estimateCsvPath: string | null = null;
  
  if (options.importToBudget || options.createPrimeContract) {
    estimateData = await extractEstimateData(page, bidboardProjectId);
    
    if (options.importToBudget) {
      estimateCsvPath = await exportEstimateToCsv(page, bidboardProjectId);
    }
  }
  
  // Import to Budget
  if (options.importToBudget && estimateCsvPath) {
    result.budgetImport = await importEstimateToBudget(page, portfolioProjectId, estimateCsvPath);
  }
  
  // Create Prime Contract
  if (options.createPrimeContract && estimateData) {
    result.primeContract = await createPrimeContract(
      page,
      portfolioProjectId,
      estimateData,
      options.clientData
    );
  }
  
  // Send kickoff emails
  if (options.sendKickoffEmail) {
    try {
      const projectDetail = await fetchProcoreProjectDetail(portfolioProjectId);
      const teamMembers = await getProjectTeamMembers(portfolioProjectId);
      
      const pmMembers = teamMembers.filter(m => 
        m.role.toLowerCase().includes('project manager') || 
        m.role.toLowerCase().includes('superintendent')
      );
      
      if (pmMembers.length > 0) {
        result.kickoffEmails = await sendKickoffEmails({
          projectId: portfolioProjectId,
          projectName: projectDetail?.name || projectDetail?.display_name || 'Unknown Project',
          clientName: options.clientData?.companyName || projectDetail?.company?.name || 'Unknown Client',
          projectAddress: projectDetail?.address || projectDetail?.location || 'TBD',
          teamMembers: pmMembers,
        });
        
        log(`Kickoff emails sent: ${result.kickoffEmails.sent} sent, ${result.kickoffEmails.skipped} skipped, ${result.kickoffEmails.failed} failed`, 'playwright');
      } else {
        log('No PM/Superintendent found for kickoff emails', 'playwright');
        result.kickoffEmails = { sent: 0, skipped: 0, failed: 0 };
      }
    } catch (err: any) {
      log(`Error sending kickoff emails: ${err.message}`, 'playwright');
      result.kickoffEmails = { sent: 0, skipped: 0, failed: 1 };
    }
  }
  
  // Add client to project directory
  if (options.addClientToDirectory && options.clientData?.companyName) {
    try {
      result.directoryAdd = await addClientToProjectDirectory(
        page,
        portfolioProjectId,
        {
          name: options.clientData.contactName || options.clientData.companyName,
          email: options.clientData.email,
          phone: options.clientData.phone,
          company: options.clientData.companyName,
        }
      );
      
      if (result.directoryAdd.success) {
        log(`Client added to directory for project ${portfolioProjectId}`, 'playwright');
      } else {
        log(`Failed to add client to directory: ${result.directoryAdd.error}`, 'playwright');
      }
    } catch (err: any) {
      log(`Error adding client to directory: ${err.message}`, 'playwright');
      result.directoryAdd = { 
        success: false, 
        portfolioProjectId, 
        error: err.message 
      };
    }
  }
  
  return result;
}
