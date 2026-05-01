export type BidBoardAutomationLogRow = {
  id: number;
  projectId: string | null;
  projectName: string | null;
  action: string;
  status: string;
  details: any;
  createdAt: string | Date | null;
};

export type CanaryReportScope = {
  cycleId?: string;
  canaryRunId?: string;
  since?: string;
  expectedProductionSuppressedRange?: [number, number];
  expectedLostSuppressedRange?: [number, number];
  expectedEstimatingSuppressedRange?: [number, number];
};

export type CanaryReportDeps = {
  queryLogs?: () => Promise<BidBoardAutomationLogRow[]>;
};

export type CanaryReport = {
  rows: BidBoardAutomationLogRow[];
  pass: boolean;
  redFlags: Array<{ id: number; projectId: string | null; action: string; reason: string }>;
  totalSuppressedHubSpotWrites: number;
  suppressedHubSpotWritesByTransition: Record<string, number>;
  totalSuppressedPortfolioTriggers: number;
  suppressedPortfolioTriggersByStageAndMapping: Record<string, number>;
  totalSuppressedNotifications: number;
  suppressedNotificationsByRoute: Record<string, number>;
  totalMappingFallbackUsages: number;
  totalManualReviewQueued: number;
  actualExternalCalls: BidBoardAutomationLogRow[];
  baselineWarnings: string[];
};

function transitionKey(details: any): string {
  return `${details?.previousStage || "(unknown)"} -> ${details?.newStage || "(unknown)"}`;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] || 0) + 1;
}

function inRange(value: number, range?: [number, number]): boolean {
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

function filterRows(rows: BidBoardAutomationLogRow[], scope: CanaryReportScope): BidBoardAutomationLogRow[] {
  return rows.filter((row) => {
    const details = row.details || {};
    if (scope.cycleId && details.cycleId !== scope.cycleId) return false;
    if (scope.canaryRunId && details.canaryRunId !== scope.canaryRunId) return false;
    if (scope.since && row.createdAt && new Date(row.createdAt).getTime() < new Date(scope.since).getTime()) return false;
    return true;
  });
}

function isActualExternalCall(row: BidBoardAutomationLogRow): boolean {
  const details = row.details || {};
  if (row.status !== "success") return false;
  if (details.suppressed === true) return false;
  if (row.action === "bidboard_stage_sync") return true;
  if (row.action === "stage_notification_sent") return true;
  if (row.action.includes("portfolio") && !row.action.includes("suppressed")) return true;
  return false;
}

async function defaultQueryLogs(): Promise<BidBoardAutomationLogRow[]> {
  const { db } = await import("../db");
  const { bidboardAutomationLogs } = await import("../../shared/schema");
  const { desc } = await import("drizzle-orm");
  return db
    .select()
    .from(bidboardAutomationLogs)
    .orderBy(desc(bidboardAutomationLogs.createdAt)) as Promise<BidBoardAutomationLogRow[]>;
}

export async function buildBidBoardCanaryReport(
  scope: CanaryReportScope,
  deps: CanaryReportDeps = {}
): Promise<CanaryReport> {
  if (!scope.cycleId && !scope.canaryRunId && !scope.since) {
    throw new Error("Provide one of cycleId, canaryRunId, or since");
  }

  const allRows = await (deps.queryLogs || defaultQueryLogs)();
  const rows = filterRows(allRows, scope);
  const suppressedHubSpotWritesByTransition: Record<string, number> = {};
  const suppressedPortfolioTriggersByStageAndMapping: Record<string, number> = {};
  const suppressedNotificationsByRoute: Record<string, number> = {};

  for (const row of rows) {
    const details = row.details || {};
    if (row.action === "bidboard_stage_sync:suppressed_hubspot_write") {
      increment(suppressedHubSpotWritesByTransition, transitionKey(details));
    }
    if (row.action === "bidboard_stage_sync:suppressed_portfolio_trigger") {
      increment(
        suppressedPortfolioTriggersByStageAndMapping,
        `${details.targetValue || details.newStage || "(unknown)"} | ${details.mappingSource || "(unknown)"}`
      );
    }
    if (row.action === "bidboard_stage_sync:suppressed_stage_notification") {
      increment(suppressedNotificationsByRoute, details.route || details.targetValue || "(unknown)");
    }
  }

  const actualExternalCalls = rows.filter(isActualExternalCall);
  const redFlags = actualExternalCalls.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    action: row.action,
    reason: "Actual external-call log in migration/canary verification scope",
  }));

  const totalSuppressedHubSpotWrites = Object.values(suppressedHubSpotWritesByTransition).reduce((a, b) => a + b, 0);
  const totalSuppressedPortfolioTriggers = Object.values(suppressedPortfolioTriggersByStageAndMapping).reduce((a, b) => a + b, 0);
  const totalSuppressedNotifications = Object.values(suppressedNotificationsByRoute).reduce((a, b) => a + b, 0);
  const baselineWarnings: string[] = [];

  const productionSuppressed = Object.entries(suppressedHubSpotWritesByTransition)
    .filter(([key]) => key.includes("Sent to Production") && key.endsWith("-> Won"))
    .reduce((sum, [, count]) => sum + count, 0);
  const lostSuppressed = Object.entries(suppressedHubSpotWritesByTransition)
    .filter(([key]) => key.includes("Lost") && key.endsWith("-> Lost"))
    .reduce((sum, [, count]) => sum + count, 0);
  const estimatingSuppressed = Object.entries(suppressedHubSpotWritesByTransition)
    .filter(([key]) => key.includes("Estimating"))
    .reduce((sum, [, count]) => sum + count, 0);

  if (!inRange(productionSuppressed, scope.expectedProductionSuppressedRange)) baselineWarnings.push(`Production suppressed count ${productionSuppressed} outside expected range`);
  if (!inRange(lostSuppressed, scope.expectedLostSuppressedRange)) baselineWarnings.push(`Lost suppressed count ${lostSuppressed} outside expected range`);
  if (!inRange(estimatingSuppressed, scope.expectedEstimatingSuppressedRange)) baselineWarnings.push(`Estimating suppressed count ${estimatingSuppressed} outside expected range`);

  return {
    rows,
    pass: redFlags.length === 0,
    redFlags,
    totalSuppressedHubSpotWrites,
    suppressedHubSpotWritesByTransition,
    totalSuppressedPortfolioTriggers,
    suppressedPortfolioTriggersByStageAndMapping,
    totalSuppressedNotifications,
    suppressedNotificationsByRoute,
    totalMappingFallbackUsages: rows.filter((row) => row.action === "bidboard_stage_sync:mapping_fallback_used").length,
    totalManualReviewQueued: rows.filter((row) => row.action === "bidboard_stage_sync:manual_review_queued").length,
    actualExternalCalls,
    baselineWarnings,
  };
}
