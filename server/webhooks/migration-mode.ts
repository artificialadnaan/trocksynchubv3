import { storage } from "../storage";

export type WebhookMigrationModeConfig = {
  mode: string;
  suppressHubSpotWrites: boolean;
  suppressStageNotifications: boolean;
  logSuppressedActions: boolean;
  cycleId: string;
};

export type WebhookSuppressedAction = {
  action:
    | "procore_webhook:suppressed_hubspot_write"
    | "procore_webhook:suppressed_stage_notification"
    | "procore_webhook:suppressed_portfolio_phase2"
    | "hubspot_webhook:suppressed_stage_notification";
  projectId?: string | null;
  projectName?: string | null;
  projectNumber?: string | null;
  previousStage?: string | null;
  newStage?: string | null;
  wouldHaveAction: string;
  targetValue?: string | null;
  hubspotDealId?: string | null;
  mappingSource?: string | null;
  webhookEventId?: string | null;
  webhookResourceName?: string | null;
  webhookEventType?: string | null;
  details?: Record<string, unknown>;
};

export type WebhookPortfolioPhase2Gate = {
  enabled: boolean;
  allowlist: string[];
  allowlistMatch: boolean;
  allowed: boolean;
  projectNumber: string | null;
  mappingSource: "sync_mappings" | "none";
};

export async function getWebhookMigrationModeConfig(): Promise<WebhookMigrationModeConfig> {
  const config = await storage.getAutomationConfig("bidboard_stage_sync");
  const value = (config?.value ?? {}) as Record<string, unknown>;
  const mode = typeof value.mode === "string" ? value.mode : "live";
  const cycleId =
    typeof value.cycleId === "string" && value.cycleId.trim()
      ? value.cycleId
      : `procore-webhook-${Date.now()}`;

  return {
    mode,
    suppressHubSpotWrites: value.suppressHubSpotWrites === true,
    suppressStageNotifications: value.suppressStageNotifications === true,
    logSuppressedActions: value.logSuppressedActions !== false,
    cycleId,
  };
}

export function isMigrationMode(config: WebhookMigrationModeConfig): boolean {
  return config.mode === "migration";
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export async function evaluateWebhookPortfolioPhase2Gate(input: {
  bidboardProjectId?: string | null;
  portfolioProjectId?: string | null;
  modeConfig: WebhookMigrationModeConfig;
}): Promise<WebhookPortfolioPhase2Gate> {
  const config = await storage.getAutomationConfig("bidboard_portfolio_trigger");
  const value = (config?.value ?? {}) as Record<string, unknown>;
  const enabled = config ? value.enabled === true : input.modeConfig.mode !== "migration";
  const allowlist = Array.isArray(value.allowlist)
    ? value.allowlist.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const mapping = input.bidboardProjectId
    ? await storage.getSyncMappingByBidboardProjectId(input.bidboardProjectId)
    : input.portfolioProjectId
      ? await storage.getSyncMappingByProcoreProjectId(input.portfolioProjectId)
      : undefined;
  const projectNumber = mapping?.procoreProjectNumber ?? null;
  const normalizedProjectNumber = normalizeKey(projectNumber);
  const allowlistMatch =
    Boolean(normalizedProjectNumber) &&
    allowlist.some((item) => normalizeKey(item) === normalizedProjectNumber);

  return {
    enabled,
    allowlist,
    allowlistMatch,
    allowed: enabled || allowlistMatch,
    projectNumber,
    mappingSource: mapping ? "sync_mappings" : "none",
  };
}

export async function logWebhookSuppressedAction(
  config: WebhookMigrationModeConfig,
  input: WebhookSuppressedAction,
): Promise<void> {
  if (!config.logSuppressedActions) return;

  const details = {
    cycleId: config.cycleId,
    previousStage: input.previousStage ?? null,
    newStage: input.newStage ?? null,
    wouldHaveAction: input.wouldHaveAction,
    targetValue: input.targetValue ?? null,
    hubspotDealId: input.hubspotDealId ?? null,
    mappingSource: input.mappingSource ?? null,
    mode: config.mode,
    projectNumber: input.projectNumber ?? null,
    procoreProjectId: input.projectId ?? null,
    webhookEventId: input.webhookEventId ?? null,
    webhookResourceName: input.webhookResourceName ?? null,
    webhookEventType: input.webhookEventType ?? null,
    ...(input.details ?? {}),
  };

  console.info(
    JSON.stringify({
      action: input.action,
      status: "suppressed",
      projectId: input.projectId ?? null,
      projectName: input.projectName ?? null,
      details,
    }),
  );

  await storage.createBidboardAutomationLog({
    projectId: input.projectId ?? input.projectNumber ?? input.hubspotDealId ?? undefined,
    projectName: input.projectName ?? undefined,
    action: input.action,
    status: "suppressed",
    details,
  });
}
