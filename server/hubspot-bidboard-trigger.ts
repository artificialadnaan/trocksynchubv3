/**
 * HubSpot → BidBoard Trigger Module
 * ==================================
 * 
 * This module handles automatic creation of Procore BidBoard projects
 * when HubSpot deals move to specific stages (e.g., "RFP").
 * 
 * Workflow:
 * 1. HubSpot webhook fires when deal stage changes
 * 2. Check if new stage is a trigger stage (e.g., "RFP")
 * 3. If yes, create BidBoard project via Playwright automation
 * 4. Upload HubSpot attachments to new BidBoard project
 * 5. Create sync mapping linking deal to project
 * 
 * Trigger Stage Mapping:
 * HubSpot Stage    → BidBoard Stage
 * ──────────────────────────────────────
 * "RFP"            → "Estimate in Progress"
 * "Service RFP"    → "Service – Estimating"
 * 
 * Features:
 * - Configurable trigger stages (via database)
 * - Enable/disable via automation config
 * - Document sync from HubSpot to new project
 * - Audit logging of all actions
 * 
 * Key Functions:
 * - processDealStageChange(): Main webhook handler
 * - isTriggerEnabled(): Check if automation is enabled
 * - getTriggerStages(): Get configured trigger stages
 * - triggerBidBoardCreationForDeal(): Create project for deal
 * 
 * Automation Config Keys:
 * - hubspot_bidboard_auto_create: Enable/disable (disabled by default)
 * - hubspot_bidboard_trigger_stages: Custom trigger stage configuration
 * 
 * @module hubspot-bidboard-trigger
 */

import { storage } from "./storage";
import { createBidBoardProjectFromDeal } from "./playwright/bidboard";

// Configuration for which HubSpot stages trigger BidBoard project creation
// and which initial BidBoard stage to use
interface TriggerStageConfig {
  hubspotStageId: string;
  hubspotStageLabel: string;
  bidboardStage: string; // "Estimate in Progress" or "Service – Estimating"
}

// Default trigger stages - these can be overridden via database configuration
const DEFAULT_TRIGGER_STAGES: TriggerStageConfig[] = [
  {
    hubspotStageId: "rfp",
    hubspotStageLabel: "RFP",
    bidboardStage: "Estimate in Progress",
  },
  {
    hubspotStageId: "service_rfp",
    hubspotStageLabel: "Service RFP",
    bidboardStage: "Service – Estimating",
  },
];

async function getTriggerStages(): Promise<TriggerStageConfig[]> {
  try {
    const config = await storage.getAutomationConfig("hubspot_bidboard_trigger_stages");
    if (config?.value && Array.isArray((config.value as any).stages)) {
      return (config.value as any).stages;
    }
  } catch (e) {
    console.log("[hubspot-bidboard] Using default trigger stages");
  }
  return DEFAULT_TRIGGER_STAGES;
}

async function isTriggerEnabled(): Promise<boolean> {
  try {
    const config = await storage.getAutomationConfig("hubspot_bidboard_auto_create");
    return (config?.value as any)?.enabled === true;
  } catch {
    return false;
  }
}

export async function processDealStageChange(
  dealId: string,
  newStageId: string
): Promise<{ triggered: boolean; result?: any; reason?: string }> {
  // Check if automation is enabled
  const enabled = await isTriggerEnabled();
  if (!enabled) {
    return { triggered: false, reason: "automation_disabled" };
  }

  // Get trigger stage configuration
  const triggerStages = await getTriggerStages();
  
  // Find matching trigger stage
  const triggerConfig = triggerStages.find(
    (ts) => ts.hubspotStageId.toLowerCase() === newStageId.toLowerCase()
  );
  
  if (!triggerConfig) {
    // Stage doesn't trigger BidBoard creation
    return { triggered: false, reason: "stage_not_configured_for_trigger" };
  }

  // Check if this deal already has a BidBoard project
  const existingMapping = await storage.getSyncMappingByHubspotDealId(dealId);
  if (existingMapping?.bidboardProjectId) {
    console.log(`[hubspot-bidboard] Deal ${dealId} already has BidBoard project ${existingMapping.bidboardProjectId}`);
    return { triggered: false, reason: "bidboard_project_already_exists" };
  }

  console.log(`[hubspot-bidboard] Deal ${dealId} moved to ${triggerConfig.hubspotStageLabel}, creating BidBoard project in "${triggerConfig.bidboardStage}" with document sync`);

  // Create BidBoard project and sync documents
  const result = await createBidBoardProjectFromDeal(dealId, triggerConfig.bidboardStage, { syncDocuments: true });

  // Log the automation
  await storage.createAuditLog({
    action: "hubspot_bidboard_auto_create",
    entityType: "deal",
    entityId: dealId,
    source: "webhook",
    status: result.success ? "success" : "failed",
    details: {
      hubspotStageId: newStageId,
      hubspotStageLabel: triggerConfig.hubspotStageLabel,
      bidboardStage: triggerConfig.bidboardStage,
      bidboardProjectId: result.projectId,
      documentsUploaded: result.documentsUploaded || 0,
      documentErrors: result.documentErrors,
      error: result.error,
    },
  });

  if (result.success) {
    console.log(`[hubspot-bidboard] Successfully created BidBoard project ${result.projectId} with ${result.documentsUploaded || 0} documents`);
  }

  return { triggered: true, result };
}

// Manual trigger for testing or one-off creation
export async function triggerBidBoardCreationForDeal(
  dealId: string,
  bidboardStage: string = "Estimate in Progress",
  options: { syncDocuments?: boolean } = { syncDocuments: true }
): Promise<{ success: boolean; projectId?: string; documentsUploaded?: number; error?: string }> {
  // Check if deal already has a BidBoard project
  const existingMapping = await storage.getSyncMappingByHubspotDealId(dealId);
  if (existingMapping?.bidboardProjectId) {
    return {
      success: false,
      error: `Deal already linked to BidBoard project ${existingMapping.bidboardProjectId}`,
    };
  }

  const result = await createBidBoardProjectFromDeal(dealId, bidboardStage, options);
  
  return {
    success: result.success,
    projectId: result.projectId,
    documentsUploaded: result.documentsUploaded,
    error: result.error,
  };
}
