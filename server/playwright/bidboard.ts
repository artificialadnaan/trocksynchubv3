/**
 * Playwright BidBoard Module
 * ==========================
 * 
 * This module handles browser automation for Procore BidBoard (Estimating).
 * BidBoard is where T-Rock manages pre-award estimates and proposals.
 * 
 * Why Browser Automation?
 * Procore's BidBoard API is limited. Browser automation allows us to:
 * - Scrape project list with stages and client info
 * - Create new projects from HubSpot deals
 * - Navigate to specific projects for data extraction
 * - Sync client information to projects
 * 
 * BidBoard Data Extraction:
 * The module scrapes the BidBoard project list page to extract:
 * - Project ID and number
 * - Project name and stage
 * - Client name and contact info
 * - Bid due dates and estimate amounts
 * 
 * Project Creation:
 * When a HubSpot deal moves to "RFP" stage, this module can
 * automatically create a corresponding BidBoard project.
 * 
 * Key Functions:
 * - runBidBoardScrape(): Scrapes all BidBoard projects
 * - navigateToBidBoard(): Navigate to BidBoard list page
 * - navigateToProject(): Navigate to specific project
 * - getProjectDetails(): Extract detailed project info
 * - createBidBoardProject(): Create new project via form
 * - createBidBoardProjectFromDeal(): Create from HubSpot deal data
 * - syncHubSpotClientToBidBoard(): Sync client info from HubSpot
 * 
 * URL Patterns:
 * - BidBoard List: /webclients/host/companies/{companyId}/tools/bid-board
 * - Project Detail: /webclients/host/companies/{companyId}/projects/{projectId}
 * 
 * @module playwright/bidboard
 */

import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { PROCORE_SELECTORS, getBidBoardUrlNew } from "./selectors";
import { randomDelay, takeScreenshot, withRetry, waitForNavigation } from "./browser";
import { log } from "../index";
import { storage } from "../storage";

/** BidBoard project data extracted from web scrape */
export interface BidBoardProject {
  id: string;
  projectNumber?: string;
  name: string;
  stage: string;
  clientName?: string;
  bidDueDate?: string;
  estimateAmount?: string;
  lastUpdated?: string;
  metadata?: Record<string, any>;
}

export interface BidBoardSyncResult {
  projects: BidBoardProject[];
  changes: {
    projectId: string;
    projectName: string;
    previousStage: string | null;
    newStage: string;
    changeType: "new" | "updated";
  }[];
  errors: string[];
}

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

function normalizeState(state: string): string {
  if (!state) return state;
  if (state.trim().length === 2) return state.trim().toUpperCase();
  const abbrev = STATE_ABBREVIATIONS[state.trim().toLowerCase()];
  return abbrev || state.trim();
}

async function getCompanyId(): Promise<string | null> {
  const config = await storage.getAutomationConfig("procore_config");
  return (config?.value as any)?.companyId || null;
}

async function isSandbox(): Promise<boolean> {
  const credentials = await storage.getAutomationConfig("procore_browser_credentials");
  return (credentials?.value as any)?.sandbox || false;
}

export async function navigateToBidBoard(
  page: Page,
  options?: { proposalId?: string; status?: string }
): Promise<boolean> {
  const companyId = await getCompanyId();
  if (!companyId) {
    log("Procore company ID not configured", "playwright");
    return false;
  }
  
  const sandbox = await isSandbox();
  
  // Try the new URL format first (Procore's updated UI). Optionally append ?status=todo&proposalId=X
  const newBidboardUrl = getBidBoardUrlNew(companyId, sandbox, options);
  log(`Navigating to BidBoard (new UI): ${newBidboardUrl}`, "playwright");
  
  try {
    // Use 'load' instead of 'networkidle' - Procore's SPA has persistent connections
    // (websockets, polling) that prevent networkidle from ever firing
    await page.goto(newBidboardUrl, { waitUntil: "load", timeout: 60000 });
    await randomDelay(3000, 5000);
    
    // New BidBoard UI (tools/bid-board): wait for spaContent, Create New Project button, or stage tabs
    const newUiSelectors = [
      PROCORE_SELECTORS.bidboard.newUi.app,
      PROCORE_SELECTORS.bidboard.newUi.createNewProjectButton,
      'button.aid-tab',
      PROCORE_SELECTORS.bidboard.container,
      PROCORE_SELECTORS.bidboard.projectList,
    ];
    for (const sel of newUiSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        log(`BidBoard loaded successfully (new URL): ${sel}`, "playwright");
        return true;
      } catch {
        /* try next */
      }
    }
    // If we're on the new bid-board URL, treat as success - create flow will verify Create button
    const url = page.url();
    if (url.includes("/tools/bid-board")) {
      log("BidBoard URL confirmed, treating as loaded (selectors may have changed)", "playwright");
      return true;
    }
  } catch (err: any) {
    log(`BidBoard navigation failed: ${err.message}`, "playwright");
  }
  
  const screenshotPath = await takeScreenshot(page, "bidboard-not-found");
  log(`BidBoard not found. Screenshot: ${screenshotPath}`, "playwright");
  return false;
}

export async function scrapeProjectList(page: Page): Promise<BidBoardProject[]> {
  const projects: BidBoardProject[] = [];
  
  // Wait for project list to load
  await page.waitForSelector(PROCORE_SELECTORS.bidboard.projectList, { timeout: 15000 });
  await randomDelay(1000, 2000);
  
  // Get all project rows
  const rows = await page.$$(PROCORE_SELECTORS.bidboard.projectRow);
  
  log(`Found ${rows.length} project rows`, "playwright");
  
  for (const row of rows) {
    try {
      // Extract project data from row
      const nameElement = await row.$(PROCORE_SELECTORS.bidboard.projectName);
      const stageElement = await row.$(PROCORE_SELECTORS.bidboard.projectStage);
      const numberElement = await row.$(PROCORE_SELECTORS.bidboard.projectNumber);
      
      const name = nameElement ? (await nameElement.textContent())?.trim() : null;
      const stage = stageElement ? (await stageElement.textContent())?.trim() : null;
      const projectNumber = numberElement ? (await numberElement.textContent())?.trim() : null;
      
      if (name && stage) {
        // Try to get project ID from row attributes or link
        let projectId: string | null = null;
        const link = await row.$("a[href*='/bidding/']");
        if (link) {
          const href = await link.getAttribute("href");
          const match = href?.match(/\/bidding\/(\d+)/);
          projectId = match ? match[1] : null;
        }
        
        // Fallback: use project number or generate ID from name
        if (!projectId) {
          projectId = projectNumber || name.replace(/\s+/g, "-").toLowerCase();
        }
        
        projects.push({
          id: projectId,
          projectNumber: projectNumber || undefined,
          name,
          stage,
        });
      }
    } catch (error) {
      log(`Error parsing project row: ${error}`, "playwright");
    }
  }
  
  // Handle pagination if present
  let hasNextPage = true;
  while (hasNextPage) {
    const nextButton = await page.$(PROCORE_SELECTORS.common.nextPageButton);
    if (nextButton && await nextButton.isEnabled()) {
      await nextButton.click();
      await randomDelay(2000, 3000);
      
      // Scrape additional rows
      const additionalRows = await page.$$(PROCORE_SELECTORS.bidboard.projectRow);
      for (const row of additionalRows) {
        try {
          const nameElement = await row.$(PROCORE_SELECTORS.bidboard.projectName);
          const stageElement = await row.$(PROCORE_SELECTORS.bidboard.projectStage);
          
          const name = nameElement ? (await nameElement.textContent())?.trim() : null;
          const stage = stageElement ? (await stageElement.textContent())?.trim() : null;
          
          if (name && stage && !projects.find(p => p.name === name)) {
            projects.push({
              id: name.replace(/\s+/g, "-").toLowerCase(),
              name,
              stage,
            });
          }
        } catch (error) {
          log(`Error parsing additional row: ${error}`, "playwright");
        }
      }
    } else {
      hasNextPage = false;
    }
  }
  
  log(`Scraped ${projects.length} total projects from BidBoard`, "playwright");
  return projects;
}

export async function exportBidBoardCsv(page: Page): Promise<string | null> {
  try {
    log("Starting BidBoard CSV export...", "playwright");
    
    // Step 1: Click the more options menu (three dots)
    log("Looking for more options menu...", "playwright");
    const moreOptionsButton = await page.$(PROCORE_SELECTORS.bidboard.moreOptionsMenu);
    
    if (moreOptionsButton) {
      log("Found more options menu, clicking...", "playwright");
      await moreOptionsButton.click();
      await randomDelay(1000, 1500);
      
      // Step 2: Click "Export Project List To Excel"
      log("Looking for export option in menu...", "playwright");
      const exportOption = await page.$(PROCORE_SELECTORS.bidboard.exportMenuOption);
      
      if (exportOption) {
        log("Found export option, initiating download...", "playwright");
        
        // Set up download handler before clicking
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          exportOption.click(),
        ]);
        
        // Save the file to a temp location
        const downloadPath = await download.path();
        const suggestedFilename = download.suggestedFilename();
        log(`Excel downloaded: ${suggestedFilename} at ${downloadPath}`, "playwright");
        
        return downloadPath;
      } else {
        log("Export option not found in menu", "playwright");
        await takeScreenshot(page, "export-menu-no-option");
      }
    } else {
      log("More options menu not found, trying direct export button...", "playwright");
    }
    
    // Fallback: Try direct export button
    const exportButton = await page.$(PROCORE_SELECTORS.bidboard.exportButton);
    if (exportButton) {
      log("Found direct export button, clicking...", "playwright");
      
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        exportButton.click(),
      ]);
      
      const downloadPath = await download.path();
      log(`CSV downloaded to: ${downloadPath}`, "playwright");
      
      return downloadPath;
    }
    
    log("No export button found", "playwright");
    await takeScreenshot(page, "export-button-not-found");
    return null;
  } catch (error) {
    log(`Failed to export CSV: ${error}`, "playwright");
    await takeScreenshot(page, "export-error");
    return null;
  }
}

export async function detectStageChanges(
  currentProjects: BidBoardProject[]
): Promise<BidBoardSyncResult["changes"]> {
  const changes: BidBoardSyncResult["changes"] = [];
  
  // Get previous state from database
  const previousStates = await storage.getBidboardSyncStates();
  const previousStateMap = new Map(
    previousStates.map(s => [s.projectId, s])
  );
  
  for (const project of currentProjects) {
    const previousState = previousStateMap.get(project.id);
    
    if (!previousState) {
      // New project
      changes.push({
        projectId: project.id,
        projectName: project.name,
        previousStage: null,
        newStage: project.stage,
        changeType: "new",
      });
    } else if (previousState.currentStage !== project.stage) {
      // Stage changed
      changes.push({
        projectId: project.id,
        projectName: project.name,
        previousStage: previousState.currentStage,
        newStage: project.stage,
        changeType: "updated",
      });
    }
  }
  
  return changes;
}

export async function saveBidBoardState(projects: BidBoardProject[]): Promise<void> {
  for (const project of projects) {
    await storage.upsertBidboardSyncState({
      projectId: project.id,
      projectName: project.name,
      currentStage: project.stage,
      metadata: project.metadata,
    });
  }
  
  log(`Saved state for ${projects.length} projects`, "playwright");
}

export async function navigateToProject(page: Page, projectId: string): Promise<boolean> {
  const companyId = await getCompanyId();
  if (!companyId) return false;

  const sandbox = await isSandbox();
  // Use new UI URL (us02) - matches post-login redirect and BidBoard
  const baseUrl = sandbox ? "https://sandbox.procore.com" : "https://us02.procore.com";
  const projectUrl = `${baseUrl}/webclients/host/companies/${companyId}/tools/bid-board/project/${projectId}/details`;

  log(`Navigating to project: ${projectUrl}`, "playwright");
  try {
    await page.goto(projectUrl, { waitUntil: "load", timeout: 90000 });
  } catch (navErr: any) {
    if (navErr.message?.includes('Timeout')) {
      log(`Navigation timeout (load), continuing with domcontentloaded`, "playwright");
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      throw navErr;
    }
  }
  await randomDelay(2000, 3000);
  return true;
}

export async function getProjectDetails(page: Page, projectId: string): Promise<BidBoardProject | null> {
  await navigateToProject(page, projectId);
  
  try {
    // Click overview tab
    const overviewTab = await page.$(PROCORE_SELECTORS.bidboard.projectOverviewTab);
    if (overviewTab) {
      await overviewTab.click();
      await randomDelay(1000, 2000);
    }
    
    // Extract detailed information
    const project: BidBoardProject = {
      id: projectId,
      name: "",
      stage: "",
    };
    
    // Get project name from header
    const headerElement = await page.$("h1, .project-name, [data-testid='project-name']");
    if (headerElement) {
      project.name = (await headerElement.textContent())?.trim() || "";
    }
    
    // Get stage
    const stageElement = await page.$(PROCORE_SELECTORS.bidboard.stageDropdown);
    if (stageElement) {
      project.stage = (await stageElement.textContent())?.trim() || "";
    }
    
    // Get client info if available
    const clientNameInput = await page.$(PROCORE_SELECTORS.overview.clientNameInput);
    if (clientNameInput) {
      project.clientName = await clientNameInput.inputValue();
    }
    
    return project;
  } catch (error) {
    await takeScreenshot(page, "error-get-project-details").catch(() => {});
    log(`Error getting project details: ${error}`, "playwright");
    return null;
  }
}

export async function changeProjectStage(page: Page, projectId: string, newStage: string): Promise<boolean> {
  await navigateToProject(page, projectId);
  
  try {
    // Find and click stage dropdown
    const stageDropdown = await page.$(PROCORE_SELECTORS.bidboard.stageDropdown);
    if (!stageDropdown) {
      log("Stage dropdown not found", "playwright");
      return false;
    }
    
    await stageDropdown.click();
    await randomDelay(500, 1000);
    
    // Select the new stage
    const stageOption = await page.$(`[data-value="${newStage}"], option:has-text("${newStage}")`);
    if (stageOption) {
      await stageOption.click();
      await randomDelay(1000, 2000);
      
      // Wait for any confirmation or save
      await page.waitForLoadState("networkidle");
      
      log(`Changed project ${projectId} stage to ${newStage}`, "playwright");
      return true;
    }
    
    log(`Stage option "${newStage}" not found`, "playwright");
    return false;
  } catch (error) {
    await takeScreenshot(page, "error-change-stage").catch(() => {});
    log(`Error changing stage: ${error}`, "playwright");
    return false;
  }
}

export interface ClientData {
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

export async function fillClientData(page: Page, projectId: string, clientData: ClientData): Promise<boolean> {
  try {
    await navigateToProject(page, projectId);
    
    // Click on Overview tab
    const overviewTab = await page.$(PROCORE_SELECTORS.bidboard.projectOverviewTab);
    if (overviewTab) {
      await overviewTab.click();
      await randomDelay(1000, 2000);
    }
    
    // Check if we need to click Edit button first
    const editButton = await page.$(PROCORE_SELECTORS.overview.editButton);
    if (editButton) {
      await editButton.click();
      await randomDelay(500, 1000);
    }
    
    // Fill in client name
    if (clientData.companyName) {
      const clientNameInput = await page.$(PROCORE_SELECTORS.overview.clientNameInput);
      if (clientNameInput) {
        await clientNameInput.fill(clientData.companyName);
        await randomDelay(300, 500);
      }
    }
    
    // Fill in contact name
    if (clientData.contactName) {
      const contactNameInput = await page.$(PROCORE_SELECTORS.overview.contactNameInput);
      if (contactNameInput) {
        await contactNameInput.fill(clientData.contactName);
        await randomDelay(300, 500);
      }
    }
    
    // Fill in contact email
    if (clientData.contactEmail) {
      const clientEmailInput = await page.$(PROCORE_SELECTORS.overview.clientEmailInput);
      if (clientEmailInput) {
        await clientEmailInput.fill(clientData.contactEmail);
        await randomDelay(300, 500);
      }
    }
    
    // Fill in contact phone
    if (clientData.contactPhone) {
      const clientPhoneInput = await page.$(PROCORE_SELECTORS.overview.clientPhoneInput);
      if (clientPhoneInput) {
        await clientPhoneInput.fill(clientData.contactPhone);
        await randomDelay(300, 500);
      }
    }
    
    // Fill in address
    if (clientData.address) {
      const clientAddressInput = await page.$(PROCORE_SELECTORS.overview.clientAddressInput);
      if (clientAddressInput) {
        const fullAddress = [
          clientData.address,
          clientData.city,
          clientData.state,
          clientData.zipCode,
        ].filter(Boolean).join(", ");
        await clientAddressInput.fill(fullAddress);
        await randomDelay(300, 500);
      }
    }
    
    // Save changes
    const saveButton = await page.$(PROCORE_SELECTORS.overview.saveButton);
    if (saveButton) {
      await saveButton.click();
      await randomDelay(1000, 2000);
      await page.waitForLoadState("networkidle");
    }
    
    log(`Filled client data for project ${projectId}`, "playwright");
    return true;
  } catch (error) {
    await takeScreenshot(page, "error-fill-client-data").catch(() => {});
    log(`Error filling client data: ${error}`, "playwright");
    return false;
  }
}

export async function getClientDataFromHubSpot(hubspotDealId: string): Promise<ClientData | null> {
  try {
    // Query local database for deal and associated company/contact
    const deal = await storage.getHubspotDealByHubspotId(hubspotDealId);
    
    if (!deal) {
      log(`HubSpot deal ${hubspotDealId} not found in local database`, "playwright");
      return null;
    }
    
    const clientData: ClientData = {};
    
    // Get associated company
    if (deal.associatedCompanyId) {
      const company = await storage.getHubspotCompanyByHubspotId(deal.associatedCompanyId);
      
      if (company) {
        clientData.companyName = company.name || undefined;
        clientData.address = company.address || undefined;
        clientData.city = company.city || undefined;
        clientData.state = company.state || undefined;
        clientData.zipCode = company.zip || undefined;
        clientData.contactPhone = company.phone || undefined;
      }
    }
    
    // Get primary contact using contact lookup (use first contact from comma-separated list)
    if (deal.associatedContactIds) {
      const contactIds = deal.associatedContactIds.split(",");
      const contact = contactIds.length > 0
        ? await storage.getHubspotContactByHubspotId(contactIds[0].trim())
        : null;

      if (contact) {
        clientData.contactName = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || undefined;
        clientData.contactEmail = contact.email || undefined;
        if (!clientData.contactPhone) {
          clientData.contactPhone = contact.phone || undefined;
        }
      }
    }

    // Fallback: fetch contact directly from HubSpot API if local lookup returned no contact
    if (!clientData.contactName) {
      try {
        const { getHubSpotClient } = await import('../hubspot');
        const client = await getHubSpotClient();
        const dealWithAssoc = await client.crm.deals.basicApi.getById(hubspotDealId, [], undefined, ['contacts']);
        const contactAssoc = (dealWithAssoc as any).associations?.contacts?.results;
        if (contactAssoc && contactAssoc.length > 0) {
          const contactId = String(contactAssoc[0].id);
          const contact = await client.crm.contacts.basicApi.getById(contactId, ['firstname', 'lastname', 'email', 'phone']);
          const cProps = contact.properties || {};
          clientData.contactName = [cProps.firstname, cProps.lastname].filter(Boolean).join(' ') || undefined;
          clientData.contactEmail = clientData.contactEmail || cProps.email || undefined;
          if (!clientData.contactPhone) {
            clientData.contactPhone = cProps.phone || undefined;
          }
          log(`[bidboard] Fetched contact from HubSpot API: ${clientData.contactName}`, "playwright");
        }
      } catch (e: any) {
        log(`[bidboard] HubSpot API contact fallback failed: ${e.message}`, "playwright");
      }
    }

    return clientData;
  } catch (error) {
    log(`Error getting client data from HubSpot: ${error}`, "playwright");
    return null;
  }
}

export async function syncHubSpotClientToBidBoard(
  projectId: string,
  hubspotDealId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const clientData = await getClientDataFromHubSpot(hubspotDealId);
    
    if (!clientData) {
      return { success: false, error: "Could not retrieve client data from HubSpot" };
    }
    
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      return { success: false, error: error || "Failed to log in" };
    }
    
    const filled = await fillClientData(page, projectId, clientData);
    
    if (filled) {
      return { success: true };
    } else {
      return { success: false, error: "Failed to fill client data in BidBoard" };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

export async function runBidBoardScrape(): Promise<BidBoardSyncResult> {
  const result: BidBoardSyncResult = {
    projects: [],
    changes: [],
    errors: [],
  };
  
  try {
    // Ensure we're logged in
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      result.errors.push(error || "Failed to log in");
      return result;
    }
    
    // Navigate to BidBoard
    const navigated = await navigateToBidBoard(page);
    if (!navigated) {
      result.errors.push("Failed to navigate to BidBoard");
      return result;
    }
    
    // Scrape project list
    result.projects = await scrapeProjectList(page);
    
    // Detect changes
    result.changes = await detectStageChanges(result.projects);
    
    // Save current state
    await saveBidBoardState(result.projects);
    
    log(`BidBoard scrape complete: ${result.projects.length} projects, ${result.changes.length} changes`, "playwright");
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`BidBoard scrape error: ${errorMessage}`, "playwright");
  }
  
  return result;
}

// Export Excel from BidBoard and parse it
export async function runBidBoardExportSync(): Promise<BidBoardSyncResult> {
  const result: BidBoardSyncResult = {
    projects: [],
    changes: [],
    errors: [],
  };
  
  try {
    log("Starting BidBoard export sync...", "playwright");
    
    // Ensure we're logged in
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      result.errors.push(error || "Failed to log in");
      return result;
    }
    
    // Navigate to BidBoard
    const navigated = await navigateToBidBoard(page);
    if (!navigated) {
      result.errors.push("Failed to navigate to BidBoard");
      return result;
    }
    
    // Export the Excel file
    const excelPath = await exportBidBoardCsv(page);
    
    if (!excelPath) {
      result.errors.push("Failed to export Excel file from BidBoard");
      return result;
    }
    
    // Parse the Excel file
    result.projects = await parseExportedExcel(excelPath);
    
    if (result.projects.length === 0) {
      result.errors.push("No projects found in exported Excel");
      return result;
    }
    
    log(`Parsed ${result.projects.length} projects from Excel export`, "playwright");
    
    // Detect changes
    result.changes = await detectStageChanges(result.projects);
    
    // Save current state
    await saveBidBoardState(result.projects);
    
    log(`BidBoard export sync complete: ${result.projects.length} projects, ${result.changes.length} changes`, "playwright");
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`BidBoard export sync error: ${errorMessage}`, "playwright");
  }
  
  return result;
}

// Parse the exported Excel file from BidBoard
async function parseExportedExcel(filePath: string): Promise<BidBoardProject[]> {
  const projects: BidBoardProject[] = [];
  
  try {
    const XLSX = await import('xlsx');
    const fs = await import('fs');
    
    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    
    // Get the first sheet
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const rows = XLSX.utils.sheet_to_json(sheet) as any[];
    
    log(`Excel has ${rows.length} rows`, "playwright");
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      // Map Excel columns to BidBoardProject
      // Based on the actual export format:
      // Name, Estimator, Office, Status, Sales Price Per Area, Project Cost, Profit Margin, Total Sales, Created Date, Due Date, Customer Name, Customer Contact, Project #
      
      const name = row['Name']?.toString()?.trim();
      if (!name) continue;
      
      const project: BidBoardProject = {
        id: `excel_${i}_${Date.now()}`, // Generate ID since Excel doesn't have one
        name,
        stage: row['Status']?.toString()?.trim() || '',
        projectNumber: row['Project #']?.toString()?.trim() || undefined,
        metadata: {
          estimator: row['Estimator']?.toString()?.trim() || null,
          office: row['Office']?.toString()?.trim() || null,
          projectCost: parseFloat(row['Project Cost']) || 0,
          profitMargin: parseFloat(row['Profit Margin']) || 0,
          totalSales: parseFloat(row['Total Sales']) || 0,
          salesPricePerArea: row['Sales Price Per Area']?.toString()?.trim() || null,
          createdDate: row['Created Date'] || null,
          dueDate: row['Due Date'] || null,
          customerName: row['Customer Name']?.toString()?.trim() || null,
          customerContact: row['Customer Contact']?.toString()?.trim() || null,
        },
      };
      
      projects.push(project);
    }
    
    log(`Parsed ${projects.length} projects from Excel`, "playwright");
    
  } catch (error) {
    log(`Error parsing Excel: ${error}`, "playwright");
  }
  
  return projects;
}

// Interface for creating a new BidBoard project
export interface NewBidBoardProjectData {
  name: string;
  projectNumber?: string;
  stage: string; // "Estimate in Progress" or "Service – Estimating"
  /** Project type number: 4 = Service, use Service - Estimating tab */
  projectTypes?: string;
  /** Estimator name from RFP form */
  estimator?: string;
  clientName?: string;
  contactName?: string;
  clientEmail?: string;
  clientPhone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  description?: string;
  bidDueDate?: string;
  /** Optional: proposalId for BidBoard URL */
  proposalId?: string;
}

function formatDateForProcore(val: string): string {
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

export interface CreateBidBoardProjectResult {
  success: boolean;
  projectId?: string;
  proposalId?: string;
  projectName?: string;
  error?: string;
  screenshotPath?: string;
}

export async function createBidBoardProject(
  projectData: NewBidBoardProjectData
): Promise<CreateBidBoardProjectResult> {
  const result: CreateBidBoardProjectResult = {
    success: false,
    projectName: projectData.name,
  };

  const { page, success, error } = await ensureLoggedIn();
  
  if (!success || !page) {
    result.error = error || "Failed to log in to Procore";
    return result;
  }

  try {
    // Navigate to BidBoard (optionally with ?status=todo&proposalId=X for RFP flow)
    const navOptions = { status: "todo" as const, proposalId: projectData.proposalId };
    const navigated = await navigateToBidBoard(page, navOptions);
    if (!navigated) {
      result.error = "Failed to navigate to BidBoard";
      result.screenshotPath = await takeScreenshot(page, "create-bidboard-nav-failed");
      return result;
    }

    const isNewBidBoardUi = page.url().includes("/tools/bid-board");
    let isService = false;
    if (isNewBidBoardUi) {
      // Parse type digit from project number (DFW-4-... = Service, all others = Estimate in Progress)
      const projectNumberTypeDigit = projectData.projectNumber?.match(/^[A-Z]{2,4}-(\d+)-/i)?.[1];
      isService = projectNumberTypeDigit === "4";

      // Note: description fill moved to after project form opens (line ~1312)
      log(`Tab selection: projectNumber=${projectData.projectNumber}, typeDigit=${projectNumberTypeDigit ?? "none"}, isService=${isService}`, "playwright");
      try {
        const tab = isService
          ? page.locator('button.aid-tab').filter({ hasText: /Service\s*-\s*Estimating/i })
          : page.locator('button.aid-tab').filter({ hasText: /Estimate\s*in\s*Progress/i });
        await tab.first().click({ timeout: 8000 });
        await randomDelay(1500, 2500);
      } catch (e: any) {
        log(`Could not click stage tab: ${e.message}`, "playwright");
      }

      const createBtn = await page.$(PROCORE_SELECTORS.bidboard.newUi.createNewProjectButton);
      if (!createBtn) {
        result.error = "Create New Project button not found (new UI)";
        result.screenshotPath = await takeScreenshot(page, "create-bidboard-no-button");
        return result;
      }
      await createBtn.click();
      await randomDelay(1500, 2500);

      // Dialog: select "empty new project" (radio value="false") and click Confirm
      const emptyRadio = page.locator('input[type="radio"][value="false"]').first();
      try {
        await emptyRadio.waitFor({ state: "visible", timeout: 5000 });
        await emptyRadio.click();
        await randomDelay(300, 500);
      } catch {
        // Try clicking by label text for empty option
        const emptyLabel = page.locator('[role="dialog"] label').filter({ hasText: /empty|new project/i }).first();
        try {
          await emptyLabel.click({ timeout: 3000 });
          await randomDelay(300, 500);
        } catch { /* continue */ }
      }
      const confirmBtn = await page.$(PROCORE_SELECTORS.bidboard.newUi.createDialogConfirm);
      if (confirmBtn) {
        await confirmBtn.click();
        await randomDelay(2000, 3500);
      } else {
        result.error = "Confirm button not found in Create New Project dialog";
        result.screenshotPath = await takeScreenshot(page, "create-bidboard-no-confirm");
        return result;
      }
    } else {
      // Legacy UI: click Create New Project (opens form/modal directly)
      const createButton = await page.$(PROCORE_SELECTORS.bidboard.createNewProject);
      if (!createButton) {
        result.error = "Create New Project button not found";
        result.screenshotPath = await takeScreenshot(page, "create-bidboard-no-button");
        return result;
      }
      await createButton.click();
      await randomDelay(1500, 2500);
    }

    // Wait for the new project form / detail view (name input)
    try {
      await page.waitForSelector(PROCORE_SELECTORS.newProject.nameInput, { timeout: 15000 });
    } catch {
      result.error = "New project form did not appear";
      result.screenshotPath = await takeScreenshot(page, "create-bidboard-no-form");
      return result;
    }

    await randomDelay(1000, 1500);

    // New BidBoard: stage dropdown defaults to SERVICE - ESTIMATING; change to ESTIMATE IN PROGRESS when not service
    if (isNewBidBoardUi && !isService) {
      try {
        // Open the stage dropdown — use version-agnostic partial class match to survive Procore version bumps
        await page.locator('div[class*="StyledPageHeader"] div[class*="StyledSelectArrowContainer"], div[class*="StyledSelectButton"], [role="combobox"]').first().click({ timeout: 8000 });

        await page.waitForTimeout(800);

        // Wait for dropdown to be visible, then click by exact text
        await page.waitForSelector('[role="listbox"], [role="option"]', { timeout: 5000 });
        await page.getByRole('option', { name: 'ESTIMATE IN PROGRESS' }).click({ timeout: 5000 });

        log(`[playwright] Stage set to: ESTIMATE IN PROGRESS`, "playwright");
        await page.waitForTimeout(500);
      } catch (e: any) {
        // Fallback: try getByText directly
        try {
          await page.getByText('ESTIMATE IN PROGRESS', { exact: true }).first().click({ timeout: 3000 });
          log(`[playwright] Stage set via fallback text click`, "playwright");
        } catch (e2: any) {
          log(`[playwright] Could not change stage dropdown: ${e.message}`, "playwright");
        }
      }
      await takeScreenshot(page, "stage-dropdown-attempt");
    } else if (isNewBidBoardUi && isService) {
      log(`[playwright] Stage set to: SERVICE - ESTIMATING`, "playwright");
    }

    // Fill in project name (required)
    const nameInput = await page.$(PROCORE_SELECTORS.newProject.nameInput);
    if (nameInput) {
      await nameInput.click();
      await nameInput.fill(projectData.name);
      await randomDelay(200, 400);
    }

    // Fill in project number if provided
    if (projectData.projectNumber) {
      const numberInput = await page.$(PROCORE_SELECTORS.newProject.numberInput) || (isNewBidBoardUi ? await page.$(PROCORE_SELECTORS.bidboard.newUi.projectNumberInput) : null);
      if (numberInput) {
        await numberInput.click();
        await numberInput.fill(projectData.projectNumber);
        await randomDelay(200, 400);
      }
    }

    if (isNewBidBoardUi) {
      // New UI: office (T-Rock Construction LLC), due date, Add Customer, Add Address
      // Estimator: open the dropdown, clear default, search by name, select
      if (projectData.estimator) {
        log(`Setting estimator: ${projectData.estimator}`, "playwright");
        try {
          // Strategy 1: BidBoard adds aid-estimatorSelector class on the container
          let trigger = page.locator('div.aid-estimatorSelector').locator('div.StyledSelectButton, [role="button"]').first();
          if ((await trigger.count()) === 0) {
            // Strategy 2: aria-label or title attribute containing "estimator"
            trigger = page.locator('[aria-label*="estimator" i], [title*="estimator" i]').first();
          }
          if ((await trigger.count()) === 0) {
            // Strategy 3: XPath — find a StyledSelectButton or role=button immediately following a label with text "Estimator"
            trigger = page.locator('xpath=//label[contains(translate(normalize-space(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"estimator")]/following::*[contains(@class,"StyledSelectButton") or @role="button"][1]').first();
          }
          if ((await trigger.count()) === 0) {
            // Strategy 4: find any div with StyledSelectButton that is NOT inside the office or customer selectors
            const allBtns = page.locator('div.StyledSelectButton');
            const btnCount = await allBtns.count();
            log(`Estimator fallback: found ${btnCount} StyledSelectButton elements. Trying second one (index 1).`, "playwright");
            await takeScreenshot(page, "bidboard-estimator-lookup");
            // Office is usually first; estimator is typically second
            if (btnCount >= 2) {
              trigger = allBtns.nth(1);
            } else if (btnCount === 1) {
              trigger = allBtns.first();
            }
          }
          if ((await trigger.count()) > 0) {
            await trigger.click({ timeout: 8000 });
            await randomDelay(800, 1200);
            // Clear existing value
            const clearBtn = await page.$('button[data-qa="core-select-clear"], button[aria-label="Delete field"], button[aria-label="Clear"]');
            if (clearBtn) {
              await clearBtn.click();
              await randomDelay(500, 800);
            }
            // Type to search
            const searchInput = await page.$('input[data-qa="core-typeahead-input"], input[role="combobox"], input[role="searchbox"]');
            if (searchInput) {
              await searchInput.fill(projectData.estimator);
              await randomDelay(1500, 2500);
              // Wait for dropdown options to appear (longer timeout for slow loads)
              try {
                await page.waitForSelector('div[role="option"], li[role="option"]', { timeout: 9000 });
                const optionLocator = page.locator('div[role="option"], li[role="option"]');
                const optionCount = await optionLocator.count();
                const optionTexts: string[] = [];
                for (let i = 0; i < optionCount; i++) {
                  const text = await optionLocator.nth(i).textContent();
                  if (text) optionTexts.push(text.trim());
                }
                const estimatorLower = projectData.estimator.toLowerCase();
                let matchedOption = optionLocator.first();
                let found = false;
                for (let i = 0; i < optionTexts.length; i++) {
                  if (optionTexts[i].toLowerCase().includes(estimatorLower)) {
                    matchedOption = optionLocator.nth(i);
                    found = true;
                    break;
                  }
                }
                if (found && (await matchedOption.count()) > 0) {
                  await matchedOption.click({ timeout: 5000 });
                  log(`Estimator selected: ${projectData.estimator}`, "playwright");
                } else {
                  log(`Estimator dropdown options available: ${optionTexts.join(', ')}`, "playwright");
                  log(`No estimator option matched "${projectData.estimator}" (continuing)`, "playwright");
                  await page.keyboard.press('Escape');
                }
              } catch {
                log(`Estimator dropdown options not found for "${projectData.estimator}" (continuing)`, "playwright");
                await page.keyboard.press('Escape');
              }
              await randomDelay(500, 1000);
            } else {
              log("Estimator search input not found", "playwright");
              await page.keyboard.press('Escape');
            }
          } else {
            log("Estimator trigger button not found", "playwright");
          }
        } catch (e: any) {
          log(`Estimator selection failed: ${e.message}`, "playwright");
        }
      }
      // Office: always select T-Rock Construction LLC
      try {
        const officeSelector = page.locator('div.aid-officeSelector').first();
        const trigger = officeSelector.locator('div.StyledSelectButton, button[aria-haspopup="listbox"], [role="button"]').first();
        if ((await officeSelector.count()) > 0 && (await trigger.count()) > 0) {
          await trigger.click({ timeout: 15000 });
          await randomDelay(800, 1200);
          const officeOption = page.locator('div[role="option"], li[role="option"]').filter({ hasText: /T-Rock Construction LLC/i }).first();
          await officeOption.click({ timeout: 8000 });
          await randomDelay(300, 500);
        }
      } catch (e: any) {
        log(`Office selection failed: ${e.message}`, "playwright");
      }
      // Due date: try direct input fill first (MM/DD/YYYY), fall back to calendar picker
      if (projectData.bidDueDate) {
        const formattedDate = formatDateForProcore(projectData.bidDueDate);
        log(`Setting due date: raw=${projectData.bidDueDate}, formatted=${formattedDate}`, "playwright");
        try {
          // Try filling the date input directly
          const dueDateInput = await page.$('input[placeholder="MM/DD/YYYY"], input[name="dueDate"], input[type="date"]');
          if (dueDateInput) {
            await dueDateInput.click();
            await dueDateInput.fill('');
            await randomDelay(200, 400);
            await dueDateInput.type(formattedDate, { delay: 50 });
            await dueDateInput.press('Tab');
            await randomDelay(500, 800);
            log(`Due date filled via input: ${formattedDate}`, "playwright");
          } else {
            // Fallback: calendar picker
            log("Due date input not found, trying calendar picker", "playwright");
            const dueDateCalendarBtn = page.locator('div.MuiInputAdornment-root').locator('button').first();
            if ((await dueDateCalendarBtn.count()) > 0) {
              await dueDateCalendarBtn.click();
              await randomDelay(800, 1200);
              const targetDate = new Date(String(projectData.bidDueDate).length === 13 ? parseInt(String(projectData.bidDueDate)) : projectData.bidDueDate);
              if (!isNaN(targetDate.getTime())) {
                const targetMonth = targetDate.getMonth();
                const targetYear = targetDate.getFullYear();
                const targetDay = targetDate.getDate();
                for (let i = 0; i < 24; i++) {
                  const headerText = await page.locator('div.MuiPickersCalendarHeader-labelContainer').textContent();
                  const match = headerText?.match(/(\w+)\s+(\d+)/);
                  if (match) {
                    const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
                    const curMonth = months[match[1]] ?? 0;
                    const curYear = parseInt(match[2], 10) || new Date().getFullYear();
                    if (curMonth === targetMonth && curYear === targetYear) {
                      const dayBtn = page.locator('button.MuiPickersDay-root').filter({ hasText: String(targetDay) }).first();
                      await dayBtn.click({ timeout: 5000 });
                      await randomDelay(500, 800);
                      log(`Due date selected via calendar: ${formattedDate}`, "playwright");
                      break;
                    }
                    const nextBtn = page.locator('button[aria-label="Next month"]');
                    if ((await nextBtn.count()) > 0) await nextBtn.click();
                    await randomDelay(500, 800);
                  }
                }
              }
            } else {
              log("Due date: neither input nor calendar button found", "playwright");
            }
          }
        } catch (e: any) {
          log(`Due date selection failed: ${e.message}`, "playwright");
        }
      } else {
        log("Due date: no bidDueDate provided in project data", "playwright");
      }
      // Add Customer: click + Add Customer, search, select from list, click Select
      if (projectData.clientName) {
        log(`Adding customer: ${projectData.clientName}`, "playwright");
        try {
          // Try multiple selectors for the Add Customer button
          let addCustBtn = await page.$(PROCORE_SELECTORS.bidboard.newUi.addCustomerButton);
          if (!addCustBtn) {
            addCustBtn = await page.$("button:has-text('Add Customer')");
          }
          if (addCustBtn) {
            await addCustBtn.click();
            await randomDelay(1500, 2500);
            const searchInput = await page.$('input[data-qa="core-search-input"], input[placeholder*="Search"], input[placeholder*="search"]');
            if (searchInput) {
              await searchInput.fill(projectData.clientName);
              await randomDelay(2000, 3000);
              const escapedName = projectData.clientName.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const listItem = page.locator('div.aid-listItem, div.MuiListItem-root, [role="option"], li').filter({ hasText: new RegExp(escapedName, "i") }).first();
              try {
                await listItem.click({ force: true, timeout: 8000 });
                await randomDelay(500, 1000);
                log(`Customer list item clicked: ${projectData.clientName}`, "playwright");
              } catch (e: any) {
                log(`Customer list item not found for "${projectData.clientName}": ${e.message}`, "playwright");
              }
              const selectBtn = page.locator('[role="dialog"] button, .MuiDialog-root button').filter({ hasText: /Select/i }).first();
              if ((await selectBtn.count()) > 0) {
                await selectBtn.click();
                await randomDelay(1500, 2500);
                log("Customer selected and dialog closed", "playwright");
              } else {
                // Try confirm button
                const confirmBtn = page.locator('[role="dialog"]').locator('button.aid-confirmButton').first();
                if ((await confirmBtn.count()) > 0) {
                  await confirmBtn.click();
                  await randomDelay(1500, 2500);
                }
              }
            } else {
              log("Customer search input not found in dialog", "playwright");
            }
          } else {
            log("Add Customer button not found on page", "playwright");
          }
        } catch (e: any) {
          log(`Add Customer failed: ${e.message}`, "playwright");
        }
        // Only dismiss dialog if one is still open (avoid Escape on main page which breaks SPA)
        const custDialogStillOpen = await page.locator('[role="dialog"]').isVisible().catch(() => false);
        if (custDialogStillOpen) {
          try {
            await page.keyboard.press('Escape');
            await randomDelay(500, 1000);
          } catch (_) {}
        }
      } else {
        log("Customer: no clientName provided in project data", "playwright");
      }
      // Primary Contact: DISABLED — not needed for RFP→BidBoard flow.
      // Customer Company and Project Address are the required fields.
      // if (projectData.contactName) { ... }
      log("Primary Contact: skipped (not required for RFP flow)", "playwright");
      // Add Address: must run AFTER Add Customer/Contact dialogs are closed
      // Verified March 2026 — click "Add Address" by text (aid-* class removed by Procore),
      // Procore renders two dialog elements; use .last() to get the one with input fields.
      // Fields use placeholder text: "e.g. 123 Comalt St", "e.g. Austin", "e.g. Texas", "e.g. 78702", "e.g. United States"
      if (projectData.address || projectData.city || projectData.state || projectData.zip || projectData.country) {
        log(`Adding address: ${projectData.address || ''}, ${projectData.city || ''}, ${projectData.state || ''} ${projectData.zip || ''}`, "playwright");
        try {
          await randomDelay(2000, 3000);

          // Open Edit Address dialog
          let dialogOpened = false;

          // Approach 1: "Add Address" button (new projects without an address)
          // Try both text-based and class-based selectors; use force:true to bypass any lingering overlay
          const addAddrBtn = page.locator('button:has-text("Add Address"), button.aid-add-address-button').first();
          if ((await addAddrBtn.count()) > 0) {
            await takeScreenshot(page, "bidboard-before-address-click");
            await addAddrBtn.scrollIntoViewIfNeeded().catch(() => {});
            try {
              await addAddrBtn.click({ timeout: 5000 });
              log("Add Address button clicked", "playwright");
            } catch (clickErr: any) {
              log(`Add Address click intercepted: ${clickErr.message?.slice(0, 200)} — retrying with force`, "playwright");
              await addAddrBtn.click({ force: true, timeout: 5000 });
              log("Add Address button clicked with force:true", "playwright");
            }
            await takeScreenshot(page, "bidboard-after-address-click");
            await randomDelay(2000, 3000);
            // Detect dialog: try role="dialog", MUI dialog, native <dialog>, or any overlay with address fields
            dialogOpened = await page.locator('[role="dialog"]:has-text("Edit Address"), .MuiDialog-root:has-text("Edit Address"), dialog:has-text("Edit Address"), [role="dialog"]:has-text("Street"), .MuiDialog-root:has-text("Street")').first().isVisible().catch(() => false);
            if (!dialogOpened) {
              // Fallback: check if address input fields appeared anywhere on page (inline edit)
              dialogOpened = await page.locator('input[placeholder*="Comalt"], input[placeholder*="123 Comalt"]').first().isVisible().catch(() => false);
              if (dialogOpened) log("Address fields detected (inline/non-dialog mode)", "playwright");
            }
            log(`After Add Address click: dialogOpened=${dialogOpened}`, "playwright");
          }

          // Approach 2: Country text button (existing address — click to edit)
          if (!dialogOpened) {
            const countryBtn = page.locator('button:has-text("United States")').first();
            if ((await countryBtn.count()) > 0) {
              await countryBtn.scrollIntoViewIfNeeded().catch(() => {});
              await countryBtn.click({ force: true });
              await randomDelay(1000, 1500);
              dialogOpened = await page.locator('[role="dialog"]:has-text("Edit Address"), .MuiDialog-root:has-text("Edit Address")').isVisible().catch(() => false);
              if (!dialogOpened) {
                const editMenuItem = page.locator('[role="menuitem"]:has-text("Edit")');
                if ((await editMenuItem.count()) > 0) {
                  await editMenuItem.click();
                  await randomDelay(1000, 1500);
                  dialogOpened = await page.locator('[role="dialog"]:has-text("Edit Address"), .MuiDialog-root:has-text("Edit Address")').isVisible().catch(() => false);
                } else {
                  await page.keyboard.press('Escape');
                  await randomDelay(500, 1000);
                }
              }
            }
          }

          if (dialogOpened) {
            await randomDelay(500, 1000);

            // Procore renders two Edit Address dialogs — use .last() to get the one with fields
            const addrDialog = page.locator('dialog:has-text("Edit Address"), [role="dialog"]:has-text("Edit Address"), .MuiDialog-root:has-text("Edit Address")').last();

            // Fill address fields using placeholder-based selectors
            if (projectData.address) {
              const streetInput = addrDialog.locator('input[placeholder*="Comalt"], input[placeholder*="Street"]').first();
              await streetInput.fill(projectData.address);
              log(`Address street filled: ${projectData.address}`, "playwright");
              await page.keyboard.press('Tab');
            }
            if (projectData.city) {
              const cityInput = addrDialog.locator('input[placeholder*="Austin"], input[placeholder*="City"]').first();
              await cityInput.fill(projectData.city);
              await page.keyboard.press('Tab');
            }
            if (projectData.state) {
              const stateAbbrev = normalizeState(projectData.state);
              log(`State normalized: "${projectData.state}" → "${stateAbbrev}"`, "playwright");
              const stateInput = addrDialog.locator('input[placeholder*="Texas"], input[placeholder*="State"]').first();
              await stateInput.fill(stateAbbrev);
              await page.keyboard.press('Escape'); // Dismiss state autocomplete dropdown
            }
            if (projectData.zip) {
              const zipInput = addrDialog.locator('input[placeholder*="78702"], input[placeholder*="ZIP"]').first();
              await zipInput.fill(projectData.zip);
              await page.keyboard.press('Tab');
            }
            if (projectData.country) {
              const countryInput = addrDialog.locator('input[placeholder*="United States"], input[placeholder*="Country"]').first();
              if ((await countryInput.count()) > 0) {
                await countryInput.fill(projectData.country);
                await page.keyboard.press('Tab');
              }
            }

            await new Promise((r) => setTimeout(r, 500)); // Let form settle before Save

            // Click Save within the Edit Address dialog
            const saveBtn = addrDialog.locator('button:has-text("Save")').first();
            if ((await saveBtn.count()) > 0) {
              await saveBtn.click({ force: true });
            } else {
              const fallbackSave = page.locator('button:has-text("Save")').last();
              await fallbackSave.click({ force: true });
            }
            await new Promise((r) => setTimeout(r, 1500));

            // Verify dialog closed; retry Save if still open
            const dialogStillOpen = await page.locator('text=Edit Address').isVisible().catch(() => false);
            if (dialogStillOpen) {
              await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const saveBtn = buttons.find((b) => b.textContent?.trim() === 'Save');
                if (saveBtn) (saveBtn as HTMLButtonElement).click();
              });
              await new Promise((r) => setTimeout(r, 1000));
            }
            log("Address saved", "playwright");
          } else {
            await takeScreenshot(page, "bidboard-address-dialog-not-opened");
            log("Could not open Edit Address dialog — check screenshot", "playwright");
          }
        } catch (e: any) {
          log(`Add Address failed: ${e.message}`, "playwright");
          await takeScreenshot(page, "bidboard-address-error");
        }
      } else {
        log("Address: no address fields provided in project data", "playwright");
      }

      // Fill Project Description (after estimator, due date, customer, address; before save)
      if (projectData.description) {
        const descTextarea = (await page.$('label:has-text("Project Description") + * textarea'))
          || (await page.$('textarea'));
        if (descTextarea) {
          await descTextarea.fill(projectData.description);
          await page.keyboard.press('Tab'); // Trigger blur/save
          await randomDelay(200, 400);
          log(`Project description filled: ${projectData.description}`, "playwright");
          log("Project description saved", "playwright");
        }
      }

      // Capture screenshot after filling all project details (for debugging)
      await takeScreenshot(page, "bidboard-after-details-filled");
    }

    // Legacy UI: fill fields via legacy selectors (skip for new UI — already handled above)
    if (!isNewBidBoardUi) {
      const stageSelect = await page.$(PROCORE_SELECTORS.newProject.stageSelect);
      if (stageSelect) {
        try {
          await stageSelect.selectOption({ label: projectData.stage });
        } catch {
          await stageSelect.click();
          await randomDelay(300, 500);
          const stageOption = await page.$(`option:has-text("${projectData.stage}")`);
          if (stageOption) {
            await stageOption.click();
          }
        }
        await randomDelay(200, 400);
      }

      if (projectData.clientName) {
        const clientInput = await page.$(PROCORE_SELECTORS.newProject.clientNameInput);
        if (clientInput) {
          await clientInput.fill(projectData.clientName);
          await randomDelay(200, 400);
        }
      }

      if (projectData.clientEmail) {
        const emailInput = await page.$(PROCORE_SELECTORS.newProject.clientEmailInput);
        if (emailInput) {
          await emailInput.fill(projectData.clientEmail);
          await randomDelay(200, 400);
        }
      }

      if (projectData.clientPhone) {
        const phoneInput = await page.$(PROCORE_SELECTORS.newProject.clientPhoneInput);
        if (phoneInput) {
          await phoneInput.fill(projectData.clientPhone);
          await randomDelay(200, 400);
        }
      }

      if (projectData.address) {
        const addressInput = await page.$(PROCORE_SELECTORS.newProject.addressInput);
        if (addressInput) {
          await addressInput.fill(projectData.address);
          await randomDelay(200, 400);
        }
      }

      if (projectData.city) {
        const cityInput = await page.$(PROCORE_SELECTORS.newProject.cityInput);
        if (cityInput) {
          await cityInput.fill(projectData.city);
          await randomDelay(200, 400);
        }
      }

      if (projectData.state) {
        const stateInput = await page.$(PROCORE_SELECTORS.newProject.stateInput);
        if (stateInput) {
          const tagName = await stateInput.evaluate(el => el.tagName.toUpperCase());
          if (tagName === 'SELECT') {
            await stateInput.selectOption({ label: projectData.state });
          } else {
            await stateInput.fill(projectData.state);
          }
          await randomDelay(200, 400);
        }
      }

      if (projectData.zip) {
        const zipInput = await page.$(PROCORE_SELECTORS.newProject.zipInput);
        if (zipInput) {
          await zipInput.fill(projectData.zip);
          await randomDelay(200, 400);
        }
      }

      if (projectData.description) {
        const descInput = await page.$(PROCORE_SELECTORS.newProject.descriptionInput);
        if (descInput) {
          await descInput.fill(projectData.description);
          await randomDelay(200, 400);
        }
      }

      if (projectData.bidDueDate) {
        const dueDateInput = await page.$(PROCORE_SELECTORS.newProject.bidDueDateInput);
        if (dueDateInput) {
          await dueDateInput.fill(projectData.bidDueDate);
          await randomDelay(200, 400);
        }
      }
    }

    // Click Create/Save button (legacy modal only); new UI auto-saves on blur
    if (!isNewBidBoardUi) {
      const submitButton = await page.$(PROCORE_SELECTORS.newProject.createButton);
      if (submitButton) {
        await submitButton.scrollIntoViewIfNeeded().catch(() => {});
        await randomDelay(200, 400);
        await submitButton.click({ force: true });
        await randomDelay(2000, 3000);
      } else {
        result.error = "Create button not found in form";
        result.screenshotPath = await takeScreenshot(page, "create-bidboard-no-submit");
        return result;
      }
    }

    // Wait for navigation or success indicator
    await page.waitForLoadState("load").catch(() => {});

    // Check for success - extract project ID from URL (new UI: /project/ID/, legacy: /bidding/ID/)
    // New BidBoard UI is an SPA — the URL may not update immediately after auto-save.
    // Poll for up to 10 seconds for the URL to contain a project ID.
    let projectIdFromUrl: string | null = null;
    for (let poll = 0; poll < 5; poll++) {
      const currentUrl = page.url();
      const newUiProjectMatch = currentUrl.match(/\/tools\/bid-board\/project\/(\d+)/);
      const legacyMatch = currentUrl.match(/\/(?:bidding|projects)\/(\d+)/);
      projectIdFromUrl = newUiProjectMatch?.[1] || legacyMatch?.[1] || null;
      if (projectIdFromUrl) {
        const proposalIdMatch = currentUrl.match(/proposalId=(\d+)/);
        if (proposalIdMatch) result.proposalId = proposalIdMatch[1];
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (projectIdFromUrl) {
      result.projectId = projectIdFromUrl;
      result.success = true;
      log(`Successfully created BidBoard project: ${projectData.name} (ID: ${result.projectId}${result.proposalId ? `, proposalId: ${result.proposalId}` : ''})`, "playwright");
      await takeScreenshot(page, "bidboard-project-created");
    }

    // Fallback for new UI: extract project ID from the current page URL only (not from links on the page,
    // which could belong to other projects on the BidBoard list)
    if (!result.success && isNewBidBoardUi) {
      try {
        // Check if the URL now contains a project ID (SPA may have updated after form save)
        const currentUrl2 = page.url();
        const urlMatch2 = currentUrl2.match(/\/tools\/bid-board\/project\/(\d+)/);
        if (urlMatch2) {
          result.projectId = urlMatch2[1];
          result.success = true;
          log(`BidBoard project ID from URL (delayed): ${result.projectId}`, "playwright");
        }
      } catch (e: any) {
        log(`URL re-check failed: ${e.message}`, "playwright");
      }
    }

    // Fallback: search by project number using Procore API
    if (!result.success && projectData.projectNumber) {
      try {
        const { getProcoreClient } = await import("../procore");
        const client = await getProcoreClient();
        const companyId = await getCompanyId();
        if (companyId) {
          const searchRes = await client.get(`/rest/v1.1/companies/${companyId}/projects?filters[search]=${encodeURIComponent(projectData.projectNumber)}&per_page=5`);
          const projects = Array.isArray(searchRes.data) ? searchRes.data : [];
          const match = projects.find((p: any) =>
            p.project_number === projectData.projectNumber || p.name === projectData.name
          );
          if (match?.id) {
            result.projectId = String(match.id);
            result.success = true;
            log(`BidBoard project found via API search: ${result.projectId} (project number: ${projectData.projectNumber})`, "playwright");
          }
        }
      } catch (apiErr: any) {
        log(`API project search failed: ${apiErr.message}`, "playwright");
      }
    }

    if (!result.success) {
      // Check for success toast/message
      const successMsg = await page.$(PROCORE_SELECTORS.newProject.successMessage);
      if (successMsg) {
        result.success = true;
        log(`Successfully created BidBoard project: ${projectData.name}`, "playwright");
      } else {
        // Check for error message
        const errorMsg = await page.$(PROCORE_SELECTORS.newProject.errorMessage);
        if (errorMsg) {
          const errorText = await errorMsg.textContent();
          result.error = `Project creation failed: ${errorText}`;
        } else {
          result.error = "Could not confirm project creation";
        }
        result.screenshotPath = await takeScreenshot(page, "create-bidboard-uncertain");
      }
    }

    // Log the automation action
    await storage.createBidboardAutomationLog({
      projectId: result.projectId || undefined,
      projectName: projectData.name,
      action: "create_project",
      status: result.success ? "success" : "failed",
      details: {
        stage: projectData.stage,
        clientName: projectData.clientName,
        hubspotTrigger: true,
      },
      errorMessage: result.error,
      screenshotPath: result.screenshotPath,
    });

  } catch (err: any) {
    result.error = err.message || "Unknown error during project creation";
    result.screenshotPath = await takeScreenshot(page, "create-bidboard-error");
    log(`Error creating BidBoard project: ${result.error}`, "playwright");
    
    await storage.createBidboardAutomationLog({
      projectName: projectData.name,
      action: "create_project",
      status: "failed",
      details: { stage: projectData.stage },
      errorMessage: result.error,
      screenshotPath: result.screenshotPath,
    });
  }

  return result;
}

// Extended result type to include document sync info
export interface CreateBidBoardProjectFromDealResult extends CreateBidBoardProjectResult {
  documentsUploaded?: number;
  documentErrors?: string[];
}

// Create BidBoard project from HubSpot deal data and sync documents
/** Look up the first associated contact's name from the deal's associatedContactIds */
async function getAssociatedContactName(deal: any): Promise<string | null> {
  try {
    const contactIds = deal.associatedContactIds;
    if (!contactIds) return null;
    // contactIds may be a comma-separated string or JSON array
    const ids = typeof contactIds === "string"
      ? contactIds.split(",").map((s: string) => s.trim()).filter(Boolean)
      : Array.isArray(contactIds) ? contactIds : [];
    if (ids.length === 0) return null;
    const contact = await storage.getHubspotContactByHubspotId(ids[0]);
    if (!contact) return null;
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    return name || null;
  } catch {
    return null;
  }
}

export async function createBidBoardProjectFromDeal(
  dealId: string,
  initialStage: string = "Estimate in Progress",
  options: {
    syncDocuments?: boolean;
    attachmentsOverride?: Array<{ name: string; url?: string; localPath?: string; type?: string; size?: number }>;
    /** HubSpot project_number custom field (e.g. ATL-5-06326-af) - takes precedence over deal properties */
    projectNumberOverride?: string;
    /** RFP approval edited fields - overrides deal properties when present */
    editedFieldsOverride?: Record<string, string>;
    /** proposalId for BidBoard URL */
    proposalId?: string;
  } = { syncDocuments: true }
): Promise<CreateBidBoardProjectFromDealResult> {
  // Fetch deal data from database
  const deal = await storage.getHubspotDealByHubspotId(dealId);
  
  if (!deal) {
    return {
      success: false,
      error: `HubSpot deal ${dealId} not found in database`,
    };
  }

  // Extract properties from deal; RFP editedFields override when present
  const properties = (deal.properties || {}) as Record<string, any>;
  const ed = options.editedFieldsOverride || {};
  const get = (dealVal: string | undefined, propKey: string) =>
    (ed[propKey] && String(ed[propKey]).trim()) || dealVal || properties[propKey];

  const projectNumber = options.projectNumberOverride ?? ed.project_number ?? properties.project_number ?? undefined;
  const projectData: NewBidBoardProjectData = {
    name: get(deal.dealName ?? undefined, "dealname") || deal.dealName || `Deal ${dealId}`,
    projectNumber: projectNumber ?? undefined,
    stage: initialStage,
    projectTypes: (ed.project_types ?? properties.project_types) ?? undefined,
    estimator: get(undefined, "estimator"),
    clientName: get(deal.associatedCompanyName ?? undefined, "company_name") || deal.associatedCompanyName || properties.company_name || undefined,
    contactName: get(undefined, "contact_name") || properties.contact_name || await getAssociatedContactName(deal) || undefined,
    clientEmail: get(undefined, "client_email") || properties.client_email || properties.contact_email || undefined,
    clientPhone: get(undefined, "client_phone") || properties.client_phone || properties.contact_phone || undefined,
    address: get(undefined, "address") || properties.address || properties.street_address || undefined,
    city: get(undefined, "city") || properties.city || undefined,
    state: get(undefined, "state") || properties.state || properties.state_region || undefined,
    zip: get(undefined, "zip") || properties.zip || properties.postal_code || undefined,
    country: get(undefined, "country") || properties.country || undefined,
    description: get(undefined, "description") || properties.description || properties.project_description__briefly_describe_the_project_ || properties.project_description || properties.notes || undefined,
    bidDueDate: get(undefined, "bid_due_date") || properties.bid_due_date || properties.due_date || undefined,
    proposalId: options.proposalId,
  };

  log(`Creating BidBoard project from HubSpot deal: ${deal.dealName} (${dealId})`, "playwright");
  log(`Project data — clientName: ${projectData.clientName || 'NONE'}, contactName: ${projectData.contactName || 'NONE'}, bidDueDate: ${projectData.bidDueDate || 'NONE'}, address: ${projectData.address || 'NONE'}, city: ${projectData.city || 'NONE'}, state: ${projectData.state || 'NONE'}, description: ${projectData.description ? 'SET' : 'NONE'}, estimator: ${projectData.estimator || 'NONE'}`, "playwright");
  
  const result: CreateBidBoardProjectFromDealResult = await createBidBoardProject(projectData);
  
  // If successful, verify description was saved and retry if missing
  if (result.success && result.projectId && projectData.description) {
    const DESC_MAX_ATTEMPTS = 3;
    const DESC_RETRY_DELAY_MS = 3000;
    for (let attempt = 1; attempt <= DESC_MAX_ATTEMPTS; attempt++) {
      try {
        const { page: descPage, success: loggedIn } = await ensureLoggedIn();
        if (!loggedIn || !descPage) break;

        await navigateToProject(descPage, result.projectId);
        await descPage.waitForLoadState("load").catch(() => {});
        await randomDelay(1500, 2500);

        // Check if description is already filled
        const descTextarea = await descPage.$('textarea[name="description"], textarea');
        if (descTextarea) {
          const currentDesc = await descTextarea.inputValue().catch(() => '');
          if (currentDesc && currentDesc.trim().length > 0) {
            log(`[rfp-approval] Description already present on project ${result.projectId}`, "playwright");
            break;
          }
          // Description is empty — fill it
          log(`[rfp-approval] Description missing on project ${result.projectId}, filling (attempt ${attempt}/${DESC_MAX_ATTEMPTS})`, "playwright");
          await descTextarea.click();
          await descTextarea.fill(projectData.description);
          await descPage.keyboard.press('Tab');
          await randomDelay(1000, 2000);
          log(`[rfp-approval] Description saved on project ${result.projectId}`, "playwright");
          break;
        }
      } catch (descErr: any) {
        log(`[rfp-approval] Description retry failed (attempt ${attempt}/${DESC_MAX_ATTEMPTS}): ${descErr.message}`, "playwright");
        if (attempt < DESC_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, DESC_RETRY_DELAY_MS));
        }
      }
    }
  }

  if (result.success && result.projectId) {
    // Create sync mapping
    try {
      await storage.createSyncMapping({
        hubspotDealId: dealId,
        hubspotDealName: deal.dealName,
        bidboardProjectId: result.projectId,
        bidboardProjectName: projectData.name,
        procoreProjectNumber: projectNumber || null,
        projectPhase: "bidboard",
        lastSyncAt: new Date(),
        lastSyncStatus: "created_from_hubspot",
        lastSyncDirection: "hubspot_to_procore",
        metadata: result.proposalId ? { proposalId: result.proposalId } : undefined,
      });
      log(`Created sync mapping for deal ${dealId} → BidBoard ${result.projectId}`, "playwright");
    } catch (err: any) {
      log(`Warning: Could not create sync mapping: ${err.message}`, "playwright");
    }

    // Sync documents and photos to BidBoard (with retry)
    if (options.syncDocuments !== false) {
      const DOC_SYNC_MAX_ATTEMPTS = 3;
      const DOC_SYNC_RETRY_DELAY_MS = 5000;
      let docSyncSuccess = false;

      for (let attempt = 1; attempt <= DOC_SYNC_MAX_ATTEMPTS; attempt++) {
        try {
          const { syncHubSpotAttachmentsToBidBoard, syncAttachmentsListToBidBoard } = await import("./documents");
          let docResult: { success: boolean; documentsUploaded: number; documentsDownloaded: number; errors: string[] };
          if (Array.isArray(options.attachmentsOverride)) {
            log(`Syncing ${options.attachmentsOverride.length} attachments (override) to BidBoard project ${result.projectId} (attempt ${attempt}/${DOC_SYNC_MAX_ATTEMPTS})`, "playwright");
            docResult = await syncAttachmentsListToBidBoard(result.projectId!, options.attachmentsOverride);
          } else {
            log(`Syncing documents from HubSpot deal ${dealId} to BidBoard project ${result.projectId} (attempt ${attempt}/${DOC_SYNC_MAX_ATTEMPTS})`, "playwright");
            docResult = await syncHubSpotAttachmentsToBidBoard(result.projectId!, dealId);
          }

          result.documentsUploaded = docResult.documentsUploaded;
          result.documentErrors = docResult.errors;

          if (docResult.success) {
            log(`Successfully synced ${docResult.documentsUploaded} documents to BidBoard project ${result.projectId}`, "playwright");
            docSyncSuccess = true;
          } else if (docResult.documentsUploaded > 0) {
            log(`Partially synced ${docResult.documentsUploaded} documents to BidBoard (some errors)`, "playwright");
            docSyncSuccess = true; // partial is acceptable
          } else {
            log(`No documents found or sync failed for BidBoard project ${result.projectId}`, "playwright");
          }

          await storage.createBidboardAutomationLog({
            projectId: result.projectId,
            projectName: projectData.name,
            action: "sync_hubspot_documents",
            status: docResult.success ? "success" : (docResult.documentsUploaded > 0 ? "partial" : "failed"),
            details: {
              hubspotDealId: dealId,
              documentsFound: docResult.documentsDownloaded,
              documentsUploaded: docResult.documentsUploaded,
              attempt,
            },
            errorMessage: docResult.errors.length > 0 ? docResult.errors.join(", ") : undefined,
          });

          if (docSyncSuccess) break;
        } catch (docErr: any) {
          log(`Error syncing documents (attempt ${attempt}/${DOC_SYNC_MAX_ATTEMPTS}): ${docErr.message}`, "playwright");
          result.documentErrors = [docErr.message];

          await storage.createBidboardAutomationLog({
            projectId: result.projectId,
            projectName: projectData.name,
            action: "sync_hubspot_documents",
            status: "failed",
            details: { hubspotDealId: dealId, attempt },
            errorMessage: docErr.message,
          });
        }

        if (!docSyncSuccess && attempt < DOC_SYNC_MAX_ATTEMPTS) {
          log(`Retrying document sync in ${DOC_SYNC_RETRY_DELAY_MS / 1000}s...`, "playwright");
          await new Promise((r) => setTimeout(r, DOC_SYNC_RETRY_DELAY_MS));
        }
      }
    }
  }

  // Close browser after completion to free resources
  try {
    const { closeBrowser } = await import("./browser");
    await closeBrowser();
  } catch (e) {
    log(`Could not close browser: ${e}`, "playwright");
  }
  
  return result;
}
