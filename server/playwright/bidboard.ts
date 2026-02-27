import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { PROCORE_SELECTORS, getBidBoardUrl } from "./selectors";
import { randomDelay, takeScreenshot, withRetry, waitForNavigation } from "./browser";
import { log } from "../index";
import { storage } from "../storage";

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

async function getCompanyId(): Promise<string | null> {
  const config = await storage.getAutomationConfig("procore_config");
  return (config?.value as any)?.companyId || null;
}

async function isSandbox(): Promise<boolean> {
  const credentials = await storage.getAutomationConfig("procore_browser_credentials");
  return (credentials?.value as any)?.sandbox || false;
}

export async function navigateToBidBoard(page: Page): Promise<boolean> {
  const companyId = await getCompanyId();
  if (!companyId) {
    log("Procore company ID not configured", "playwright");
    return false;
  }
  
  const sandbox = await isSandbox();
  const bidboardUrl = getBidBoardUrl(companyId, sandbox);
  
  log(`Navigating to BidBoard: ${bidboardUrl}`, "playwright");
  await page.goto(bidboardUrl, { waitUntil: "networkidle" });
  
  await randomDelay(2000, 3000);
  
  // Wait for BidBoard to load
  try {
    await page.waitForSelector(PROCORE_SELECTORS.bidboard.container, { timeout: 15000 });
    return true;
  } catch {
    // Try alternative selectors
    try {
      await page.waitForSelector(PROCORE_SELECTORS.bidboard.projectList, { timeout: 10000 });
      return true;
    } catch {
      const screenshotPath = await takeScreenshot(page, "bidboard-not-found");
      log(`BidBoard not found. Screenshot: ${screenshotPath}`, "playwright");
      return false;
    }
  }
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
  const baseUrl = sandbox ? "https://sandbox.procore.com" : "https://app.procore.com";
  const projectUrl = `${baseUrl}/${companyId}/company/bidding/${projectId}`;
  
  log(`Navigating to project: ${projectUrl}`, "playwright");
  await page.goto(projectUrl, { waitUntil: "networkidle" });
  
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
