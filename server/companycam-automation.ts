/**
 * CompanyCam Automation Module
 * ============================
 * 
 * This module handles automated matching and linking of CompanyCam projects
 * to Procore projects and HubSpot deals. It leverages CompanyCam's native
 * integrations when available and falls back to fuzzy matching.
 * 
 * Key Features:
 * - Extract integration IDs from CompanyCam project data
 * - Bulk matching of CompanyCam projects to Procore/HubSpot
 * - Fuzzy matching by address and name when no direct link exists
 * - Search CompanyCam projects by various criteria
 * 
 * Matching Strategy (in order of priority):
 * 1. Direct Integration ID: CompanyCam stores Procore/HubSpot IDs
 * 2. Project Number Match: Same project number in both systems
 * 3. Exact Name Match: Identical project names
 * 4. Fuzzy Address Match: Similar addresses with scoring
 * 
 * Integration Data Extraction:
 * CompanyCam stores integration data in multiple formats:
 * - integrations[] array with type/provider/name fields
 * - properties.external_ids[] array
 * - properties.integrations object
 * - Direct properties like procore_project_id
 * 
 * The extractProcoreIdFromIntegrations() and extractHubspotIdFromIntegrations()
 * functions handle all these formats.
 * 
 * Key Functions:
 * - bulkMatchCompanyCamToProcore(): Batch matches all CompanyCam projects
 * - searchCompanyCamProjects(): Search by name, address, city
 * - extractProcoreIdFromIntegrations(): Get Procore ID from CC project
 * - extractHubspotIdFromIntegrations(): Get HubSpot ID from CC project
 * 
 * @module companycam-automation
 */

import { storage } from './storage';

const BASE_URL = 'https://api.companycam.com/v2';

async function getCompanycamToken(): Promise<string> {
  const tokenRecord = await storage.getOAuthToken('companycam');
  if (tokenRecord?.accessToken) return tokenRecord.accessToken;
  if (process.env.COMPANYCAM_API_TOKEN) return process.env.COMPANYCAM_API_TOKEN;
  throw new Error('No CompanyCam API token configured. Please save your token in Settings.');
}

async function companycamApiRequest(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: any
): Promise<any> {
  const token = await getCompanycamToken();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  
  const options: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CompanyCam API error ${response.status}: ${text}`);
  }
  
  if (response.status === 204) return null;
  return response.json();
}

function normalizeAddress(address: string | null | undefined): string {
  if (!address) return '';
  return address
    .toLowerCase()
    .replace(/[.,#-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl|way)\b/g, '')
    .trim();
}

function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export async function searchCompanyCamProjects(query: {
  name?: string;
  address?: string;
}): Promise<Array<{
  companycamId: string;
  name: string;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  score: number;
}>> {
  const results: Array<{
    companycamId: string;
    name: string;
    streetAddress: string | null;
    city: string | null;
    state: string | null;
    score: number;
  }> = [];

  const { data: allProjects } = await storage.getCompanycamProjects({ limit: 1000 });
  
  const normalizedQueryName = normalizeName(query.name);
  const normalizedQueryAddress = normalizeAddress(query.address);

  for (const project of allProjects) {
    let score = 0;
    
    if (query.name && normalizedQueryName) {
      const normalizedProjectName = normalizeName(project.name);
      if (normalizedProjectName === normalizedQueryName) {
        score += 100;
      } else if (normalizedProjectName.includes(normalizedQueryName) || normalizedQueryName.includes(normalizedProjectName)) {
        score += 50;
      }
    }
    
    if (query.address && normalizedQueryAddress) {
      const normalizedProjectAddress = normalizeAddress(project.streetAddress);
      if (normalizedProjectAddress === normalizedQueryAddress) {
        score += 100;
      } else if (normalizedProjectAddress.includes(normalizedQueryAddress) || normalizedQueryAddress.includes(normalizedProjectAddress)) {
        score += 50;
      }
      
      // City bonus: use normalized values to avoid false positives from substring matching
      const normalizedProjectCity = (project.city || '').toLowerCase().trim();
      if (normalizedProjectCity && normalizedQueryAddress.includes(normalizedProjectCity)) {
        score += 20;
      }
    }
    
    if (score > 0) {
      results.push({
        companycamId: project.companycamId,
        name: project.name || '',
        streetAddress: project.streetAddress,
        city: project.city,
        state: project.state,
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

export async function createCompanyCamProject(projectData: {
  name: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}): Promise<{
  success: boolean;
  companycamId?: string;
  projectUrl?: string;
  error?: string;
}> {
  try {
    const body: any = {
      name: projectData.name,
    };
    
    if (projectData.streetAddress || projectData.city || projectData.state) {
      body.address = {
        street_address_1: projectData.streetAddress || '',
        city: projectData.city || '',
        state: projectData.state || '',
        postal_code: projectData.postalCode || '',
        country: projectData.country || 'US',
      };
    }
    
    if (projectData.latitude && projectData.longitude) {
      body.coordinates = {
        lat: projectData.latitude,
        lon: projectData.longitude,
      };
    }
    
    const response = await companycamApiRequest('/projects', 'POST', body);
    
    console.log(`[CompanyCam] Created project: ${response.name} (${response.id})`);
    
    return {
      success: true,
      companycamId: String(response.id),
      projectUrl: response.project_url,
    };
  } catch (error: any) {
    console.error(`[CompanyCam] Error creating project: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function findOrCreateCompanyCamProject(
  projectData: {
    name: string;
    streetAddress?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  },
  options: {
    hubspotDealId?: string;
    procoreProjectId?: string;
    dedupeThreshold?: number;
  } = {}
): Promise<{
  success: boolean;
  companycamId?: string;
  projectUrl?: string;
  isNewProject: boolean;
  matchedProject?: { companycamId: string; name: string; score: number };
  error?: string;
}> {
  const threshold = options.dedupeThreshold || 80;
  
  try {
    const matches = await searchCompanyCamProjects({
      name: projectData.name,
      address: projectData.streetAddress,
    });
    
    if (matches.length > 0 && matches[0].score >= threshold) {
      const matched = matches[0];
      console.log(`[CompanyCam] Found existing project: ${matched.name} (score: ${matched.score})`);
      
      if (options.hubspotDealId || options.procoreProjectId) {
        const existingMapping = await storage.getSyncMappingByHubspotDealId(options.hubspotDealId || '');
        
        if (existingMapping) {
          await storage.updateSyncMapping(existingMapping.id, {
            companyCamProjectId: matched.companycamId,
          });
        } else if (options.hubspotDealId) {
          await storage.createSyncMapping({
            hubspotDealId: options.hubspotDealId,
            procoreProjectId: options.procoreProjectId || null,
            companyCamProjectId: matched.companycamId,
            hubspotDealName: projectData.name,
          });
        }
      }
      
      return {
        success: true,
        companycamId: matched.companycamId,
        isNewProject: false,
        matchedProject: matched,
      };
    }
    
    const createResult = await createCompanyCamProject(projectData);
    
    if (createResult.success && createResult.companycamId) {
      if (options.hubspotDealId || options.procoreProjectId) {
        const existingMapping = await storage.getSyncMappingByHubspotDealId(options.hubspotDealId || '');
        
        if (existingMapping) {
          await storage.updateSyncMapping(existingMapping.id, {
            companyCamProjectId: createResult.companycamId,
          });
        } else if (options.hubspotDealId) {
          await storage.createSyncMapping({
            hubspotDealId: options.hubspotDealId,
            procoreProjectId: options.procoreProjectId || null,
            companyCamProjectId: createResult.companycamId,
            hubspotDealName: projectData.name,
          });
        }
      }
      
      await storage.createAuditLog({
        action: 'companycam_project_created',
        entityType: 'companycam_project',
        entityId: createResult.companycamId,
        source: 'automation',
        status: 'success',
        details: {
          projectName: projectData.name,
          hubspotDealId: options.hubspotDealId,
          procoreProjectId: options.procoreProjectId,
        },
      });
      
      return {
        success: true,
        companycamId: createResult.companycamId,
        projectUrl: createResult.projectUrl,
        isNewProject: true,
      };
    }
    
    return { success: false, error: createResult.error, isNewProject: false };
  } catch (error: any) {
    console.error(`[CompanyCam] Error in findOrCreate: ${error.message}`);
    return { success: false, error: error.message, isNewProject: false };
  }
}

export async function linkCompanyCamProject(
  companycamId: string,
  options: {
    hubspotDealId?: string;
    procoreProjectId?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!options.hubspotDealId && !options.procoreProjectId) {
      return { success: false, error: 'At least one of hubspotDealId or procoreProjectId is required' };
    }
    
    const existingByHubspot = options.hubspotDealId 
      ? await storage.getSyncMappingByHubspotDealId(options.hubspotDealId)
      : null;
    const existingByProcore = options.procoreProjectId
      ? await storage.getSyncMappingByProcoreProjectId(options.procoreProjectId)
      : null;
    
    if (existingByHubspot) {
      await storage.updateSyncMapping(existingByHubspot.id, {
        companyCamProjectId: companycamId,
        procoreProjectId: options.procoreProjectId || existingByHubspot.procoreProjectId,
      });
    } else if (existingByProcore) {
      await storage.updateSyncMapping(existingByProcore.id, {
        companyCamProjectId: companycamId,
        hubspotDealId: options.hubspotDealId || existingByProcore.hubspotDealId,
      });
    } else {
      await storage.createSyncMapping({
        hubspotDealId: options.hubspotDealId || null,
        procoreProjectId: options.procoreProjectId || null,
        companyCamProjectId: companycamId,
      });
    }
    
    console.log(`[CompanyCam] Linked project ${companycamId} to HubSpot: ${options.hubspotDealId}, Procore: ${options.procoreProjectId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[CompanyCam] Error linking project: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function autoLinkCompanyCamOnDealStage(
  hubspotDealId: string,
  dealName: string,
  stage: string,
  address?: string
): Promise<{
  success: boolean;
  companycamId?: string;
  isNewProject: boolean;
  error?: string;
}> {
  const triggerStages = ['rfp', 'estimating', 'proposal_sent'];
  
  const normalizedStage = stage.toLowerCase().replace(/[^a-z0-9]/g, '');
  const shouldTrigger = triggerStages.some(s => normalizedStage.includes(s));
  
  if (!shouldTrigger) {
    return { success: false, error: 'Stage does not trigger CompanyCam creation', isNewProject: false };
  }
  
  const existingMapping = await storage.getSyncMappingByHubspotDealId(hubspotDealId);
  if (existingMapping?.companyCamProjectId) {
    return { 
      success: true, 
      companycamId: existingMapping.companyCamProjectId, 
      isNewProject: false 
    };
  }
  
  const result = await findOrCreateCompanyCamProject(
    { name: dealName, streetAddress: address },
    { hubspotDealId }
  );
  
  return result;
}

export async function findDuplicateCompanyCamProjects(): Promise<Array<{
  group: Array<{
    companycamId: string;
    name: string;
    streetAddress: string | null;
    createdAt: Date | null;
  }>;
  similarity: number;
}>> {
  const duplicates: Array<{
    group: Array<{
      companycamId: string;
      name: string;
      streetAddress: string | null;
      createdAt: Date | null;
    }>;
    similarity: number;
  }> = [];

  const { data: allProjects } = await storage.getCompanycamProjects({ limit: 10000 });
  const processed = new Set<string>();

  for (let i = 0; i < allProjects.length; i++) {
    if (processed.has(allProjects[i].companycamId)) continue;
    
    const normalizedName = normalizeName(allProjects[i].name);
    const normalizedAddress = normalizeAddress(allProjects[i].streetAddress);
    const group: Array<{
      companycamId: string;
      name: string;
      streetAddress: string | null;
      createdAt: Date | null;
    }> = [];

    for (let j = i; j < allProjects.length; j++) {
      if (processed.has(allProjects[j].companycamId)) continue;
      
      const otherName = normalizeName(allProjects[j].name);
      const otherAddress = normalizeAddress(allProjects[j].streetAddress);
      
      let score = 0;
      if (normalizedName === otherName) score += 80;
      else if (normalizedName.includes(otherName) || otherName.includes(normalizedName)) score += 40;
      
      if (normalizedAddress && otherAddress) {
        if (normalizedAddress === otherAddress) score += 80;
        else if (normalizedAddress.includes(otherAddress) || otherAddress.includes(normalizedAddress)) score += 40;
      }
      
      if (score >= 80) {
        group.push({
          companycamId: allProjects[j].companycamId,
          name: allProjects[j].name || '',
          streetAddress: allProjects[j].streetAddress,
          createdAt: allProjects[j].companycamCreatedAt,
        });
        processed.add(allProjects[j].companycamId);
      }
    }

    if (group.length > 1) {
      duplicates.push({
        group,
        similarity: 80,
      });
    }
  }

  return duplicates;
}

function extractProcoreIdFromIntegrations(ccProject: any): string | null {
  const integrations = ccProject.integrations;
  const properties = ccProject.properties;
  
  // Check integrations field (array format from CompanyCam API)
  if (Array.isArray(integrations)) {
    const procoreInt = integrations.find((i: any) => 
      i.type?.toLowerCase() === 'procore' || 
      i.provider?.toLowerCase() === 'procore' || 
      i.name?.toLowerCase() === 'procore'
    );
    if (procoreInt) {
      // CompanyCam uses 'relation_id' for the linked Procore project ID
      if (procoreInt.relation_id) return String(procoreInt.relation_id);
      if (procoreInt.project_id) return String(procoreInt.project_id);
      if (procoreInt.external_id) return String(procoreInt.external_id);
      if (procoreInt.id) return String(procoreInt.id);
    }
  }
  
  // Check object format integrations
  if (integrations && !Array.isArray(integrations)) {
    if (integrations.procore?.relation_id) return String(integrations.procore.relation_id);
    if (integrations.procore?.project_id) return String(integrations.procore.project_id);
    if (integrations.procore?.id) return String(integrations.procore.id);
  }
  
  // Check properties for various possible field names
  if (properties) {
    // Direct fields
    if (properties.procore_project_id) return String(properties.procore_project_id);
    if (properties.procore_id) return String(properties.procore_id);
    
    // Check integration_relation_id (seen in some CompanyCam responses)
    if (properties.integration_relation_id) return String(properties.integration_relation_id);
    
    // Check external_ids array (CompanyCam v2 API format)
    if (Array.isArray(properties.external_ids)) {
      const procoreExt = properties.external_ids.find((e: any) => 
        e.source?.toLowerCase() === 'procore' || 
        e.type?.toLowerCase() === 'procore' || 
        e.provider?.toLowerCase() === 'procore'
      );
      if (procoreExt?.relation_id) return String(procoreExt.relation_id);
      if (procoreExt?.id) return String(procoreExt.id);
      if (procoreExt?.external_id) return String(procoreExt.external_id);
    }
    
    // Check nested integrations in properties
    if (Array.isArray(properties.integrations)) {
      const procoreInt = properties.integrations.find((i: any) => 
        i.type?.toLowerCase() === 'procore' || 
        i.provider?.toLowerCase() === 'procore' || 
        i.name?.toLowerCase() === 'procore'
      );
      if (procoreInt?.relation_id) return String(procoreInt.relation_id);
      if (procoreInt?.project_id) return String(procoreInt.project_id);
      if (procoreInt?.external_id) return String(procoreInt.external_id);
    }
    if (properties.integrations?.procore?.relation_id) return String(properties.integrations.procore.relation_id);
    if (properties.integrations?.procore?.project_id) return String(properties.integrations.procore.project_id);
  }
  
  return null;
}

function extractHubspotIdFromIntegrations(ccProject: any): string | null {
  const integrations = ccProject.integrations;
  const properties = ccProject.properties;
  
  // Check integrations field (array format from CompanyCam API)
  if (Array.isArray(integrations)) {
    const hubspotInt = integrations.find((i: any) => 
      i.type?.toLowerCase() === 'hubspot' || 
      i.provider?.toLowerCase() === 'hubspot' || 
      i.name?.toLowerCase() === 'hubspot'
    );
    if (hubspotInt) {
      // CompanyCam uses 'relation_id' for linked IDs
      if (hubspotInt.relation_id) return String(hubspotInt.relation_id);
      if (hubspotInt.deal_id) return String(hubspotInt.deal_id);
      if (hubspotInt.external_id) return String(hubspotInt.external_id);
      if (hubspotInt.id) return String(hubspotInt.id);
    }
  }
  
  // Check object format integrations
  if (integrations && !Array.isArray(integrations)) {
    if (integrations.hubspot?.relation_id) return String(integrations.hubspot.relation_id);
    if (integrations.hubspot?.deal_id) return String(integrations.hubspot.deal_id);
    if (integrations.hubspot?.id) return String(integrations.hubspot.id);
  }
  
  // Check properties for various possible field names
  if (properties) {
    // Direct fields
    if (properties.hubspot_deal_id) return String(properties.hubspot_deal_id);
    if (properties.hubspot_id) return String(properties.hubspot_id);
    
    // Check external_ids array (CompanyCam v2 API format)
    if (Array.isArray(properties.external_ids)) {
      const hubspotExt = properties.external_ids.find((e: any) => 
        e.source?.toLowerCase() === 'hubspot' || 
        e.type?.toLowerCase() === 'hubspot' || 
        e.provider?.toLowerCase() === 'hubspot'
      );
      if (hubspotExt?.relation_id) return String(hubspotExt.relation_id);
      if (hubspotExt?.id) return String(hubspotExt.id);
      if (hubspotExt?.external_id) return String(hubspotExt.external_id);
    }
    
    // Check nested integrations in properties
    if (Array.isArray(properties.integrations)) {
      const hubspotInt = properties.integrations.find((i: any) => 
        i.type?.toLowerCase() === 'hubspot' || 
        i.provider?.toLowerCase() === 'hubspot' ||
        i.name?.toLowerCase() === 'hubspot'
      );
      if (hubspotInt?.relation_id) return String(hubspotInt.relation_id);
      if (hubspotInt?.deal_id) return String(hubspotInt.deal_id);
      if (hubspotInt?.external_id) return String(hubspotInt.external_id);
    }
    if (properties.integrations?.hubspot?.relation_id) return String(properties.integrations.hubspot.relation_id);
    if (properties.integrations?.hubspot?.deal_id) return String(properties.integrations.hubspot.deal_id);
  }
  
  return null;
}

export async function bulkMatchCompanyCamToProcore(): Promise<{
  success: boolean;
  totalCompanyCam: number;
  totalProcore: number;
  matched: number;
  matchedViaIntegration: number;
  matchedViaFuzzy: number;
  alreadyMatched: number;
  noMatch: number;
  errors: number;
  message?: string;
  details: Array<{
    companycamId: string;
    companycamName: string;
    procoreProjectId?: string;
    procoreProjectName?: string;
    hubspotDealId?: string;
    matchType?: 'integration' | 'fuzzy';
    matchScore?: number;
    status: 'matched' | 'already_matched' | 'no_match' | 'error';
    error?: string;
  }>;
}> {
  console.log('[CompanyCam] Starting bulk auto-match to Procore/HubSpot projects...');
  
  const results = {
    success: true,
    totalCompanyCam: 0,
    totalProcore: 0,
    matched: 0,
    matchedViaIntegration: 0,
    matchedViaFuzzy: 0,
    alreadyMatched: 0,
    noMatch: 0,
    errors: 0,
    message: undefined as string | undefined,
    details: [] as Array<{
      companycamId: string;
      companycamName: string;
      procoreProjectId?: string;
      procoreProjectName?: string;
      hubspotDealId?: string;
      matchType?: 'integration' | 'fuzzy';
      matchScore?: number;
      status: 'matched' | 'already_matched' | 'no_match' | 'error';
      error?: string;
    }>,
  };

  try {
    console.log('[CompanyCam] Fetching CompanyCam projects from database...');
    const ccResult = await storage.getCompanycamProjects({ limit: 2000 });
    const companycamProjects = ccResult?.data || [];
    console.log(`[CompanyCam] CompanyCam query returned: ${companycamProjects.length} projects (total in DB: ${ccResult?.total || 0})`);
    
    console.log('[CompanyCam] Fetching Procore projects from database...');
    const procoreResult = await storage.getProcoreProjects({ limit: 2000 });
    const procoreProjects = procoreResult?.data || [];
    console.log(`[CompanyCam] Procore query returned: ${procoreProjects.length} projects (total in DB: ${procoreResult?.total || 0})`);
    
    console.log('[CompanyCam] Fetching sync mappings...');
    const allMappings = await storage.getSyncMappings();
    console.log(`[CompanyCam] Found ${allMappings?.length || 0} existing sync mappings`);
    
    results.totalCompanyCam = companycamProjects.length;
    results.totalProcore = procoreProjects.length;
    
    if (companycamProjects.length === 0) {
      console.log('[CompanyCam] WARNING: No CompanyCam projects found in database. Have you synced CompanyCam data first?');
      results.message = 'No CompanyCam projects found in database. Run CompanyCam sync first.';
      return results;
    }
    
    if (procoreProjects.length === 0) {
      console.log('[CompanyCam] WARNING: No Procore projects found in database. Have you synced Procore data first?');
      results.message = 'No Procore projects found in database. Run Procore sync first.';
      return results;
    }
    
    console.log(`[CompanyCam] Starting matching: ${companycamProjects.length} CompanyCam → ${procoreProjects.length} Procore projects`);
    
    const companycamAlreadyLinked = new Set(
      allMappings.filter(m => m.companyCamProjectId).map(m => m.companyCamProjectId)
    );
    
    const procoreMappingLookup = new Map(
      allMappings.filter(m => m.procoreProjectId).map(m => [m.procoreProjectId, m])
    );
    
    const hubspotMappingLookup = new Map(
      allMappings.filter(m => m.hubspotDealId).map(m => [m.hubspotDealId, m])
    );
    
    const procoreProjectLookup = new Map(
      procoreProjects.map(p => [p.procoreId, p])
    );

    let sampleIntegrations: any[] = [];

    for (const ccProject of companycamProjects) {
      if (companycamAlreadyLinked.has(ccProject.companycamId)) {
        results.alreadyMatched++;
        results.details.push({
          companycamId: ccProject.companycamId,
          companycamName: ccProject.name || '',
          status: 'already_matched',
        });
        continue;
      }

      if (sampleIntegrations.length < 5 && (ccProject.integrations || ccProject.properties)) {
        sampleIntegrations.push({
          name: ccProject.name,
          integrations: ccProject.integrations,
          propertiesKeys: ccProject.properties ? Object.keys(ccProject.properties) : [],
        });
      }

      const directProcoreId = extractProcoreIdFromIntegrations(ccProject);
      const directHubspotId = extractHubspotIdFromIntegrations(ccProject);
      
      if (directProcoreId) {
        try {
          const existingMapping = procoreMappingLookup.get(directProcoreId);
          const procoreProject = procoreProjectLookup.get(directProcoreId);
          
          if (existingMapping) {
            await storage.updateSyncMapping(existingMapping.id, {
              companyCamProjectId: ccProject.companycamId,
            });
          } else {
            await storage.createSyncMapping({
              procoreProjectId: directProcoreId,
              procoreProjectName: procoreProject?.name || null,
              procoreProjectNumber: procoreProject?.projectNumber || null,
              companyCamProjectId: ccProject.companycamId,
              hubspotDealId: directHubspotId,
            });
          }
          
          results.matched++;
          results.matchedViaIntegration++;
          results.details.push({
            companycamId: ccProject.companycamId,
            companycamName: ccProject.name || '',
            procoreProjectId: directProcoreId,
            procoreProjectName: procoreProject?.name || '',
            matchType: 'integration',
            status: 'matched',
          });
          
          console.log(`[CompanyCam] Matched via integration: "${ccProject.name}" → Procore ID: ${directProcoreId}`);
          continue;
        } catch (error: any) {
          results.errors++;
          results.details.push({
            companycamId: ccProject.companycamId,
            companycamName: ccProject.name || '',
            status: 'error',
            error: error.message,
          });
          continue;
        }
      }
      
      if (directHubspotId) {
        try {
          const existingMapping = hubspotMappingLookup.get(directHubspotId);
          
          if (existingMapping) {
            await storage.updateSyncMapping(existingMapping.id, {
              companyCamProjectId: ccProject.companycamId,
            });
            
            results.matched++;
            results.matchedViaIntegration++;
            results.details.push({
              companycamId: ccProject.companycamId,
              companycamName: ccProject.name || '',
              hubspotDealId: directHubspotId,
              procoreProjectId: existingMapping.procoreProjectId || undefined,
              matchType: 'integration',
              status: 'matched',
            });
            
            console.log(`[CompanyCam] Matched via HubSpot integration: "${ccProject.name}" → HubSpot ID: ${directHubspotId}`);
            continue;
          }
        } catch (error: any) {
          console.error(`[CompanyCam] Error matching via HubSpot: ${error.message}`);
        }
      }

      const normalizedCCName = normalizeName(ccProject.name);
      const normalizedCCAddress = normalizeAddress(ccProject.streetAddress);
      const normalizedCCCity = (ccProject.city || '').toLowerCase().trim();
      
      let bestMatch: { project: typeof procoreProjects[0]; score: number } | null = null;
      
      for (const procoreProject of procoreProjects) {
        let score = 0;
        
        const normalizedProcoreName = normalizeName(procoreProject.name);
        const normalizedProcoreAddress = normalizeAddress(procoreProject.address);
        const normalizedProcoreCity = (procoreProject.city || '').toLowerCase().trim();
        
        if (normalizedCCName && normalizedProcoreName) {
          if (normalizedCCName === normalizedProcoreName) {
            score += 100;
          } else if (normalizedCCName.includes(normalizedProcoreName) || normalizedProcoreName.includes(normalizedCCName)) {
            const shorter = normalizedCCName.length < normalizedProcoreName.length ? normalizedCCName : normalizedProcoreName;
            const longer = normalizedCCName.length >= normalizedProcoreName.length ? normalizedCCName : normalizedProcoreName;
            const overlap = shorter.length / longer.length;
            if (overlap > 0.7) score += 70;
            else if (overlap > 0.5) score += 50;
            else score += 30;
          }
        }
        
        if (normalizedCCAddress && normalizedProcoreAddress) {
          if (normalizedCCAddress === normalizedProcoreAddress) {
            score += 80;
          } else if (normalizedCCAddress.includes(normalizedProcoreAddress) || normalizedProcoreAddress.includes(normalizedCCAddress)) {
            score += 40;
          }
        }
        
        if (normalizedCCCity && normalizedProcoreCity && normalizedCCCity === normalizedProcoreCity) {
          score += 20;
        }
        
        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { project: procoreProject, score };
        }
      }
      
      if (bestMatch && bestMatch.score >= 70) {
        try {
          const existingMapping = procoreMappingLookup.get(bestMatch.project.procoreId);
          
          if (existingMapping) {
            await storage.updateSyncMapping(existingMapping.id, {
              companyCamProjectId: ccProject.companycamId,
            });
          } else {
            await storage.createSyncMapping({
              procoreProjectId: bestMatch.project.procoreId,
              procoreProjectName: bestMatch.project.name,
              procoreProjectNumber: bestMatch.project.projectNumber,
              companyCamProjectId: ccProject.companycamId,
              hubspotDealId: null,
            });
          }
          
          results.matched++;
          results.matchedViaFuzzy++;
          results.details.push({
            companycamId: ccProject.companycamId,
            companycamName: ccProject.name || '',
            procoreProjectId: bestMatch.project.procoreId,
            procoreProjectName: bestMatch.project.name || '',
            matchType: 'fuzzy',
            matchScore: bestMatch.score,
            status: 'matched',
          });
          
          console.log(`[CompanyCam] Matched via fuzzy: "${ccProject.name}" → "${bestMatch.project.name}" (score: ${bestMatch.score})`);
        } catch (error: any) {
          results.errors++;
          results.details.push({
            companycamId: ccProject.companycamId,
            companycamName: ccProject.name || '',
            status: 'error',
            error: error.message,
          });
        }
      } else {
        results.noMatch++;
        results.details.push({
          companycamId: ccProject.companycamId,
          companycamName: ccProject.name || '',
          matchScore: bestMatch?.score,
          status: 'no_match',
        });
      }
    }
    
    console.log(`[CompanyCam] Bulk match complete: ${results.matched} matched (${results.matchedViaIntegration} via integration, ${results.matchedViaFuzzy} via fuzzy), ${results.alreadyMatched} already matched, ${results.noMatch} no match, ${results.errors} errors`);
    
    if (sampleIntegrations.length > 0) {
      console.log('[CompanyCam] Sample integration data from first few projects:', JSON.stringify(sampleIntegrations, null, 2));
    }
    
  } catch (error: any) {
    console.error(`[CompanyCam] Bulk match error: ${error.message}`);
    results.success = false;
  }
  
  return results;
}
