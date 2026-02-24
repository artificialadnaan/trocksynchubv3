import { Client } from '@hubspot/api-client';
import { storage } from './storage';

let connectionSettings: any;

async function getAccessToken(): Promise<string> {
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
    throw new Error('Replit connector environment not available. Make sure HubSpot integration is set up.');
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
    throw new Error('HubSpot not connected via Replit integration. Please set up the HubSpot connection.');
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
      message: `Connected! Found ${response.total || 0} deals in your HubSpot account.`,
      data: { totalDeals: response.total }
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

export async function syncHubSpotContacts(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const client = await getHubSpotClient();
  const properties = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'lifecyclestage', 'hubspot_owner_id', 'associatedcompanyid', 'hs_lastmodifieddate'];

  const allContacts = await fetchAllPages((after) =>
    client.crm.contacts.basicApi.getPage(100, after, properties)
  );

  let created = 0, updated = 0, changes = 0;

  for (const contact of allContacts) {
    const hubspotId = contact.id;
    const props = contact.properties || {};
    const existing = await storage.getHubspotContactByHubspotId(hubspotId);

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
      associatedCompanyId: props.associatedcompanyid || null,
      properties: props,
      hubspotUpdatedAt: props.hs_lastmodifieddate ? new Date(props.hs_lastmodifieddate) : null,
    };

    if (existing) {
      const changedFields = detectChanges(existing, data, ['firstName', 'lastName', 'email', 'phone', 'company', 'jobTitle', 'lifecycleStage', 'ownerId']);
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

export async function syncHubSpotDeals(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const client = await getHubSpotClient();
  const properties = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hubspot_owner_id', 'hs_lastmodifieddate'];

  const allDeals = await fetchAllPages((after) =>
    client.crm.deals.basicApi.getPage(100, after, properties)
  );

  const pipelines = await syncHubSpotPipelines();
  const stageMap = new Map<string, { stageName: string; pipelineName: string; pipelineId: string }>();
  for (const p of pipelines) {
    const stages = (p.stages as any[]) || [];
    for (const s of stages) {
      stageMap.set(s.stageId, { stageName: s.label, pipelineName: p.label, pipelineId: p.hubspotId });
    }
  }

  let created = 0, updated = 0, changes = 0;

  for (const deal of allDeals) {
    const hubspotId = deal.id;
    const props = deal.properties || {};
    const existing = await storage.getHubspotDealByHubspotId(hubspotId);
    const stageInfo = stageMap.get(props.dealstage);

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
      properties: props,
      hubspotUpdatedAt: props.hs_lastmodifieddate ? new Date(props.hs_lastmodifieddate) : null,
    };

    if (existing) {
      const changedFields = detectChanges(existing, data, ['dealName', 'amount', 'dealStage', 'dealStageName', 'pipeline', 'pipelineName', 'closeDate', 'ownerId']);
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
    }

    await storage.upsertHubspotDeal(data);
  }

  return { synced: allDeals.length, created, updated, changes };
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

  const [companies, contacts, deals] = await Promise.all([
    syncHubSpotCompanies(),
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
