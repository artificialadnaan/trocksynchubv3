import { storage } from './storage';

export interface DealStageDistribution {
  stage: string;
  count: number;
  totalValue: number;
}

export interface ProjectStageDistribution {
  stage: string;
  count: number;
}

export interface SyncActivitySummary {
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  recentSyncs: { date: string; count: number }[];
}

export interface DashboardMetrics {
  totalDeals: number;
  totalProjects: number;
  totalMappings: number;
  activeProjects: number;
  dealsByStage: DealStageDistribution[];
  projectsByStage: ProjectStageDistribution[];
  totalDealValue: number;
  averageDealValue: number;
  syncActivity: SyncActivitySummary;
  emailsSent: number;
  surveysCompleted: number;
  recentActivity: ActivityItem[];
}

export interface ActivityItem {
  id: string;
  type: string;
  description: string;
  timestamp: Date;
  status: string;
  entityType?: string;
  entityId?: string;
}

export async function getDealStageDistribution(): Promise<DealStageDistribution[]> {
  const { data: deals } = await storage.getHubspotDeals({});
  const stageMap = new Map<string, { count: number; totalValue: number }>();

  for (const deal of deals) {
    const stage = deal.dealStage || 'Unknown';
    const value = parseFloat(deal.amount || '0');
    
    if (!stageMap.has(stage)) {
      stageMap.set(stage, { count: 0, totalValue: 0 });
    }
    const current = stageMap.get(stage)!;
    current.count++;
    current.totalValue += value;
  }

  return Array.from(stageMap.entries()).map(([stage, data]) => ({
    stage,
    count: data.count,
    totalValue: data.totalValue,
  })).sort((a, b) => b.count - a.count);
}

export async function getProjectStageDistribution(): Promise<ProjectStageDistribution[]> {
  const { data: projects } = await storage.getProcoreProjects({});
  const stageMap = new Map<string, number>();

  for (const project of projects) {
    const stage = project.projectStageName || project.stage || 'Unknown';
    stageMap.set(stage, (stageMap.get(stage) || 0) + 1);
  }

  return Array.from(stageMap.entries()).map(([stage, count]) => ({
    stage,
    count,
  })).sort((a, b) => b.count - a.count);
}

export async function getSyncActivitySummary(): Promise<SyncActivitySummary> {
  const { logs } = await storage.getAuditLogs({ limit: 1000 });
  
  const syncLogs = logs.filter(log => 
    log.action.includes('sync') || 
    log.action.includes('webhook') ||
    log.action.includes('scrape')
  );

  const successfulSyncs = syncLogs.filter(log => log.status === 'success').length;
  const failedSyncs = syncLogs.filter(log => log.status === 'error' || log.status === 'failed').length;

  const last7Days = new Map<string, number>();
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    last7Days.set(dateStr, 0);
  }

  for (const log of syncLogs) {
    const dateStr = log.createdAt?.toISOString().split('T')[0];
    if (dateStr && last7Days.has(dateStr)) {
      last7Days.set(dateStr, last7Days.get(dateStr)! + 1);
    }
  }

  return {
    totalSyncs: syncLogs.length,
    successfulSyncs,
    failedSyncs,
    recentSyncs: Array.from(last7Days.entries()).map(([date, count]) => ({ date, count })),
  };
}

export async function getEmailsSentCount(): Promise<number> {
  const { logs } = await storage.getAuditLogs({ limit: 5000 });
  return logs.filter(log => 
    log.action.includes('email') && log.status === 'success'
  ).length;
}

export async function getSurveysCompletedCount(): Promise<number> {
  try {
    const surveys = await storage.getCloseoutSurveys();
    return surveys.filter(s => s.submittedAt !== null).length;
  } catch {
    return 0;
  }
}

export async function getRecentActivity(limit: number = 20): Promise<ActivityItem[]> {
  const { logs } = await storage.getAuditLogs({ limit });
  
  return logs.map(log => ({
    id: String(log.id),
    type: log.action,
    description: formatActivityDescription(log),
    timestamp: log.createdAt || new Date(),
    status: log.status || 'unknown',
    entityType: log.entityType,
    entityId: log.entityId,
  }));
}

function formatActivityDescription(log: any): string {
  const action = log.action || '';
  const entityType = log.entityType || '';
  const details = log.details || {};

  switch (action) {
    case 'sync_hubspot_deals':
      return `Synced ${details.synced || 0} HubSpot deals`;
    case 'sync_procore_projects':
      return `Synced ${details.synced || 0} Procore projects`;
    case 'webhook_received':
      return `Received ${entityType} webhook`;
    case 'webhook_stage_change_processed':
      return `Stage change: ${details.oldStage} → ${details.newStage}`;
    case 'change_order_sync':
      return `Change order sync: $${(details.newAmount || 0).toLocaleString()}`;
    case 'email_sent':
      return `Email sent to ${details.recipient || 'unknown'}`;
    case 'survey_submitted':
      return `Survey completed with rating ${details.rating}/5`;
    case 'mapping_created':
      return `Created mapping for ${details.dealName || details.projectName || entityType}`;
    default:
      return `${action.replace(/_/g, ' ')} - ${entityType}`;
  }
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const [
    dealsResult,
    projectsResult,
    mappings,
    dealsByStage,
    projectsByStage,
    syncActivity,
    emailsSent,
    surveysCompleted,
    recentActivity,
  ] = await Promise.all([
    storage.getHubspotDeals({}),
    storage.getProcoreProjects({}),
    storage.getSyncMappings(),
    getDealStageDistribution(),
    getProjectStageDistribution(),
    getSyncActivitySummary(),
    getEmailsSentCount(),
    getSurveysCompletedCount(),
    getRecentActivity(20),
  ]);

  const deals = dealsResult.data;
  const projects = projectsResult.data;

  const totalDealValue = deals.reduce((sum, d) => sum + parseFloat(d.amount || '0'), 0);
  const activeProjects = projects.filter(p => 
    p.active === true || 
    (p.projectStageName?.toLowerCase() !== 'completed' && 
     p.projectStageName?.toLowerCase() !== 'closed')
  ).length;

  return {
    totalDeals: dealsResult.total,
    totalProjects: projectsResult.total,
    totalMappings: mappings.length,
    activeProjects,
    dealsByStage,
    projectsByStage,
    totalDealValue,
    averageDealValue: deals.length > 0 ? totalDealValue / deals.length : 0,
    syncActivity,
    emailsSent,
    surveysCompleted,
    recentActivity,
  };
}

export interface PipelineReport {
  pipelineName: string;
  stages: {
    stageName: string;
    dealCount: number;
    totalValue: number;
    avgDaysInStage: number;
  }[];
  totalDeals: number;
  totalValue: number;
}

export async function getPipelineReport(): Promise<PipelineReport[]> {
  const pipelines = await storage.getHubspotPipelines();
  const { data: deals } = await storage.getHubspotDeals({});
  const reports: PipelineReport[] = [];

  for (const pipeline of pipelines) {
    const pipelineDeals = deals.filter(d => d.pipelineId === pipeline.pipelineId);
    const stages = (pipeline.stages as any[]) || [];
    
    const stageReports = stages.map(stage => {
      const stageDeals = pipelineDeals.filter(d => d.dealStage === stage.stageId);
      const totalValue = stageDeals.reduce((sum, d) => sum + parseFloat(d.amount || '0'), 0);
      
      return {
        stageName: stage.label || stage.stageName || stage.stageId,
        dealCount: stageDeals.length,
        totalValue,
        avgDaysInStage: 0,
      };
    });

    reports.push({
      pipelineName: pipeline.pipelineName || pipeline.pipelineId,
      stages: stageReports,
      totalDeals: pipelineDeals.length,
      totalValue: pipelineDeals.reduce((sum, d) => sum + parseFloat(d.amount || '0'), 0),
    });
  }

  return reports;
}

export interface SyncHealthReport {
  lastHubSpotSync: Date | null;
  lastProcoreSync: Date | null;
  lastCompanyCamSync: Date | null;
  webhooksProcessedToday: number;
  failedWebhooksToday: number;
  pendingActions: number;
  systemHealth: 'healthy' | 'degraded' | 'unhealthy';
}

export async function getSyncHealthReport(): Promise<SyncHealthReport> {
  const { logs } = await storage.getAuditLogs({ limit: 500 });
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayLogs = logs.filter(log => 
    log.createdAt && new Date(log.createdAt) >= today
  );

  const webhooksToday = todayLogs.filter(log => log.action.includes('webhook'));
  const failedToday = webhooksToday.filter(log => log.status === 'error' || log.status === 'failed');

  // Find last successful syncs from ALL logs (not just today) - we want the most recent sync ever
  // Note: getAuditLogs returns logs ordered by createdAt DESC (most recent first),
  // but we explicitly sort here to ensure correctness regardless of input order
  const sortedLogs = [...logs].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateB - dateA; // Descending (most recent first)
  });
  
  const hubspotSync = sortedLogs.find(l => l.action === 'sync_hubspot_deals' && l.status === 'success');
  const procoreSync = sortedLogs.find(l => l.action === 'sync_procore_projects' && l.status === 'success');
  const companyCamSync = sortedLogs.find(l => l.action.includes('companycam') && l.action.includes('sync') && l.status === 'success');

  // Calculate failure rate from today's webhooks
  const failureRate = webhooksToday.length > 0 
    ? failedToday.length / webhooksToday.length 
    : 0;

  // Determine system health based on today's failure rate AND recency of syncs
  let systemHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  
  // Check if any syncs are stale (more than 24 hours old)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const hubspotStale = !hubspotSync?.createdAt || new Date(hubspotSync.createdAt) < oneDayAgo;
  const procoreStale = !procoreSync?.createdAt || new Date(procoreSync.createdAt) < oneDayAgo;
  
  if (failureRate > 0.5) {
    systemHealth = 'unhealthy';
  } else if (failureRate > 0.2 || (hubspotStale && procoreStale)) {
    systemHealth = 'degraded';
  }

  return {
    lastHubSpotSync: hubspotSync?.createdAt || null,
    lastProcoreSync: procoreSync?.createdAt || null,
    lastCompanyCamSync: companyCamSync?.createdAt || null,
    webhooksProcessedToday: webhooksToday.length,
    failedWebhooksToday: failedToday.length,
    pendingActions: 0,
    systemHealth,
  };
}
