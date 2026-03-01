/**
 * HubSpot Integration Module
 * ==========================
 * 
 * This module handles all interactions with the HubSpot CRM API.
 * It manages OAuth authentication, data synchronization, and deal/contact operations.
 * 
 * Key Features:
 * - OAuth 2.0 authentication flow (authorization code grant)
 * - Automatic token refresh when tokens expire
 * - Full sync of companies, contacts, deals, and pipelines
 * - Deal stage updates (triggered by Procore stage changes)
 * - Change detection and history tracking
 * 
 * Data Flow:
 * 1. User authenticates via OAuth → tokens stored in database
 * 2. runFullHubSpotSync() fetches all CRM data → cached locally
 * 3. Procore stage changes → mapProcoreStageToHubspot() → update deal stage
 * 4. Webhooks from HubSpot → trigger sync updates
 * 
 * HubSpot API Scopes Required:
 * - crm.objects.deals.read/write
 * - crm.objects.contacts.read
 * - crm.objects.companies.read
 * - crm.schemas.*.read
 * 
 * Key Functions:
 * - getHubSpotClient(): Returns authenticated API client
 * - runFullHubSpotSync(): Syncs all HubSpot data to local database
 * - updateHubSpotDealStage(): Updates deal stage (requires stage ID, not label)
 * - syncHubSpotPipelines(): Syncs pipeline and stage definitions
 * 
 * @module hubspot
 */

import { Client } from '@hubspot/api-client';
import { storage } from './storage';

// HubSpot OAuth configuration
const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

export function getHubSpotOAuthConfig() {
  return {
    clientId: process.env.HUBSPOT_CLIENT_ID || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || '',
    redirectUri: `${process.env.APP_URL || 'http://localhost:5000'}/api/oauth/hubspot/callback`,
    scopes: [
      'crm.objects.deals.read',
      'crm.objects.deals.write',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.schemas.deals.read',
      'crm.schemas.contacts.read',
      'crm.schemas.companies.read',
      'oauth',
    ],
  };
}

export function getHubSpotAuthUrl(): string {
  const config = getHubSpotOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    response_type: 'code',
  });
  return `${HUBSPOT_AUTH_URL}?${params.toString()}`;
}

export async function exchangeHubSpotCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const config = getHubSpotOAuthConfig();
  
  console.log('[hubspot-oauth] Exchanging authorization code for tokens...');
  
  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[hubspot-oauth] Token exchange failed:', response.status, errorText);
    throw new Error(`HubSpot OAuth failed: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('[hubspot-oauth] Token exchange successful, expires_in:', data.expires_in);
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function refreshHubSpotToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const config = getHubSpotOAuthConfig();
  
  console.log('[hubspot-oauth] Refreshing access token...');
  
  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[hubspot-oauth] Token refresh failed:', response.status, errorText);
    throw new Error(`HubSpot token refresh failed: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('[hubspot-oauth] Token refresh successful, new expires_in:', data.expires_in);
  
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function getAccessToken(): Promise<string> {
  console.log('[hubspot] Getting access token...');
  
  // 1. Check for access token stored in database (from Settings page or OAuth flow)
  const storedToken = await storage.getOAuthToken("hubspot");
  
  if (storedToken?.accessToken) {
    console.log('[hubspot] Found stored token in database');
    
    // Check if token is expired and needs refresh
    if (storedToken.expiresAt) {
      const expiresAt = new Date(storedToken.expiresAt).getTime();
      const now = Date.now();
      const fiveMinutes = 5 * 60 * 1000;
      
      if (expiresAt <= now) {
        console.log('[hubspot] Token is expired');
        
        // Try to refresh if we have a refresh token
        if (storedToken.refreshToken) {
          try {
            console.log('[hubspot] Attempting token refresh...');
            const refreshed = await refreshHubSpotToken(storedToken.refreshToken);
            
            // Save the new tokens
            await storage.upsertOAuthToken({
              provider: "hubspot",
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              tokenType: "Bearer",
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
            });
            
            console.log('[hubspot] Token refreshed and saved successfully');
            return refreshed.accessToken;
          } catch (refreshError: any) {
            console.error('[hubspot] Token refresh failed:', refreshError.message);
          }
        }
      } else if (expiresAt - now < fiveMinutes && storedToken.refreshToken) {
        // Token expires soon, proactively refresh
        console.log('[hubspot] Token expires soon, proactively refreshing...');
        try {
          const refreshed = await refreshHubSpotToken(storedToken.refreshToken);
          await storage.upsertOAuthToken({
            provider: "hubspot",
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            tokenType: "Bearer",
            expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
          });
          console.log('[hubspot] Proactive token refresh successful');
          return refreshed.accessToken;
        } catch (e: any) {
          console.warn('[hubspot] Proactive refresh failed, using existing token:', e.message);
        }
      }
      
      // Token is still valid
      if (expiresAt > now) {
        console.log('[hubspot] Using stored token (valid for', Math.round((expiresAt - now) / 60000), 'more minutes)');
        return storedToken.accessToken;
      }
    } else {
      // No expiry set, assume it's a Private App token (doesn't expire)
      console.log('[hubspot] Using stored token (no expiry - likely Private App token)');
      return storedToken.accessToken;
    }
  }

  // 2. Check environment variable (for Private App tokens)
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    console.log('[hubspot] Using HUBSPOT_ACCESS_TOKEN from environment');
    return process.env.HUBSPOT_ACCESS_TOKEN;
  }

  console.error('[hubspot] No valid access token found');
  throw new Error('HubSpot not connected. Please configure HubSpot in Settings or set HUBSPOT_ACCESS_TOKEN environment variable.');
}

export async function getHubSpotClient(): Promise<Client> {
  const accessToken = await getAccessToken();
  console.log('[hubspot] Creating HubSpot client with token (first 10 chars):', accessToken.substring(0, 10) + '...');
  return new Client({ accessToken });
}

export async function testHubSpotConnection(): Promise<{ success: boolean; message: string; data?: any }> {
  console.log('[hubspot-test] Testing HubSpot connection...');
  try {
    const client = await getHubSpotClient();
    
    // Test basic API access
    console.log('[hubspot-test] Fetching deals to verify connection...');
    const dealsResponse = await client.crm.deals.basicApi.getPage(1);
    const totalDeals = (dealsResponse as any).total || dealsResponse.results?.length || 0;
    console.log('[hubspot-test] Deals API successful, found', totalDeals, 'deals');
    
    // Test pipeline access
    console.log('[hubspot-test] Fetching pipelines to verify schema access...');
    try {
      const pipelinesResponse = await client.crm.pipelines.pipelinesApi.getAll('deals');
      const pipelineCount = pipelinesResponse.results?.length || 0;
      const stageCount = pipelinesResponse.results?.reduce((sum, p) => sum + (p.stages?.length || 0), 0) || 0;
      console.log('[hubspot-test] Pipelines API successful, found', pipelineCount, 'pipelines with', stageCount, 'stages');
      
      return {
        success: true,
        message: `Connected! Found ${totalDeals} deals and ${pipelineCount} pipelines (${stageCount} stages).`,
        data: { totalDeals, pipelines: pipelineCount, stages: stageCount }
      };
    } catch (pipelineError: any) {
      console.warn('[hubspot-test] Pipeline access failed:', pipelineError.message);
      return {
        success: true,
        message: `Connected! Found ${totalDeals} deals. Note: Pipeline access may require additional scopes (crm.schemas.deals.read).`,
        data: { totalDeals, pipelineError: pipelineError.message }
      };
    }
  } catch (e: any) {
    console.error('[hubspot-test] Connection test failed:', e.message);
    
    // Provide more helpful error messages
    let message = e.message || 'Failed to connect to HubSpot';
    if (e.message?.includes('401')) {
      message = 'Authentication failed. Please check your HubSpot access token is valid.';
    } else if (e.message?.includes('403')) {
      message = 'Access denied. Your HubSpot token may be missing required scopes.';
    }
    
    return {
      success: false,
      message
    };
  }
}

async function fetchAllPages(fetcher: (after?: string) => Promise<{ results: any[]; paging?: any }>): Promise<any[]> {
  const allResults: any[] = [];
  let after: string | undefined;

  while (true) {
    const response = await fetcher(after);
    allResults.push(...(response.results || []));
    after = response.paging?.next?.after;
    if (!after) break;
  }
  return allResults;
}

export async function syncHubSpotCompanies(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const client = await getHubSpotClient();
  const properties = ['name', 'domain', 'phone', 'address', 'city', 'state', 'zip', 'industry', 'hubspot_owner_id', 'hs_lastmodifieddate'];

  const allCompanies = await fetchAllPages((after) =>
    client.crm.companies.basicApi.getPage(100, after, properties)
  );

  let created = 0, updated = 0, changes = 0;

  for (const company of allCompanies) {
    const hubspotId = company.id;
    const props = company.properties || {};
    const existing = await storage.getHubspotCompanyByHubspotId(hubspotId);

    const data = {
      hubspotId,
      name: props.name || null,
      domain: props.domain || null,
      phone: props.phone || null,
      address: props.address || null,
      city: props.city || null,
      state: props.state || null,
      zip: props.zip || null,
      industry: props.industry || null,
      ownerId: props.hubspot_owner_id || null,
      properties: props,
      hubspotUpdatedAt: props.hs_lastmodifieddate ? new Date(props.hs_lastmodifieddate) : null,
    };

    if (existing) {
      const changedFields = detectChanges(existing, data, ['name', 'domain', 'phone', 'address', 'city', 'state', 'zip', 'industry', 'ownerId']);
      for (const change of changedFields) {
        await storage.createChangeHistory({
          entityType: 'company',
          entityHubspotId: hubspotId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: props,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createChangeHistory({
        entityType: 'company',
        entityHubspotId: hubspotId,
        changeType: 'created',
        fullSnapshot: props,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertHubspotCompany(data);
  }

  return { synced: allCompanies.length, created, updated, changes };
}

async function fetchHubSpotOwners(): Promise<Map<string, string>> {
  const ownerMap = new Map<string, string>();
  const accessToken = await getAccessToken();

  try {
    const response = await fetch('https://api.hubapi.com/crm/v3/owners?limit=500', {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      for (const owner of data.results || []) {
        const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
        const display = owner.email ? `${name} (${owner.email})` : name;
        ownerMap.set(String(owner.id), display);
      }
      if (ownerMap.size > 0) {
        console.log(`Fetched ${ownerMap.size} owners from HubSpot v3 API`);
        return ownerMap;
      }
    }
  } catch (e) {
    console.log('v3 owners API unavailable, trying fallback...');
  }

  try {
    const tokenInfoRes = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${accessToken}`);
    if (tokenInfoRes.ok) {
      const tokenInfo = await tokenInfoRes.json();
      if (tokenInfo.user_id && tokenInfo.user) {
        const email = tokenInfo.user;
        const namePart = email.split('@')[0].split('.').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
        ownerMap.set(String(tokenInfo.user_id), `${namePart} (${email})`);
        console.log(`Resolved owner from token info: ${tokenInfo.user_id} -> ${namePart} (${email})`);
      }
    }
  } catch (e) {
    console.error('Failed to fetch owner info from token endpoint:', e);
  }

  if (ownerMap.size === 0) {
    console.warn('Could not resolve any HubSpot owners. Owner names will show as IDs.');
  }
  return ownerMap;
}

async function fetchContactCompanyAssociations(contactIds: string[]): Promise<Map<string, string>> {
  const assocMap = new Map<string, string>();
  if (!contactIds.length) return assocMap;
  try {
    const accessToken = await getAccessToken();
    const batchSize = 100;
    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);
      const response = await fetch('https://api.hubapi.com/crm/v4/associations/contact/company/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
      });
      if (!response.ok) {
        console.error(`Associations batch API: ${response.status}`);
        continue;
      }
      const data = await response.json();
      for (const result of data.results || []) {
        const contactId = result.from?.id;
        const companyId = result.to?.[0]?.toObjectId;
        if (contactId && companyId) {
          assocMap.set(String(contactId), String(companyId));
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch contact-company associations:', e);
  }
  return assocMap;
}

async function fetchDealCompanyAssociations(dealIds: string[]): Promise<Map<string, string>> {
  const assocMap = new Map<string, string>();
  if (!dealIds.length) return assocMap;
  try {
    const accessToken = await getAccessToken();
    const batchSize = 100;
    for (let i = 0; i < dealIds.length; i += batchSize) {
      const batch = dealIds.slice(i, i + batchSize);
      const response = await fetch('https://api.hubapi.com/crm/v4/associations/deal/company/batch/read', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: batch.map(id => ({ id })) }),
      });
      if (!response.ok) {
        console.error(`Deal associations batch API: ${response.status}`);
        continue;
      }
      const data = await response.json();
      for (const result of data.results || []) {
        const dealId = result.from?.id;
        const companyId = result.to?.[0]?.toObjectId;
        if (dealId && companyId) {
          assocMap.set(String(dealId), String(companyId));
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch deal-company associations:', e);
  }
  return assocMap;
}

export async function syncHubSpotContacts(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const client = await getHubSpotClient();
  const properties = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'lifecyclestage', 'hubspot_owner_id', 'associatedcompanyid', 'hs_lastmodifieddate'];

  const allContacts = await fetchAllPages((after) =>
    client.crm.contacts.basicApi.getPage(100, after, properties)
  );

  const ownerMap = await fetchHubSpotOwners();

  const contactIds = allContacts.map(c => c.id);
  const contactCompanyMap = await fetchContactCompanyAssociations(contactIds);

  const companyNameCache = new Map<string, string>();

  let created = 0, updated = 0, changes = 0;

  for (const contact of allContacts) {
    const hubspotId = contact.id;
    const props = contact.properties || {};
    const existing = await storage.getHubspotContactByHubspotId(hubspotId);

    let associatedCompanyId = contactCompanyMap.get(hubspotId) || props.associatedcompanyid || null;

    let associatedCompanyName: string | null = null;
    if (associatedCompanyId) {
      if (companyNameCache.has(associatedCompanyId)) {
        associatedCompanyName = companyNameCache.get(associatedCompanyId) || null;
      } else {
        const company = await storage.getHubspotCompanyByHubspotId(associatedCompanyId);
        if (company?.name) {
          associatedCompanyName = company.name;
          companyNameCache.set(associatedCompanyId, company.name);
        }
      }
    }

    const ownerName = props.hubspot_owner_id ? (ownerMap.get(props.hubspot_owner_id) || null) : null;

    const data = {
      hubspotId,
      firstName: props.firstname || null,
      lastName: props.lastname || null,
      email: props.email || null,
      phone: props.phone || null,
      company: props.company || null,
      jobTitle: props.jobtitle || null,
      lifecycleStage: props.lifecyclestage || null,
      ownerId: props.hubspot_owner_id || null,
      ownerName,
      associatedCompanyId,
      associatedCompanyName,
      properties: props,
      hubspotUpdatedAt: props.hs_lastmodifieddate ? new Date(props.hs_lastmodifieddate) : null,
    };

    if (existing) {
      const changedFields = detectChanges(existing, data, ['firstName', 'lastName', 'email', 'phone', 'company', 'jobTitle', 'lifecycleStage', 'ownerId', 'ownerName', 'associatedCompanyId', 'associatedCompanyName']);
      for (const change of changedFields) {
        await storage.createChangeHistory({
          entityType: 'contact',
          entityHubspotId: hubspotId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: props,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createChangeHistory({
        entityType: 'contact',
        entityHubspotId: hubspotId,
        changeType: 'created',
        fullSnapshot: props,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertHubspotContact(data);
  }

  return { synced: allContacts.length, created, updated, changes };
}

export async function syncHubSpotDeals(): Promise<{ synced: number; created: number; updated: number; changes: number; newDealIds: string[] }> {
  const client = await getHubSpotClient();
  const properties = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hubspot_owner_id', 'hs_lastmodifieddate'];

  const allDeals = await fetchAllPages((after) =>
    client.crm.deals.basicApi.getPage(100, after, properties)
  );

  const ownerMap = await fetchHubSpotOwners();

  const pipelines = await syncHubSpotPipelines();
  const stageMap = new Map<string, { stageName: string; pipelineName: string; pipelineId: string }>();
  for (const p of pipelines) {
    const stages = (p.stages as any[]) || [];
    for (const s of stages) {
      stageMap.set(s.stageId, { stageName: s.label, pipelineName: p.label, pipelineId: p.hubspotId });
    }
  }

  const dealIds = allDeals.map(d => d.id);
  const dealCompanyMap = await fetchDealCompanyAssociations(dealIds);

  const companyNameCache = new Map<string, string>();
  let created = 0, updated = 0, changes = 0;
  const newDealIds: string[] = [];

  for (const deal of allDeals) {
    const hubspotId = deal.id;
    const props = deal.properties || {};
    const existing = await storage.getHubspotDealByHubspotId(hubspotId);
    const stageInfo = stageMap.get(props.dealstage);

    const associatedCompanyId = dealCompanyMap.get(hubspotId) || null;

    let associatedCompanyName: string | null = null;
    if (associatedCompanyId) {
      if (companyNameCache.has(associatedCompanyId)) {
        associatedCompanyName = companyNameCache.get(associatedCompanyId) || null;
      } else {
        const company = await storage.getHubspotCompanyByHubspotId(associatedCompanyId);
        if (company?.name) {
          associatedCompanyName = company.name;
          companyNameCache.set(associatedCompanyId, company.name);
        }
      }
    }

    const ownerName = props.hubspot_owner_id ? (ownerMap.get(props.hubspot_owner_id) || null) : null;

    const data = {
      hubspotId,
      dealName: props.dealname || null,
      amount: props.amount || null,
      dealStage: props.dealstage || null,
      dealStageName: stageInfo?.stageName || null,
      pipeline: props.pipeline || null,
      pipelineName: stageInfo?.pipelineName || null,
      closeDate: props.closedate || null,
      ownerId: props.hubspot_owner_id || null,
      ownerName,
      associatedCompanyId,
      associatedCompanyName,
      properties: props,
      hubspotUpdatedAt: props.hs_lastmodifieddate ? new Date(props.hs_lastmodifieddate) : null,
    };

    if (existing) {
      const changedFields = detectChanges(existing, data, ['dealName', 'amount', 'dealStage', 'dealStageName', 'pipeline', 'pipelineName', 'closeDate', 'ownerId', 'ownerName', 'associatedCompanyId', 'associatedCompanyName']);
      for (const change of changedFields) {
        await storage.createChangeHistory({
          entityType: 'deal',
          entityHubspotId: hubspotId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: props,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createChangeHistory({
        entityType: 'deal',
        entityHubspotId: hubspotId,
        changeType: 'created',
        fullSnapshot: props,
        syncedAt: new Date(),
      });
      created++;
      changes++;
      newDealIds.push(hubspotId);
    }

    await storage.upsertHubspotDeal(data);
  }

  return { synced: allDeals.length, created, updated, changes, newDealIds };
}

export async function syncHubSpotPipelines(): Promise<any[]> {
  console.log('[hubspot-pipelines] Starting pipeline sync...');
  
  try {
    const client = await getHubSpotClient();
    
    console.log('[hubspot-pipelines] Fetching pipelines from HubSpot API...');
    const response = await client.crm.pipelines.pipelinesApi.getAll('deals');
    const pipelines = response.results || [];
    
    console.log('[hubspot-pipelines] Found', pipelines.length, 'pipelines from HubSpot');
    
    if (pipelines.length === 0) {
      console.warn('[hubspot-pipelines] No pipelines returned from HubSpot. This could indicate:');
      console.warn('  - Missing scope: crm.schemas.deals.read');
      console.warn('  - No deal pipelines configured in HubSpot');
      return [];
    }
    
    const saved: any[] = [];

    for (const pipeline of pipelines) {
      const stages = (pipeline.stages || []).map((s: any) => ({
        stageId: s.id,
        label: s.label,
        displayOrder: s.displayOrder,
        probability: s.metadata?.probability,
        isClosed: s.metadata?.isClosed === 'true',
      }));

      console.log(`[hubspot-pipelines] Processing pipeline "${pipeline.label}" (${pipeline.id}) with ${stages.length} stages:`);
      stages.forEach((s: any) => console.log(`  - ${s.label} (${s.stageId})`));

      const result = await storage.upsertHubspotPipeline({
        hubspotId: pipeline.id,
        label: pipeline.label,
        displayOrder: pipeline.displayOrder,
        stages,
      });
      saved.push(result);
    }

    const totalStages = saved.reduce((sum, p) => sum + ((p.stages as any[])?.length || 0), 0);
    console.log(`[hubspot-pipelines] Sync complete: ${saved.length} pipelines, ${totalStages} stages saved to database`);
    
    return saved;
  } catch (e: any) {
    console.error('[hubspot-pipelines] Pipeline sync failed:', e.message);
    
    if (e.message?.includes('403') || e.message?.includes('401')) {
      console.error('[hubspot-pipelines] This appears to be an authentication/authorization error.');
      console.error('[hubspot-pipelines] Make sure your HubSpot app has the "crm.schemas.deals.read" scope.');
    }
    
    throw e;
  }
}

export async function runFullHubSpotSync(): Promise<{
  companies: { synced: number; created: number; updated: number; changes: number };
  contacts: { synced: number; created: number; updated: number; changes: number };
  deals: { synced: number; created: number; updated: number; changes: number };
  pipelines: number;
  purgedHistory: number;
  duration: number;
}> {
  const start = Date.now();

  const companies = await syncHubSpotCompanies();

  const [contacts, deals] = await Promise.all([
    syncHubSpotContacts(),
    syncHubSpotDeals(),
  ]);

  const pipelinesData = await syncHubSpotPipelines();
  const purgedHistory = await storage.purgeOldChangeHistory(14);

  const duration = Date.now() - start;

  return {
    companies,
    contacts,
    deals,
    pipelines: pipelinesData.length,
    purgedHistory,
    duration,
  };
}

export async function updateHubSpotDealStage(hubspotDealId: string, stageId: string): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getHubSpotClient();
    await client.crm.deals.basicApi.update(hubspotDealId, {
      properties: { dealstage: stageId },
    });
    return { success: true, message: `Deal ${hubspotDealId} updated to stage ${stageId}` };
  } catch (e: any) {
    console.error(`Failed to update HubSpot deal ${hubspotDealId}:`, e.message);
    return { success: false, message: e.message };
  }
}

export async function updateHubSpotDeal(hubspotDealId: string, properties: Record<string, string>): Promise<{ success: boolean; message: string }> {
  try {
    const client = await getHubSpotClient();
    await client.crm.deals.basicApi.update(hubspotDealId, { properties });
    return { success: true, message: `Deal ${hubspotDealId} updated` };
  } catch (e: any) {
    console.error(`Failed to update HubSpot deal ${hubspotDealId}:`, e.message);
    return { success: false, message: e.message };
  }
}

export async function getDealOwnerInfo(hubspotDealId: string): Promise<{ ownerId: string | null; ownerName: string | null; ownerEmail: string | null }> {
  try {
    const client = await getHubSpotClient();
    const deal = await client.crm.deals.basicApi.getById(hubspotDealId, ['hubspot_owner_id']);
    const ownerId = deal.properties?.hubspot_owner_id;
    if (!ownerId) return { ownerId: null, ownerName: null, ownerEmail: null };

    const accessToken = await getAccessToken();

    try {
      const ownerResp = await fetch(`https://api.hubapi.com/crm/v3/owners/${ownerId}?idProperty=id`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
      });
      if (ownerResp.ok) {
        const ownerData = await ownerResp.json();
        return {
          ownerId,
          ownerName: `${ownerData.firstName || ''} ${ownerData.lastName || ''}`.trim() || null,
          ownerEmail: ownerData.email || null,
        };
      }
      console.warn(`[HubSpot] Owner lookup returned ${ownerResp.status}, trying owners list...`);
    } catch (ownerErr: any) {
      console.warn(`[HubSpot] Owner lookup failed: ${ownerErr.message?.slice(0, 80)}`);
    }

    try {
      const listResp = await fetch(`https://api.hubapi.com/crm/v3/owners/?limit=100`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        const owner = listData.results?.find((o: any) => String(o.id) === String(ownerId));
        if (owner) {
          return {
            ownerId,
            ownerName: `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || null,
            ownerEmail: owner.email || null,
          };
        }
      }
    } catch (listErr: any) {
      console.warn(`[HubSpot] Owner list lookup failed: ${listErr.message?.slice(0, 80)}`);
    }

    const localDeal = await storage.getHubspotDealByHubspotId(hubspotDealId);
    if (localDeal?.ownerName) {
      return { ownerId, ownerName: localDeal.ownerName || null, ownerEmail: null };
    }

    return { ownerId, ownerName: null, ownerEmail: null };
  } catch (e: any) {
    console.error(`[HubSpot] Failed to get deal owner for ${hubspotDealId}:`, e.message);
    return { ownerId: null, ownerName: null, ownerEmail: null };
  }
}

export interface DealClientData {
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  clientCompany: string;
  clientAddress: string;
  clientCity: string;
  clientState: string;
  clientZip: string;
  contactName: string;
}

export async function getDealClientData(dealId: string): Promise<DealClientData> {
  const result: DealClientData = {
    clientName: '',
    clientEmail: '',
    clientPhone: '',
    clientCompany: '',
    clientAddress: '',
    clientCity: '',
    clientState: '',
    clientZip: '',
    contactName: '',
  };

  try {
    const client = await getHubSpotClient();
    const accessToken = await getAccessToken();

    const deal = await client.crm.deals.basicApi.getById(dealId, [
      'dealname', 'hubspot_owner_id'
    ], undefined, ['companies', 'contacts']);

    const companyId = deal.associations?.companies?.results?.[0]?.id;
    const contactId = deal.associations?.contacts?.results?.[0]?.id;

    if (companyId) {
      const company = await client.crm.companies.basicApi.getById(companyId, [
        'name', 'domain', 'phone', 'address', 'city', 'state', 'zip'
      ]);
      
      result.clientCompany = company.properties?.name || '';
      result.clientName = company.properties?.name || '';
      result.clientPhone = company.properties?.phone || '';
      result.clientAddress = company.properties?.address || '';
      result.clientCity = company.properties?.city || '';
      result.clientState = company.properties?.state || '';
      result.clientZip = company.properties?.zip || '';
    }

    if (contactId) {
      const contact = await client.crm.contacts.basicApi.getById(contactId, [
        'firstname', 'lastname', 'email', 'phone'
      ]);
      
      const firstName = contact.properties?.firstname || '';
      const lastName = contact.properties?.lastname || '';
      result.contactName = `${firstName} ${lastName}`.trim();
      result.clientEmail = contact.properties?.email || '';
      
      if (!result.clientPhone && contact.properties?.phone) {
        result.clientPhone = contact.properties.phone;
      }
    }

    if (!result.clientCompany && !result.contactName) {
      const localDeal = await storage.getHubspotDealByHubspotId(dealId);
      if (localDeal?.associatedCompanyName) {
        result.clientCompany = localDeal.associatedCompanyName;
        result.clientName = localDeal.associatedCompanyName;
      }
    }

    console.log(`[HubSpot] Got client data for deal ${dealId}: ${result.clientCompany || result.contactName || 'Unknown'}`);
    return result;
  } catch (e: any) {
    console.error(`[HubSpot] Failed to get client data for deal ${dealId}:`, e.message);
    return result;
  }
}

function detectChanges(existing: any, newData: any, fields: string[]): { field: string; oldValue: string; newValue: string }[] {
  const changes: { field: string; oldValue: string; newValue: string }[] = [];
  for (const field of fields) {
    const oldVal = String(existing[field] ?? '');
    const newVal = String(newData[field] ?? '');
    if (oldVal !== newVal) {
      changes.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }
  return changes;
}
