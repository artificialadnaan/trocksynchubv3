import { storage } from "../storage";

/**
 * Bid Board → HubSpot Stage Mapping
 * ==================================
 *
 * Maps Procore Bid Board status values (from Excel export) to HubSpot deal stage labels.
 * The actual HubSpot stage IDs are resolved at runtime via resolveHubspotStageId()
 * from procore-hubspot-sync. Keys are normalized (Unicode dashes → hyphen) for lookup.
 *
 * @module sync/stage-mapping
 */

/** Normalize Unicode dashes to ASCII hyphen for consistent stage lookup */
export function normalizeStageLabel(s: string): string {
  return s.replace(/[\u2013\u2014\u2212\uFE58\uFE63\uFF0D]/g, "-").trim();
}

/** Bid Board Status (Excel column) → HubSpot stage label (use hyphen in keys) */
export const BIDBOARD_TO_HUBSPOT_STAGE: Record<string, string> = {
  "Service - Estimating": "Service – Estimating",
  "Estimate in Progress": "Estimating",
  "Estimate Under Review": "Internal Review",
  "Estimate Sent to Client": "Proposal Sent",
  "Service - Sent to Production": "Service – Won",
  "Sent to Production": "Closed Won",
  "Service - Lost": "Service – Lost",
  "Production Lost": "Closed Lost",
};

function logStageMapping(message: string): void {
  console.log(message);
}

export type StageMappingSource = "stage_mappings" | "hardcoded_fallback";

export interface ResolvedBidBoardStage {
  stageLabel: string;
  mappingSource: StageMappingSource;
  normalizedStage: string;
  triggerPortfolio: boolean;
}

export interface StageMappingResolutionContext {
  projectName?: string;
  projectNumber?: string | null;
  previousStage?: string | null;
  cycleId?: string;
}

function configAllowsFallback(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const config = value as Record<string, unknown>;
  if (typeof config.allowHardcodedFallback === "boolean") return config.allowHardcodedFallback;
  if (typeof config.allow_hardcoded_fallback === "boolean") return config.allow_hardcoded_fallback;
  return true;
}

function isServiceContext(context: StageMappingResolutionContext, stage: string): boolean {
  const projectNumber = context.projectNumber ?? "";
  const previousStage = context.previousStage ?? "";
  return (
    /^[A-Z]{2,4}-4-/i.test(projectNumber) ||
    normalizeStageLabel(stage).toLowerCase().includes("service") ||
    normalizeStageLabel(previousStage).toLowerCase().includes("service")
  );
}

function prefersServiceHubSpotLabel(stageLabel: string): boolean {
  return normalizeStageLabel(stageLabel).toLowerCase().startsWith("service ");
}

function isFallbackPortfolioTrigger(normalizedStage: string): boolean {
  return normalizedStage === "Sent to Production" || normalizedStage === "Service - Sent to Production";
}

async function logMappingFallback(
  oldLabel: string,
  resolvedLabel: string,
  normalizedStage: string,
  context: StageMappingResolutionContext
): Promise<void> {
  const details = {
    cycleId: context.cycleId,
    oldLabel,
    normalizedStage,
    resolvedLabel,
    mappingSource: "hardcoded_fallback" as const,
    previousStage: context.previousStage ?? null,
  };

  logStageMapping(`[BidBoardStageSync] mapping fallback used ${JSON.stringify({
    projectNumber: context.projectNumber ?? null,
    projectName: context.projectName ?? null,
    ...details,
  })}`);

  try {
    await storage.createBidboardAutomationLog({
      projectId: context.projectNumber ?? undefined,
      projectName: context.projectName,
      action: "bidboard_stage_sync:mapping_fallback_used",
      status: "warning",
      details,
    });
  } catch (err) {
    logStageMapping(
      `[BidBoardStageSync] failed to persist mapping fallback log: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function resolveBidBoardHubSpotStage(
  stage: string,
  context: StageMappingResolutionContext = {}
): Promise<ResolvedBidBoardStage | null> {
  const normalizedStage = normalizeStageLabel(stage);
  const mappings = await storage.getStageMappings();
  const matchingMappings = mappings.filter((mapping) => {
    if (mapping.isActive === false) return false;
    const direction = (mapping.direction || "").toLowerCase();
    if (direction && direction !== "bidirectional" && direction !== "procore_to_hubspot" && direction !== "bidboard_to_hubspot") {
      return false;
    }
    return normalizeStageLabel(mapping.procoreStageLabel) === normalizedStage;
  });
  const dbMapping =
    matchingMappings.find((mapping) => prefersServiceHubSpotLabel(mapping.hubspotStageLabel) === isServiceContext(context, stage)) ??
    matchingMappings[0];

  if (dbMapping?.hubspotStageLabel) {
    return {
      stageLabel: dbMapping.hubspotStageLabel,
      mappingSource: "stage_mappings",
      normalizedStage,
      triggerPortfolio: dbMapping.triggerPortfolio === true || isFallbackPortfolioTrigger(normalizedStage),
    };
  }

  const fallbackConfig = await storage.getAutomationConfig("bidboard_stage_mapping");
  const allowFallback = configAllowsFallback(fallbackConfig?.value);
  const fallbackLabel = BIDBOARD_TO_HUBSPOT_STAGE[normalizedStage];
  if (!allowFallback || !fallbackLabel) return null;

  await logMappingFallback(stage, fallbackLabel, normalizedStage, context);
  return {
    stageLabel: fallbackLabel,
    mappingSource: "hardcoded_fallback",
    normalizedStage,
    triggerPortfolio: isFallbackPortfolioTrigger(normalizedStage),
  };
}
