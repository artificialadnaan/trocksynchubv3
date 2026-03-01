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
  hubspotCreated: number;
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

// Procore Portfolio/BidBoard Stage → HubSpot Deal Stage mapping
// These should match your HubSpot pipeline stage labels or internal IDs
const PROCORE_TO_HUBSPOT_STAGE: Record<string, string> = {
  // Estimating stages
  'Estimate in Progress': 'Estimating',
  'Service – Estimating': 'Service – Estimating',
  'Service - Estimating': 'Service – Estimating',
  
  // Review stages
  'Estimate under review': 'Internal Review',
  'Estimate sent to Client': 'Proposal Sent',
  
  // Won stages
  'Service – sent to production': 'Service – Won',
  'Service - sent to production': 'Service – Won',
  'Sent to production': 'Closed Won',
  
  // Lost stages
  'Service – lost': 'Service – Lost',
  'Service - lost': 'Service – Lost',
  'Production – lost': 'Closed Lost',
  'Production - lost': 'Closed Lost',
};

export function mapProcoreStageToHubspot(procoreStage: string | null): string {
  if (!procoreStage) return 'Estimating'; // Default to Estimating for new projects
  return PROCORE_TO_HUBSPOT_STAGE[procoreStage] || procoreStage; // Pass through if no mapping
}

export async function syncProcoreToHubspot(options: { dryRun?: boolean; skipHubspotWrites?: boolean } = {}): Promise<SyncResult> {
  const { dryRun = false, skipHubspotWrites = false } = options;
  const start = Date.now();
  const details: SyncDetail[] = [];
  let matched = 0, newMappings = 0, updatedMappings = 0, hubspotUpdates = 0, hubspotCreated = 0, conflicts = 0;
  
  // dryRun implies skipHubspotWrites - it's a full simulation with no writes anywhere
  const effectiveSkipHubspotWrites = dryRun || skipHubspotWrites;
  
  if (dryRun) {
    console.log('[procore-hubspot-sync] Running in DRY-RUN mode. No data will be written to HubSpot or database.');
  } else if (effectiveSkipHubspotWrites) {
    console.log('[procore-hubspot-sync] Running in READ-ONLY mode. No data will be written to HubSpot.');
  } else {
    console.log('[procore-hubspot-sync] Running sync with HubSpot writes ENABLED.');
  }

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
  const pendingHubspotCreates: Array<{ project: typeof allProcore[0]; properties: Record<string, string> }> = [];

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
      const createProps: Record<string, string> = {
        dealname: project.name || 'Unnamed Procore Project',
        pipeline: 'default',
        dealstage: mapProcoreStageToHubspot(project.stage),
      };
      if (project.projectNumber) createProps.project_number = project.projectNumber;
      const procoreLocation = [project.city, project.stateCode].filter(Boolean).join(', ');
      if (procoreLocation) createProps.project_location = procoreLocation;
      if (project.estimatedValue && parseFloat(project.estimatedValue) > 0) {
        createProps.amount = project.estimatedValue;
      }
      pendingHubspotCreates.push({ project, properties: createProps });
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

    if (!dryRun) {
      if (existingMapping) {
        await storage.updateSyncMapping(existingMapping.id, mappingData);
        updatedMappings++;
      } else {
        await storage.createSyncMapping(mappingData);
        newMappings++;
      }
    } else {
      // In dry-run, count what would happen
      if (existingMapping) updatedMappings++;
      else newMappings++;
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
    if (effectiveSkipHubspotWrites) {
      console.log(`[procore-hubspot-sync] SKIPPED: Would have updated ${pendingHubspotUpdates.length} HubSpot deals (read-only mode)`);
    } else {
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
  }

  if (pendingHubspotCreates.length > 0) {
    if (effectiveSkipHubspotWrites) {
      console.log(`[procore-hubspot-sync] SKIPPED: Would have created ${pendingHubspotCreates.length} HubSpot deals for unmatched Procore projects (read-only mode)`);
      // Still track these as unmatched
      for (const item of pendingHubspotCreates) {
        details.push({
          procoreProjectId: item.project.procoreId,
          procoreProjectName: item.project.name || '',
          procoreProjectNumber: item.project.projectNumber,
          hubspotDealId: null,
          hubspotDealName: null,
          matchType: 'unmatched',
          action: 'skipped',
        });
      }
    } else {
      try {
        const accessToken = await getAccessToken();
        for (const item of pendingHubspotCreates) {
          const project = item.project;
          try {
            const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ properties: item.properties }),
            });
            if (response.ok) {
              const created = await response.json();
              hubspotCreated++;
              matched++;

              await storage.createSyncMapping({
                hubspotDealId: created.id,
                hubspotDealName: created.properties?.dealname || project.name,
                procoreProjectId: project.procoreId,
                procoreProjectName: project.name,
                procoreProjectNumber: project.projectNumber,
                procoreCompanyId: project.companyId,
                lastSyncAt: new Date(),
                lastSyncStatus: 'synced',
                lastSyncDirection: 'procore_to_hubspot',
                metadata: {
                  matchType: 'created_in_hubspot',
                  conflicts: [],
                  procoreStage: project.stage,
                  procoreCity: project.city,
                  procoreState: project.stateCode,
                  procoreEstimatedValue: project.estimatedValue,
                  hubspotStage: item.properties.dealstage,
                  hubspotAmount: item.properties.amount || null,
                  hubspotPipeline: 'Sales Pipeline',
                  updatedFields: Object.keys(item.properties),
                  lastSyncTimestamp: new Date().toISOString(),
                },
              });
              newMappings++;

              details.push({
                procoreProjectId: project.procoreId,
                procoreProjectName: project.name || '',
                procoreProjectNumber: project.projectNumber,
                hubspotDealId: created.id,
                hubspotDealName: created.properties?.dealname || project.name,
                matchType: 'exact_name',
                action: 'created',
              });
            } else {
              const errBody = await response.json().catch(() => ({}));
              const isUniqueConflict = errBody?.category === 'VALIDATION_ERROR' &&
                JSON.stringify(errBody).includes('CONFLICTING_UNIQUE_VALUE');
              if (isUniqueConflict && item.properties.project_number) {
                delete item.properties.project_number;
                const retryResponse = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ properties: item.properties }),
                });
                if (retryResponse.ok) {
                  const created = await retryResponse.json();
                  hubspotCreated++;
                  matched++;

                await storage.createSyncMapping({
                  hubspotDealId: created.id,
                  hubspotDealName: created.properties?.dealname || project.name,
                  procoreProjectId: project.procoreId,
                  procoreProjectName: project.name,
                  procoreProjectNumber: project.projectNumber,
                  procoreCompanyId: project.companyId,
                  lastSyncAt: new Date(),
                  lastSyncStatus: 'synced',
                  lastSyncDirection: 'procore_to_hubspot',
                  metadata: {
                    matchType: 'created_in_hubspot',
                    conflicts: [{ field: 'project_number', procoreValue: project.projectNumber, hubspotValue: 'duplicate_skipped', resolution: 'kept_both' }],
                    procoreStage: project.stage,
                    procoreCity: project.city,
                    procoreState: project.stateCode,
                    procoreEstimatedValue: project.estimatedValue,
                    lastSyncTimestamp: new Date().toISOString(),
                  },
                });
                newMappings++;
                details.push({
                  procoreProjectId: project.procoreId,
                  procoreProjectName: project.name || '',
                  procoreProjectNumber: project.projectNumber,
                  hubspotDealId: created.id,
                  hubspotDealName: created.properties?.dealname || project.name,
                  matchType: 'exact_name',
                  action: 'created',
                  conflicts: [{ field: 'project_number', procoreValue: project.projectNumber, hubspotValue: 'duplicate_skipped', resolution: 'kept_both' as const }],
                });
              } else {
                console.error(`[procore-hubspot-sync] Failed to create deal (retry) for ${project.name}`);
              }
            } else {
              console.error(`[procore-hubspot-sync] Failed to create deal for ${project.name}:`, errBody?.message || 'Unknown error');
              details.push({
                procoreProjectId: project.procoreId,
                procoreProjectName: project.name || '',
                procoreProjectNumber: project.projectNumber,
                hubspotDealId: null,
                hubspotDealName: null,
                matchType: 'unmatched',
                action: 'skipped',
              });
            }
          }
        } catch (e: any) {
          console.error(`[procore-hubspot-sync] Error creating deal for ${project.name}:`, e.message);
        }
      }
        console.log(`[procore-hubspot-sync] Created ${hubspotCreated} new HubSpot deals`);
      } catch (e: any) {
        console.error('[procore-hubspot-sync] HubSpot create error:', e.message);
      }
    }
  }

  const unmatchedHubspot = allHubspot.filter(d => !hubspotIdsUsedThisRun.has(d.hubspotId)).length;
  const unmatchedProcore = pendingHubspotCreates.length - hubspotCreated;

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
      hubspotCreated,
      conflicts,
      unmatchedProcore,
      unmatchedHubspot,
      totalProcore: allProcore.length,
      totalHubspot: allHubspot.length,
    },
    durationMs: duration,
  });

  console.log(`[procore-hubspot-sync] Complete in ${(duration / 1000).toFixed(1)}s — Matched: ${matched}, New mappings: ${newMappings}, Updated: ${updatedMappings}, HubSpot writes: ${hubspotUpdates}, Created: ${hubspotCreated}, Conflicts: ${conflicts}`);

  return {
    matched,
    newMappings,
    updatedMappings,
    hubspotUpdates,
    hubspotCreated,
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
