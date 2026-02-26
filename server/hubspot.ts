import { Client } from '@hubspot/api-client';
import { storage } from './storage';

let connectionSettings: any;

export async function getAccessToken(): Promise<string> {
  if (process.env.HUBSPOT_ACCESS_TOKEN) {
    return process.env.HUBSPOT_ACCESS_TOKEN;
  }

  if (connectionSettings && connectionSettings.settings?.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken || !hostname) {
    throw new Error('HubSpot token not available. Set HUBSPOT_ACCESS_TOKEN env var or configure Replit HubSpot integration.');
  }

  const response = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=hubspot',
    {
      headers: {
        'Accept': 'application/json',
        'X-Replit-Token': xReplitToken
      }
    }
  );

  const data = await response.json();
  connectionSettings = data.items?.[0];

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('HubSpot not connected. Set HUBSPOT_ACCESS_TOKEN env var or configure Replit HubSpot integration.');
  }
  return accessToken;
}

export async function getHubSpotClient(): Promise<Client> {
  const accessToken = await getAccessToken();
  return new Client({ accessToken });
}

export async function testHubSpotConnection(): Promise<{ success: boolean; message: string; data?: any }> {
  try {
    const client = await getHubSpotClient();
    const response = await client.crm.deals.basicApi.getPage(1);
    return {
      success: true,
      message: `Connected! Found ${(response as any).total || response.results?.length || 0} deals in your HubSpot account.`,
      data: { totalDeals: (response as any).total || response.results?.length || 0 }
    };
  } catch (e: any) {
    return {
      success: false,
      message: e.message || 'Failed to connect to HubSpot'
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
  const client = await getHubSpotClient();
  const response = await client.crm.pipelines.pipelinesApi.getAll('deals');
  const pipelines = response.results || [];
  const saved: any[] = [];

  for (const pipeline of pipelines) {
    const stages = (pipeline.stages || []).map((s: any) => ({
      stageId: s.id,
      label: s.label,
      displayOrder: s.displayOrder,
      probability: s.metadata?.probability,
      isClosed: s.metadata?.isClosed === 'true',
    }));

    const result = await storage.upsertHubspotPipeline({
      hubspotId: pipeline.id,
      label: pipeline.label,
      displayOrder: pipeline.displayOrder,
      stages,
    });
    saved.push(result);
  }

  return saved;
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
