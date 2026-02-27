import { runBidBoardScrape, BidBoardProject, BidBoardSyncResult, navigateToProject, getProjectDetails, syncHubSpotClientToBidBoard } from "./playwright/bidboard";
import { ensureLoggedIn } from "./playwright/auth";
import { closeBrowser } from "./playwright/browser";
import { syncHubSpotAttachmentsToBidBoard } from "./playwright/documents";
import { log } from "./index";
import { storage } from "./storage";

// Stage mapping from Procore BidBoard to HubSpot
// Note: HubSpot stage IDs should match your actual pipeline stage internal values
// These label mappings are used as fallback if database stage_mappings aren't configured
const BIDBOARD_TO_HUBSPOT_STAGE: Record<string, string> = {
  // Procore Stage → HubSpot Stage (internal ID or label)
  "Estimate in Progress": "estimating",
  "Service – Estimating": "service_estimating",
  "Service - Estimating": "service_estimating", // Alternative dash character
  "Estimate under review": "internal_review",
  "Estimate sent to Client": "proposal_sent",
  "Service – sent to production": "service_won",
  "Service - sent to production": "service_won", // Alternative dash character
  "Sent to production": "closedwon",
  "Service – lost": "service_lost",
  "Service - lost": "service_lost", // Alternative dash character
  "Production – lost": "closedlost",
  "Production - lost": "closedlost", // Alternative dash character
};

// Stages that trigger Portfolio transition (project moves to Procore Portfolio)
const PORTFOLIO_TRIGGER_STAGES = [
  "Sent to production",
  "Service – sent to production",
  "Service - sent to production",
];

interface StageChangeResult {
  projectId: string;
  projectName: string;
  hubspotDealId?: string;
  previousStage: string | null;
  newStage: string;
  hubspotStage?: string;
  success: boolean;
  error?: string;
}

interface AutomationResult {
  success: boolean;
  projectsScraped: number;
  stageChanges: StageChangeResult[];
  portfolioTransitions: string[];
  errors: string[];
  timestamp: Date;
}

async function logAutomationAction(
  projectId: string | null,
  projectName: string | null,
  action: string,
  status: "success" | "failed" | "pending",
  details?: Record<string, any>,
  errorMessage?: string,
  screenshotPath?: string
): Promise<void> {
  await storage.createBidboardAutomationLog({
    projectId: projectId || undefined,
    projectName: projectName || undefined,
    action,
    status,
    details,
    errorMessage,
    screenshotPath,
  });
}

async function findHubSpotDealForProject(project: BidBoardProject): Promise<string | null> {
  // First, check sync_mappings by Procore project ID
  const mappingByProcoreId = await storage.getSyncMappingByProcoreProjectId(project.id);
  
  if (mappingByProcoreId?.hubspotDealId) {
    return mappingByProcoreId.hubspotDealId;
  }
  
  // Try to match by name in deals
  const { data: deals } = await storage.getHubspotDeals({ search: project.name, limit: 1 });
  
  if (deals.length > 0 && deals[0].hubspotId) {
    return deals[0].hubspotId;
  }
  
  // Try to match by project number in deal properties
  if (project.projectNumber) {
    const { data: dealsByNumber } = await storage.getHubspotDeals({ search: project.projectNumber, limit: 1 });
    
    if (dealsByNumber.length > 0 && dealsByNumber[0].hubspotId) {
      return dealsByNumber[0].hubspotId;
    }
  }
  
  return null;
}

async function updateHubSpotDealStage(
  dealId: string,
  hubspotStage: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Import HubSpot update function
    const { updateHubSpotDealStage: hubspotUpdate } = await import("./hubspot");
    
    await hubspotUpdate(dealId, hubspotStage);
    
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

export async function syncBidBoardStageToHubSpot(
  change: BidBoardSyncResult["changes"][0]
): Promise<StageChangeResult> {
  const result: StageChangeResult = {
    projectId: change.projectId,
    projectName: change.projectName,
    previousStage: change.previousStage,
    newStage: change.newStage,
    success: false,
  };
  
  // Find corresponding HubSpot deal
  const hubspotDealId = await findHubSpotDealForProject({
    id: change.projectId,
    name: change.projectName,
    stage: change.newStage,
  });
  
  if (!hubspotDealId) {
    result.error = "No matching HubSpot deal found";
    await logAutomationAction(
      change.projectId,
      change.projectName,
      "stage_sync_to_hubspot",
      "failed",
      { previousStage: change.previousStage, newStage: change.newStage },
      result.error
    );
    return result;
  }
  
  result.hubspotDealId = hubspotDealId;
  
  // Map BidBoard stage to HubSpot stage
  const hubspotStage = await getHubSpotStageForBidBoard(change.newStage);
  if (!hubspotStage) {
    result.error = `No HubSpot stage mapping for BidBoard stage: ${change.newStage}`;
    await logAutomationAction(
      change.projectId,
      change.projectName,
      "stage_sync_to_hubspot",
      "failed",
      { previousStage: change.previousStage, newStage: change.newStage, hubspotDealId },
      result.error
    );
    return result;
  }
  
  result.hubspotStage = hubspotStage;
  
  // Update HubSpot deal
  const updateResult = await updateHubSpotDealStage(hubspotDealId, hubspotStage);
  
  if (updateResult.success) {
    result.success = true;
    await logAutomationAction(
      change.projectId,
      change.projectName,
      "stage_sync_to_hubspot",
      "success",
      {
        previousStage: change.previousStage,
        newStage: change.newStage,
        hubspotDealId,
        hubspotStage,
      }
    );
    
    log(`Synced stage change for ${change.projectName}: ${change.previousStage} -> ${change.newStage} (HubSpot: ${hubspotStage})`, "bidboard");
  } else {
    result.error = updateResult.error;
    await logAutomationAction(
      change.projectId,
      change.projectName,
      "stage_sync_to_hubspot",
      "failed",
      {
        previousStage: change.previousStage,
        newStage: change.newStage,
        hubspotDealId,
        hubspotStage,
      },
      updateResult.error
    );
  }
  
  return result;
}

async function getHubSpotStageForBidBoard(bidboardStage: string): Promise<string | null> {
  // First check database stage mappings
  const stageMappings = await storage.getStageMappings();
  const mapping = stageMappings.find(
    m => m.procoreStageLabel.toLowerCase() === bidboardStage.toLowerCase() && m.isActive
  );
  
  if (mapping?.hubspotStage) {
    return mapping.hubspotStage;
  }
  
  // Fall back to hardcoded mapping
  return BIDBOARD_TO_HUBSPOT_STAGE[bidboardStage] || null;
}

async function shouldTriggerPortfolio(stage: string): Promise<boolean> {
  // First check database stage mappings for triggerPortfolio flag
  const stageMappings = await storage.getStageMappings();
  const mapping = stageMappings.find(
    m => m.procoreStageLabel.toLowerCase() === stage.toLowerCase() && m.triggerPortfolio
  );
  
  if (mapping) {
    return true;
  }
  
  // Fall back to hardcoded portfolio trigger stages
  return PORTFOLIO_TRIGGER_STAGES.some(
    triggerStage => triggerStage.toLowerCase() === stage.toLowerCase()
  );
}

export async function runBidBoardPolling(): Promise<AutomationResult> {
  const result: AutomationResult = {
    success: false,
    projectsScraped: 0,
    stageChanges: [],
    portfolioTransitions: [],
    errors: [],
    timestamp: new Date(),
  };
  
  log("Starting BidBoard polling automation", "bidboard");
  
  try {
    // Check if automation is enabled
    const config = await storage.getAutomationConfig("bidboard_automation");
    if (!(config?.value as any)?.enabled) {
      log("BidBoard automation is disabled", "bidboard");
      result.errors.push("BidBoard automation is disabled");
      return result;
    }
    
    // Run the scrape
    const scrapeResult = await runBidBoardScrape();
    
    result.projectsScraped = scrapeResult.projects.length;
    result.errors.push(...scrapeResult.errors);
    
    if (scrapeResult.errors.length > 0) {
      log(`BidBoard scrape had errors: ${scrapeResult.errors.join(", ")}`, "bidboard");
    }
    
    // Process stage changes
    for (const change of scrapeResult.changes) {
      const stageResult = await syncBidBoardStageToHubSpot(change);
      result.stageChanges.push(stageResult);
      
      // Check if this stage triggers Portfolio transition
      if (stageResult.success && await shouldTriggerPortfolio(change.newStage)) {
        result.portfolioTransitions.push(change.projectId);
        // Portfolio transition will be handled separately
        log(`Project ${change.projectName} queued for Portfolio transition`, "bidboard");
      }
    }
    
    result.success = result.errors.length === 0;
    
    log(`BidBoard polling complete: ${result.projectsScraped} projects, ${result.stageChanges.length} stage changes`, "bidboard");
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`BidBoard polling error: ${errorMessage}`, "bidboard");
  } finally {
    // Don't close browser to maintain session
  }
  
  return result;
}

export async function getAutomationStatus(): Promise<{
  enabled: boolean;
  lastRun?: Date;
  lastResult?: AutomationResult;
  projectCount: number;
  pendingPortfolioTransitions: number;
}> {
  const config = await storage.getAutomationConfig("bidboard_automation");
  const lastResultConfig = await storage.getAutomationConfig("bidboard_last_result");
  
  const syncStates = await storage.getBidboardSyncStates();
  const projectCount = syncStates.length;
  
  // Count projects with stages that trigger portfolio but haven't been transitioned
  const pendingTransitions = 0; // Would need additional tracking
  
  return {
    enabled: (config?.value as any)?.enabled || false,
    lastRun: lastResultConfig?.updatedAt || undefined,
    lastResult: lastResultConfig?.value as AutomationResult | undefined,
    projectCount,
    pendingPortfolioTransitions: pendingTransitions,
  };
}

export async function enableBidBoardAutomation(enabled: boolean): Promise<void> {
  await storage.upsertAutomationConfig({
    key: "bidboard_automation",
    value: { enabled },
    description: "BidBoard automation enabled/disabled state",
  });
  log(`BidBoard automation ${enabled ? "enabled" : "disabled"}`, "bidboard");
}

export async function manualSyncProject(projectId: string): Promise<StageChangeResult | null> {
  try {
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      log(`Failed to log in for manual sync: ${error}`, "bidboard");
      return null;
    }
    
    const project = await getProjectDetails(page, projectId);
    
    if (!project) {
      log(`Project ${projectId} not found`, "bidboard");
      return null;
    }
    
    // Get previous state
    const previousState = await storage.getBidboardSyncState(projectId);
    
    // Sync to HubSpot
    const result = await syncBidBoardStageToHubSpot({
      projectId: project.id,
      projectName: project.name,
      previousStage: previousState?.currentStage || null,
      newStage: project.stage,
      changeType: previousState ? "updated" : "new",
    });
    
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Manual sync error: ${errorMessage}`, "bidboard");
    return null;
  }
}

export async function onBidBoardProjectCreated(
  projectId: string,
  hubspotDealId: string,
  options: {
    syncClientData?: boolean;
    syncAttachments?: boolean;
  } = {}
): Promise<{
  success: boolean;
  clientDataSynced: boolean;
  attachmentsSynced: boolean;
  documentsUploaded: number;
  errors: string[];
}> {
  const result = {
    success: false,
    clientDataSynced: false,
    attachmentsSynced: false,
    documentsUploaded: 0,
    errors: [] as string[],
  };

  try {
    log(`Processing new BidBoard project ${projectId} linked to HubSpot deal ${hubspotDealId}`, "bidboard");

    if (options.syncClientData !== false) {
      try {
        const clientResult = await syncHubSpotClientToBidBoard(projectId, hubspotDealId);
        if (clientResult.success) {
          result.clientDataSynced = true;
          log(`Client data synced for project ${projectId}`, "bidboard");
        } else {
          result.errors.push(`Client data sync failed: ${clientResult.error}`);
          log(`Client data sync failed for project ${projectId}: ${clientResult.error}`, "bidboard");
        }
      } catch (err: any) {
        result.errors.push(`Client data sync error: ${err.message}`);
        log(`Client data sync error for project ${projectId}: ${err.message}`, "bidboard");
      }
    }

    if (options.syncAttachments !== false) {
      try {
        const attachmentResult = await syncHubSpotAttachmentsToBidBoard(projectId, hubspotDealId);
        if (attachmentResult.success) {
          result.attachmentsSynced = true;
          result.documentsUploaded = attachmentResult.documentsUploaded;
          log(`Synced ${attachmentResult.documentsUploaded} attachments for project ${projectId}`, "bidboard");
        } else {
          result.errors.push(...attachmentResult.errors);
          log(`Attachment sync failed for project ${projectId}: ${attachmentResult.errors.join(', ')}`, "bidboard");
        }
      } catch (err: any) {
        result.errors.push(`Attachment sync error: ${err.message}`);
        log(`Attachment sync error for project ${projectId}: ${err.message}`, "bidboard");
      }
    }

    result.success = result.errors.length === 0;

    await logAutomationAction(
      projectId,
      null,
      "new_project_setup",
      result.success ? "success" : "failed",
      {
        hubspotDealId,
        clientDataSynced: result.clientDataSynced,
        attachmentsSynced: result.attachmentsSynced,
        documentsUploaded: result.documentsUploaded,
      },
      result.errors.length > 0 ? result.errors.join("; ") : undefined
    );

    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    log(`Error processing new project ${projectId}: ${error.message}`, "bidboard");
    return result;
  }
}

export async function detectAndProcessNewProjects(): Promise<{
  newProjects: string[];
  processed: number;
  errors: string[];
}> {
  const result = {
    newProjects: [] as string[],
    processed: 0,
    errors: [] as string[],
  };

  try {
    const scrapeResult = await runBidBoardScrape();

    for (const change of scrapeResult.changes) {
      if (change.changeType === "new") {
        result.newProjects.push(change.projectId);

        const hubspotDealId = await findHubSpotDealForProject({
          id: change.projectId,
          name: change.projectName,
          stage: change.newStage,
        });

        if (hubspotDealId) {
          const setupResult = await onBidBoardProjectCreated(change.projectId, hubspotDealId);
          if (setupResult.success) {
            result.processed++;
          } else {
            result.errors.push(...setupResult.errors);
          }
        } else {
          log(`No HubSpot deal found for new project ${change.projectName}, skipping auto-setup`, "bidboard");
        }
      }
    }

    log(`Detected ${result.newProjects.length} new projects, processed ${result.processed}`, "bidboard");
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    log(`Error detecting new projects: ${error.message}`, "bidboard");
    return result;
  }
}
