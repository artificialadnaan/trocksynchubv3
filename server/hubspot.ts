import { Client } from '@hubspot/api-client';

// HubSpot integration via Replit connector
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

export async function fetchHubSpotDeals(limit = 20): Promise<any[]> {
  const client = await getHubSpotClient();
  const response = await client.crm.deals.basicApi.getPage(
    limit,
    undefined,
    ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hs_lastmodifieddate', 'hubspot_owner_id']
  );
  return response.results || [];
}

export async function fetchHubSpotCompanies(limit = 20): Promise<any[]> {
  const client = await getHubSpotClient();
  const response = await client.crm.companies.basicApi.getPage(
    limit,
    undefined,
    ['name', 'domain', 'phone', 'city', 'state', 'address', 'zip']
  );
  return response.results || [];
}

export async function fetchHubSpotContacts(limit = 20): Promise<any[]> {
  const client = await getHubSpotClient();
  const response = await client.crm.contacts.basicApi.getPage(
    limit,
    undefined,
    ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle']
  );
  return response.results || [];
}
