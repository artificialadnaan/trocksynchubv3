import { storage } from './storage';
import type { HubspotCompany, HubspotContact, ProcoreVendor } from '@shared/schema';

async function getProcoreConfig(): Promise<{ companyId: string; environment: string }> {
  const config = await storage.getAutomationConfig("procore_config");
  if (!config?.value) throw new Error("Procore not configured.");
  const val = config.value as any;
  return {
    companyId: val.companyId || "598134325683880",
    environment: val.environment || "production",
  };
}

function getBaseUrl(environment: string): string {
  return environment === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";
}

async function getAccessToken(): Promise<string> {
  const token = await storage.getOAuthToken("procore");
  if (!token?.accessToken) throw new Error("No Procore OAuth token found.");

  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() + 60000) {
    if (token.refreshToken) {
      const config = await storage.getAutomationConfig("procore_config");
      const val = (config?.value as any) || {};
      const loginUrl = (val.environment === "sandbox") ? "https://login-sandbox.procore.com" : "https://login.procore.com";
      const response = await fetch(`${loginUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: val.clientId,
          client_secret: val.clientSecret,
          refresh_token: token.refreshToken,
        }),
      });
      if (!response.ok) throw new Error("Failed to refresh Procore token");
      const data = await response.json();
      await storage.upsertOAuthToken({
        provider: "procore",
        accessToken: data.access_token,
        refreshToken: data.refresh_token || token.refreshToken,
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + (data.expires_in || 7200) * 1000),
      });
      return data.access_token;
    }
    throw new Error("Procore token expired.");
  }
  return token.accessToken;
}

async function procoreApiCall(method: string, endpoint: string, body?: any): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const url = `${baseUrl}${endpoint}`;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    'Procore-Company-Id': config.companyId,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Procore API ${method} ${endpoint}: ${response.status} ${errText}`);
  }
  return response.json();
}

function normalize(str: string | null | undefined): string {
  if (!str) return '';
  return str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractDomain(emailOrDomain: string | null | undefined): string {
  if (!emailOrDomain) return '';
  const s = emailOrDomain.trim().toLowerCase();
  if (s.includes('@')) return s.split('@').pop() || '';
  return s.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
}

function computeMatchScore(
  vendor: ProcoreVendor,
  criteria: {
    email?: string | null;
    domain?: string | null;
    companyName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (criteria.email && vendor.emailAddress) {
    if (normalize(criteria.email) === normalize(vendor.emailAddress)) {
      score += 100;
      reasons.push('exact_email');
    }
  }

  if (criteria.domain) {
    const vendorDomain = extractDomain(vendor.website) || extractDomain(vendor.emailAddress);
    if (vendorDomain && criteria.domain === vendorDomain) {
      score += 80;
      reasons.push('domain_match');
    }
  }

  if (criteria.companyName && vendor.name) {
    const normCompany = normalize(criteria.companyName);
    const normVendor = normalize(vendor.name);
    if (normCompany === normVendor) {
      score += 90;
      reasons.push('exact_company_name');
    } else if (normCompany.length > 3 && normVendor.length > 3) {
      if (normVendor.includes(normCompany) || normCompany.includes(normVendor)) {
        score += 60;
        reasons.push('partial_company_name');
      }
    }
  }

  if (criteria.companyName && vendor.legalName) {
    const normCompany = normalize(criteria.companyName);
    const normLegal = normalize(vendor.legalName);
    if (normCompany === normLegal) {
      score += 70;
      reasons.push('legal_name_match');
    }
  }

  if (criteria.companyName && vendor.tradeName) {
    const normCompany = normalize(criteria.companyName);
    const normTrade = normalize(vendor.tradeName);
    if (normCompany === normTrade) {
      score += 70;
      reasons.push('trade_name_match');
    }
  }

  if (criteria.firstName && criteria.lastName && vendor.name) {
    const fullName = normalize(`${criteria.firstName}${criteria.lastName}`);
    const vendorName = normalize(vendor.name);
    if (fullName === vendorName || vendorName.includes(fullName)) {
      score += 40;
      reasons.push('person_name_in_vendor');
    }
  }

  return { score, reasons };
}

const MATCH_THRESHOLD = 60;

async function findMatchingVendor(
  criteria: {
    email?: string | null;
    domain?: string | null;
    companyName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }
): Promise<{ vendor: ProcoreVendor; score: number; reasons: string[] } | null> {
  const searchTerms: string[] = [];
  if (criteria.companyName) searchTerms.push(criteria.companyName);
  if (criteria.email) searchTerms.push(criteria.email);
  if (criteria.domain) searchTerms.push(criteria.domain);
  if (criteria.firstName) searchTerms.push(criteria.firstName);
  if (criteria.lastName) searchTerms.push(criteria.lastName);

  let allVendors: ProcoreVendor[] = [];

  for (const term of searchTerms) {
    if (!term) continue;
    const result = await storage.getProcoreVendors({ search: term, limit: 100, offset: 0 });
    for (const v of result.data) {
      if (!allVendors.find(ev => ev.id === v.id)) {
        allVendors.push(v);
      }
    }
  }

  if (allVendors.length === 0) {
    const result = await storage.getProcoreVendors({ limit: 5000, offset: 0 });
    allVendors = result.data;
  }

  let bestMatch: { vendor: ProcoreVendor; score: number; reasons: string[] } | null = null;

  for (const vendor of allVendors) {
    const { score, reasons } = computeMatchScore(vendor, criteria);
    if (score >= MATCH_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { vendor, score, reasons };
    }
  }

  return bestMatch;
}

function buildVendorFieldsFromCompany(company: HubspotCompany): Record<string, any> {
  const fields: Record<string, any> = {};
  if (company.name) fields.name = company.name;
  if (company.domain) fields.website = company.domain.startsWith('http') ? company.domain : `https://${company.domain}`;
  if (company.phone) fields.business_phone = company.phone;
  if (company.address) fields.address = company.address;
  if (company.city) fields.city = company.city;
  if (company.state) fields.state_code = company.state;
  if (company.zip) fields.zip = company.zip;
  return fields;
}

function buildVendorFieldsFromContact(contact: HubspotContact): Record<string, any> {
  const fields: Record<string, any> = {};
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  if (contact.company) fields.name = contact.company;
  else if (name) fields.name = name;
  if (contact.email) fields.email_address = contact.email;
  if (contact.phone) fields.business_phone = contact.phone;
  return fields;
}

function nonDestructiveMerge(existing: Record<string, any>, newFields: Record<string, any>): Record<string, any> {
  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(newFields)) {
    if (value == null || value === '') continue;
    const existingVal = existing[key];
    if (existingVal == null || existingVal === '' || existingVal === undefined) {
      updates[key] = value;
    }
  }
  return updates;
}

function mapProcoreVendorToFieldMap(vendor: ProcoreVendor): Record<string, any> {
  return {
    name: vendor.name,
    website: vendor.website,
    business_phone: vendor.businessPhone,
    email_address: vendor.emailAddress,
    address: vendor.address,
    city: vendor.city,
    state_code: vendor.stateCode,
    zip: vendor.zip,
    legal_name: vendor.legalName,
    trade_name: vendor.tradeName,
    mobile_phone: vendor.mobilePhone,
    fax_number: vendor.faxNumber,
  };
}

export async function syncHubspotCompanyToProcore(hubspotId: string): Promise<{
  action: 'created' | 'updated' | 'skipped';
  vendorId?: string;
  vendorName?: string;
  matchScore?: number;
  matchReasons?: string[];
  fieldsUpdated?: string[];
  message: string;
}> {
  const company = await storage.getHubspotCompanyByHubspotId(hubspotId);
  if (!company) return { action: 'skipped', message: `HubSpot company ${hubspotId} not found in local database` };

  const config = await getProcoreConfig();

  const criteria = {
    companyName: company.name,
    domain: extractDomain(company.domain),
    email: null as string | null,
  };

  const match = await findMatchingVendor(criteria);

  if (match) {
    const vendorFields = buildVendorFieldsFromCompany(company);
    const existingFields = mapProcoreVendorToFieldMap(match.vendor);
    const updates = nonDestructiveMerge(existingFields, vendorFields);

    if (Object.keys(updates).length === 0) {
      await storage.createAuditLog({
        action: 'hubspot_procore_sync_skipped',
        entityType: 'company',
        entityId: hubspotId,
        source: 'automation',
        status: 'success',
        details: {
          reason: 'matched_no_updates_needed',
          vendorId: match.vendor.procoreId,
          vendorName: match.vendor.name,
          matchScore: match.score,
          matchReasons: match.reasons,
        } as any,
      });
      return {
        action: 'skipped',
        vendorId: match.vendor.procoreId,
        vendorName: match.vendor.name || undefined,
        matchScore: match.score,
        matchReasons: match.reasons,
        message: `Matched existing vendor "${match.vendor.name}" (score: ${match.score}) — no empty fields to fill`,
      };
    }

    await procoreApiCall('PATCH', `/rest/v1.0/companies/${config.companyId}/vendors/${match.vendor.procoreId}`, { vendor: updates });

    await storage.createAuditLog({
      action: 'hubspot_procore_vendor_updated',
      entityType: 'company',
      entityId: hubspotId,
      source: 'automation',
      status: 'success',
      details: {
        vendorId: match.vendor.procoreId,
        vendorName: match.vendor.name,
        matchScore: match.score,
        matchReasons: match.reasons,
        fieldsUpdated: Object.keys(updates),
        hubspotCompanyName: company.name,
      } as any,
    });

    return {
      action: 'updated',
      vendorId: match.vendor.procoreId,
      vendorName: match.vendor.name || undefined,
      matchScore: match.score,
      matchReasons: match.reasons,
      fieldsUpdated: Object.keys(updates),
      message: `Updated vendor "${match.vendor.name}" with ${Object.keys(updates).length} field(s): ${Object.keys(updates).join(', ')}`,
    };
  }

  const vendorFields = buildVendorFieldsFromCompany(company);
  if (!vendorFields.name) {
    return { action: 'skipped', message: `HubSpot company ${hubspotId} has no name — cannot create vendor` };
  }

  const result = await procoreApiCall('POST', `/rest/v1.0/companies/${config.companyId}/vendors`, { vendor: vendorFields });

  await storage.upsertProcoreVendor({
    procoreId: String(result.id),
    name: result.name,
    emailAddress: result.email_address,
    businessPhone: result.business_phone,
    address: result.address,
    city: result.city,
    stateCode: result.state_code,
    zip: result.zip,
    website: result.website,
    isActive: result.is_active ?? true,
    companyId: config.companyId,
    properties: result,
    procoreUpdatedAt: result.updated_at ? new Date(result.updated_at) : null,
  });

  await storage.createAuditLog({
    action: 'hubspot_procore_vendor_created',
    entityType: 'company',
    entityId: hubspotId,
    source: 'automation',
    status: 'success',
    details: {
      vendorId: String(result.id),
      vendorName: result.name,
      hubspotCompanyName: company.name,
      fieldsSet: Object.keys(vendorFields),
    } as any,
  });

  return {
    action: 'created',
    vendorId: String(result.id),
    vendorName: result.name,
    message: `Created new Procore vendor "${result.name}" from HubSpot company "${company.name}"`,
  };
}

export async function syncHubspotContactToProcore(hubspotId: string): Promise<{
  action: 'created' | 'updated' | 'skipped';
  vendorId?: string;
  vendorName?: string;
  matchScore?: number;
  matchReasons?: string[];
  fieldsUpdated?: string[];
  message: string;
}> {
  const contact = await storage.getHubspotContactByHubspotId(hubspotId);
  if (!contact) return { action: 'skipped', message: `HubSpot contact ${hubspotId} not found in local database` };

  const config = await getProcoreConfig();

  const criteria = {
    email: contact.email,
    domain: extractDomain(contact.email),
    companyName: contact.company || contact.associatedCompanyName,
    firstName: contact.firstName,
    lastName: contact.lastName,
  };

  const match = await findMatchingVendor(criteria);

  if (match) {
    const contactFields = buildVendorFieldsFromContact(contact);
    const existingFields = mapProcoreVendorToFieldMap(match.vendor);
    const updates = nonDestructiveMerge(existingFields, contactFields);

    if (Object.keys(updates).length === 0) {
      await storage.createAuditLog({
        action: 'hubspot_procore_sync_skipped',
        entityType: 'contact',
        entityId: hubspotId,
        source: 'automation',
        status: 'success',
        details: {
          reason: 'matched_no_updates_needed',
          vendorId: match.vendor.procoreId,
          vendorName: match.vendor.name,
          matchScore: match.score,
          matchReasons: match.reasons,
        } as any,
      });
      return {
        action: 'skipped',
        vendorId: match.vendor.procoreId,
        vendorName: match.vendor.name || undefined,
        matchScore: match.score,
        matchReasons: match.reasons,
        message: `Matched existing vendor "${match.vendor.name}" (score: ${match.score}) — no empty fields to fill`,
      };
    }

    await procoreApiCall('PATCH', `/rest/v1.0/companies/${config.companyId}/vendors/${match.vendor.procoreId}`, { vendor: updates });

    await storage.createAuditLog({
      action: 'hubspot_procore_vendor_updated',
      entityType: 'contact',
      entityId: hubspotId,
      source: 'automation',
      status: 'success',
      details: {
        vendorId: match.vendor.procoreId,
        vendorName: match.vendor.name,
        matchScore: match.score,
        matchReasons: match.reasons,
        fieldsUpdated: Object.keys(updates),
        contactName: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
        contactEmail: contact.email,
      } as any,
    });

    return {
      action: 'updated',
      vendorId: match.vendor.procoreId,
      vendorName: match.vendor.name || undefined,
      matchScore: match.score,
      matchReasons: match.reasons,
      fieldsUpdated: Object.keys(updates),
      message: `Updated vendor "${match.vendor.name}" with ${Object.keys(updates).length} field(s): ${Object.keys(updates).join(', ')}`,
    };
  }

  const contactFields = buildVendorFieldsFromContact(contact);
  if (!contactFields.name) {
    return { action: 'skipped', message: `HubSpot contact ${hubspotId} has no company or name — cannot create vendor` };
  }

  const result = await procoreApiCall('POST', `/rest/v1.0/companies/${config.companyId}/vendors`, { vendor: contactFields });

  await storage.upsertProcoreVendor({
    procoreId: String(result.id),
    name: result.name,
    emailAddress: result.email_address,
    businessPhone: result.business_phone,
    address: result.address,
    city: result.city,
    stateCode: result.state_code,
    zip: result.zip,
    website: result.website,
    isActive: result.is_active ?? true,
    companyId: config.companyId,
    properties: result,
    procoreUpdatedAt: result.updated_at ? new Date(result.updated_at) : null,
  });

  await storage.createAuditLog({
    action: 'hubspot_procore_vendor_created',
    entityType: 'contact',
    entityId: hubspotId,
    source: 'automation',
    status: 'success',
    details: {
      vendorId: String(result.id),
      vendorName: result.name,
      contactName: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      contactEmail: contact.email,
      fieldsSet: Object.keys(contactFields),
    } as any,
  });

  return {
    action: 'created',
    vendorId: String(result.id),
    vendorName: result.name,
    message: `Created new Procore vendor "${result.name}" from HubSpot contact "${contact.firstName} ${contact.lastName}"`,
  };
}

export async function processHubspotWebhookForProcore(
  eventType: string,
  objectType: string,
  objectId: string
): Promise<any> {
  const automationConfig = await storage.getAutomationConfig("hubspot_procore_auto_sync");
  const enabled = (automationConfig?.value as any)?.enabled;
  if (!enabled) return { skipped: true, reason: 'automation_disabled' };

  const isCreation = eventType?.includes('creation') || eventType?.includes('create');
  if (!isCreation) return { skipped: true, reason: 'not_a_creation_event' };

  if (objectType === 'company') {
    return syncHubspotCompanyToProcore(objectId);
  } else if (objectType === 'contact') {
    return syncHubspotContactToProcore(objectId);
  }

  return { skipped: true, reason: `unsupported_object_type: ${objectType}` };
}

export async function runBulkHubspotToProcoreSync(type: 'companies' | 'contacts' | 'both'): Promise<{
  companies?: { total: number; created: number; updated: number; skipped: number; errors: number; results: any[] };
  contacts?: { total: number; created: number; updated: number; skipped: number; errors: number; results: any[] };
  duration: string;
}> {
  const startTime = Date.now();
  const output: any = {};

  if (type === 'companies' || type === 'both') {
    const companiesResult = await storage.getHubspotCompanies({ limit: 10000, offset: 0 });
    const stats = { total: companiesResult.total, created: 0, updated: 0, skipped: 0, errors: 0, results: [] as any[] };

    for (const company of companiesResult.data) {
      try {
        const result = await syncHubspotCompanyToProcore(company.hubspotId);
        if (result.action === 'created') stats.created++;
        else if (result.action === 'updated') stats.updated++;
        else stats.skipped++;
        stats.results.push({ hubspotId: company.hubspotId, name: company.name, ...result });
      } catch (e: any) {
        stats.errors++;
        stats.results.push({ hubspotId: company.hubspotId, name: company.name, action: 'error', message: e.message });
      }
    }
    output.companies = stats;
  }

  if (type === 'contacts' || type === 'both') {
    const contactsResult = await storage.getHubspotContacts({ limit: 10000, offset: 0 });
    const stats = { total: contactsResult.total, created: 0, updated: 0, skipped: 0, errors: 0, results: [] as any[] };

    for (const contact of contactsResult.data) {
      try {
        const result = await syncHubspotContactToProcore(contact.hubspotId);
        if (result.action === 'created') stats.created++;
        else if (result.action === 'updated') stats.updated++;
        else stats.skipped++;
        stats.results.push({ hubspotId: contact.hubspotId, name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(), ...result });
      } catch (e: any) {
        stats.errors++;
        stats.results.push({ hubspotId: contact.hubspotId, name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(), action: 'error', message: e.message });
      }
    }
    output.contacts = stats;
  }

  output.duration = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  return output;
}

export async function testMatchingForCompany(hubspotId: string): Promise<any> {
  const company = await storage.getHubspotCompanyByHubspotId(hubspotId);
  if (!company) return { error: 'Company not found' };

  const criteria = {
    companyName: company.name,
    domain: extractDomain(company.domain),
    email: null as string | null,
  };

  const match = await findMatchingVendor(criteria);
  return {
    hubspotCompany: { id: company.hubspotId, name: company.name, domain: company.domain },
    matchCriteria: criteria,
    match: match ? {
      vendorId: match.vendor.procoreId,
      vendorName: match.vendor.name,
      score: match.score,
      reasons: match.reasons,
    } : null,
    wouldCreate: !match,
  };
}

export async function testMatchingForContact(hubspotId: string): Promise<any> {
  const contact = await storage.getHubspotContactByHubspotId(hubspotId);
  if (!contact) return { error: 'Contact not found' };

  const criteria = {
    email: contact.email,
    domain: extractDomain(contact.email),
    companyName: contact.company || contact.associatedCompanyName,
    firstName: contact.firstName,
    lastName: contact.lastName,
  };

  const match = await findMatchingVendor(criteria);
  return {
    hubspotContact: {
      id: contact.hubspotId,
      name: `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      email: contact.email,
      company: contact.company,
    },
    matchCriteria: criteria,
    match: match ? {
      vendorId: match.vendor.procoreId,
      vendorName: match.vendor.name,
      score: match.score,
      reasons: match.reasons,
    } : null,
    wouldCreate: !match,
  };
}
