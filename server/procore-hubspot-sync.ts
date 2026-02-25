import { storage } from './storage';
import { getHubSpotClient, getAccessToken } from './hubspot';
import { db } from './db';
import { syncMappings, hubspotDeals, procoreProjects } from '@shared/schema';
import { eq, and, ilike, or, isNull, sql, desc, ne } from 'drizzle-orm';

interface SyncResult {
  matched: number;
  newMappings: number;
  updatedMappings: number;
  hubspotUpdates: number;
  conflicts: number;
  unmatchedProcore: number;
  unmatchedHubspot: number;
  duration: number;
  details: SyncDetail[];
}

interface SyncDetail {
  procoreProjectId: string;
  procoreProjectName: string;
  procoreProjectNumber: string | null;
  hubspotDealId: string | null;
  hubspotDealName: string | null;
  matchType: 'project_number' | 'exact_name' | 'unmatched';
  action: 'created' | 'updated' | 'skipped' | 'conflict';
  conflicts?: FieldConflict[];
}

interface FieldConflict {
  field: string;
  procoreValue: string | null;
  hubspotValue: string | null;
  resolution: 'procore_wins' | 'kept_both' | 'hubspot_preserved';
}

function normalizeNameForMatch(name: string | null): string {
  if (!name) return '';
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function syncProcoreToHubspot(): Promise<SyncResult> {
  const start = Date.now();
  const details: SyncDetail[] = [];
  let matched = 0, newMappings = 0, updatedMappings = 0, hubspotUpdates = 0, conflicts = 0;

  const allProcore = await db.select().from(procoreProjects);
  const allHubspot = await db.select().from(hubspotDeals);
  const existingMappings = await storage.getSyncMappings();

  const procoreByNumber = new Map<string, typeof allProcore[0][]>();
  for (const p of allProcore) {
    if (p.projectNumber) {
      const list = procoreByNumber.get(p.projectNumber) || [];
      list.push(p);
      procoreByNumber.set(p.projectNumber, list);
    }
  }

  const hubspotByName = new Map<string, typeof allHubspot[0][]>();
  for (const d of allHubspot) {
    const key = normalizeNameForMatch(d.dealName);
    if (key) {
      const list = hubspotByName.get(key) || [];
      list.push(d);
      hubspotByName.set(key, list);
    }
  }

  const hubspotByProjectNumber = new Map<string, typeof allHubspot[0]>();
  for (const d of allHubspot) {
    const pn = (d.properties as any)?.project_number;
    if (pn) {
      hubspotByProjectNumber.set(pn, d);
    }
  }

  const mappedProcoreIds = new Set(existingMappings.map(m => m.procoreProjectId).filter(Boolean));
  const mappedHubspotIds = new Set(existingMappings.map(m => m.hubspotDealId).filter(Boolean));
  const hubspotIdsUsedThisRun = new Set<string>();

  const pendingHubspotUpdates: Array<{ id: string; properties: Record<string, string> }> = [];

  for (const project of allProcore) {
    const procoreId = project.procoreId;
    let matchedDeal: typeof allHubspot[0] | null = null;
    let matchType: 'project_number' | 'exact_name' | 'unmatched' = 'unmatched';

    const existingMapping = existingMappings.find(m => m.procoreProjectId === procoreId);
    if (existingMapping?.hubspotDealId) {
      matchedDeal = allHubspot.find(d => d.hubspotId === existingMapping.hubspotDealId) || null;
      if (matchedDeal) matchType = 'project_number';
    }

    if (!matchedDeal && project.projectNumber) {
      const byPN = hubspotByProjectNumber.get(project.projectNumber);
      if (byPN && !hubspotIdsUsedThisRun.has(byPN.hubspotId)) {
        matchedDeal = byPN;
        matchType = 'project_number';
      }
    }

    if (!matchedDeal) {
      const nameKey = normalizeNameForMatch(project.name);
      if (nameKey) {
        const candidates = hubspotByName.get(nameKey) || [];
        const available = candidates.filter(c => !hubspotIdsUsedThisRun.has(c.hubspotId));
        if (available.length === 1) {
          matchedDeal = available[0];
          matchType = 'exact_name';
        } else if (available.length > 1) {
          matchedDeal = available[0];
          matchType = 'exact_name';
        }
      }
    }

    if (!matchedDeal) {
      details.push({
        procoreProjectId: procoreId,
        procoreProjectName: project.name || '',
        procoreProjectNumber: project.projectNumber,
        hubspotDealId: null,
        hubspotDealName: null,
        matchType: 'unmatched',
        action: 'skipped',
      });
      continue;
    }

    hubspotIdsUsedThisRun.add(matchedDeal.hubspotId);
    matched++;

    const fieldConflicts: FieldConflict[] = [];
    const hubspotProps = (matchedDeal.properties || {}) as Record<string, any>;
    const hubspotPropertiesToUpdate: Record<string, string> = {};

    if (project.projectNumber) {
      const existingPN = hubspotProps.project_number;
      if (existingPN && existingPN !== project.projectNumber) {
        fieldConflicts.push({
          field: 'project_number',
          procoreValue: project.projectNumber,
          hubspotValue: existingPN,
          resolution: 'procore_wins',
        });
        conflicts++;
      }
      hubspotPropertiesToUpdate.project_number = project.projectNumber;
    }

    const procoreLocation = [project.city, project.stateCode].filter(Boolean).join(', ');
    if (procoreLocation) {
      const existingLocation = hubspotProps.project_location;
      if (existingLocation && existingLocation !== procoreLocation) {
        fieldConflicts.push({
          field: 'project_location',
          procoreValue: procoreLocation,
          hubspotValue: existingLocation,
          resolution: 'kept_both',
        });
        conflicts++;
      } else if (!existingLocation) {
        hubspotPropertiesToUpdate.project_location = procoreLocation;
      }
    }

    if (project.estimatedValue) {
      const existingAmount = hubspotProps.amount;
      if (existingAmount && existingAmount !== project.estimatedValue) {
        fieldConflicts.push({
          field: 'amount',
          procoreValue: project.estimatedValue,
          hubspotValue: existingAmount,
          resolution: 'kept_both',
        });
        conflicts++;
      } else if (!existingAmount) {
        hubspotPropertiesToUpdate.amount = project.estimatedValue;
      }
    }

    if (Object.keys(hubspotPropertiesToUpdate).length > 0) {
      pendingHubspotUpdates.push({ id: matchedDeal.hubspotId, properties: hubspotPropertiesToUpdate });
    }

    const mappingData = {
      hubspotDealId: matchedDeal.hubspotId,
      hubspotDealName: matchedDeal.dealName,
      procoreProjectId: procoreId,
      procoreProjectName: project.name,
      procoreProjectNumber: project.projectNumber,
      procoreCompanyId: project.companyId,
      lastSyncAt: new Date(),
      lastSyncStatus: 'synced' as string,
      lastSyncDirection: 'procore_to_hubspot' as string,
      metadata: {
        matchType,
        conflicts: fieldConflicts,
        procoreStage: project.stage,
        procoreCity: project.city,
        procoreState: project.stateCode,
        procoreEstimatedValue: project.estimatedValue,
        hubspotStage: matchedDeal.dealStageName,
        hubspotAmount: matchedDeal.amount,
        hubspotPipeline: matchedDeal.pipelineName,
        updatedFields: Object.keys(hubspotPropertiesToUpdate),
        lastSyncTimestamp: new Date().toISOString(),
      },
    };

    if (existingMapping) {
      await storage.updateSyncMapping(existingMapping.id, mappingData);
      updatedMappings++;
    } else {
      await storage.createSyncMapping(mappingData);
      newMappings++;
    }

    details.push({
      procoreProjectId: procoreId,
      procoreProjectName: project.name || '',
      procoreProjectNumber: project.projectNumber,
      hubspotDealId: matchedDeal.hubspotId,
      hubspotDealName: matchedDeal.dealName,
      matchType,
      action: existingMapping ? 'updated' : 'created',
      conflicts: fieldConflicts.length > 0 ? fieldConflicts : undefined,
    });
  }

  if (pendingHubspotUpdates.length > 0) {
    try {
      const accessToken = await getAccessToken();
      const BATCH_SIZE = 100;
      for (let i = 0; i < pendingHubspotUpdates.length; i += BATCH_SIZE) {
        const batch = pendingHubspotUpdates.slice(i, i + BATCH_SIZE);
        const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals/batch/update', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: batch.map(u => ({ id: u.id, properties: u.properties })),
          }),
        });
        if (response.ok) {
          hubspotUpdates += batch.length;
        } else {
          const errText = await response.text();
          console.error(`[procore-hubspot-sync] Batch update failed (batch ${Math.floor(i / BATCH_SIZE) + 1}):`, errText);
        }
      }
      console.log(`[procore-hubspot-sync] Batch updated ${hubspotUpdates} HubSpot deals`);
    } catch (e: any) {
      console.error('[procore-hubspot-sync] HubSpot batch update error:', e.message);
    }
  }

  const unmatchedHubspot = allHubspot.filter(d => !hubspotIdsUsedThisRun.has(d.hubspotId)).length;
  const unmatchedProcore = allProcore.filter(p => !details.find(d => d.procoreProjectId === p.procoreId && d.matchType !== 'unmatched')).length;

  const duration = Date.now() - start;

  await storage.createAuditLog({
    action: 'procore_hubspot_sync',
    entityType: 'sync_mapping',
    source: 'procore',
    destination: 'hubspot',
    status: 'success',
    details: {
      matched,
      newMappings,
      updatedMappings,
      hubspotUpdates,
      conflicts,
      unmatchedProcore,
      unmatchedHubspot,
      totalProcore: allProcore.length,
      totalHubspot: allHubspot.length,
    },
    durationMs: duration,
  });

  console.log(`[procore-hubspot-sync] Complete in ${(duration / 1000).toFixed(1)}s — Matched: ${matched}, New: ${newMappings}, Updated: ${updatedMappings}, HubSpot writes: ${hubspotUpdates}, Conflicts: ${conflicts}`);

  return {
    matched,
    newMappings,
    updatedMappings,
    hubspotUpdates,
    conflicts,
    unmatchedProcore,
    unmatchedHubspot,
    duration,
    details,
  };
}

export async function getSyncOverview(): Promise<{
  totalMappings: number;
  totalProcore: number;
  totalHubspot: number;
  mappedProcore: number;
  mappedHubspot: number;
  withConflicts: number;
  recentMappings: any[];
}> {
  const mappings = await storage.getSyncMappings();
  const [{ count: procoreCount }] = await db.select({ count: sql<number>`count(*)` }).from(procoreProjects);
  const [{ count: hubspotCount }] = await db.select({ count: sql<number>`count(*)` }).from(hubspotDeals);

  const mappedProcoreIds = new Set(mappings.map(m => m.procoreProjectId).filter(Boolean));
  const mappedHubspotIds = new Set(mappings.map(m => m.hubspotDealId).filter(Boolean));

  const withConflicts = mappings.filter(m => {
    const meta = m.metadata as any;
    return meta?.conflicts && meta.conflicts.length > 0;
  }).length;

  return {
    totalMappings: mappings.length,
    totalProcore: Number(procoreCount),
    totalHubspot: Number(hubspotCount),
    mappedProcore: mappedProcoreIds.size,
    mappedHubspot: mappedHubspotIds.size,
    withConflicts,
    recentMappings: mappings.slice(0, 20),
  };
}

export async function unlinkMapping(mappingId: number): Promise<boolean> {
  try {
    await db.delete(syncMappings).where(eq(syncMappings.id, mappingId));
    return true;
  } catch (e) {
    return false;
  }
}

export async function createManualMapping(
  procoreProjectId: string,
  hubspotDealId: string,
  writeProjectNumber: boolean = true
): Promise<{ success: boolean; message: string; mapping?: any }> {
  const project = await db.select().from(procoreProjects).where(eq(procoreProjects.procoreId, procoreProjectId)).limit(1);
  const deal = await db.select().from(hubspotDeals).where(eq(hubspotDeals.hubspotId, hubspotDealId)).limit(1);

  if (!project[0]) return { success: false, message: 'Procore project not found' };
  if (!deal[0]) return { success: false, message: 'HubSpot deal not found' };

  const existing = await storage.getSyncMappingByProcoreProjectId(procoreProjectId);
  if (existing) {
    return { success: false, message: `Procore project already mapped to HubSpot deal ${existing.hubspotDealName}` };
  }

  if (writeProjectNumber && project[0].projectNumber) {
    try {
      const client = await getHubSpotClient();
      await client.crm.deals.basicApi.update(hubspotDealId, {
        properties: { project_number: project[0].projectNumber },
      });
    } catch (e: any) {
      console.error('[procore-hubspot-sync] Failed to write project number:', e.message);
    }
  }

  const mapping = await storage.createSyncMapping({
    hubspotDealId,
    hubspotDealName: deal[0].dealName,
    procoreProjectId,
    procoreProjectName: project[0].name,
    procoreProjectNumber: project[0].projectNumber,
    procoreCompanyId: project[0].companyId,
    lastSyncAt: new Date(),
    lastSyncStatus: 'synced',
    lastSyncDirection: 'manual',
    metadata: {
      matchType: 'manual',
      conflicts: [],
      lastSyncTimestamp: new Date().toISOString(),
    },
  });

  return { success: true, message: 'Mapping created successfully', mapping };
}

export async function getUnmatchedProjects(): Promise<{
  unmatchedProcore: Array<{ procoreId: string; name: string; projectNumber: string | null; stage: string | null; city: string | null; stateCode: string | null }>;
  unmatchedHubspot: Array<{ hubspotId: string; dealName: string | null; amount: string | null; stageName: string | null; pipeline: string | null }>;
}> {
  const mappings = await storage.getSyncMappings();
  const mappedProcoreIds = new Set(mappings.map(m => m.procoreProjectId).filter(Boolean));
  const mappedHubspotIds = new Set(mappings.map(m => m.hubspotDealId).filter(Boolean));

  const allProcore = await db.select({
    procoreId: procoreProjects.procoreId,
    name: procoreProjects.name,
    projectNumber: procoreProjects.projectNumber,
    stage: procoreProjects.stage,
    city: procoreProjects.city,
    stateCode: procoreProjects.stateCode,
  }).from(procoreProjects);

  const allHubspot = await db.select({
    hubspotId: hubspotDeals.hubspotId,
    dealName: hubspotDeals.dealName,
    amount: hubspotDeals.amount,
    stageName: hubspotDeals.dealStageName,
    pipeline: hubspotDeals.pipelineName,
  }).from(hubspotDeals);

  return {
    unmatchedProcore: allProcore.filter(p => !mappedProcoreIds.has(p.procoreId)),
    unmatchedHubspot: allHubspot.filter(d => !mappedHubspotIds.has(d.hubspotId)),
  };
}
