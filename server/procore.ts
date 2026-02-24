import { storage } from './storage';

async function getProcoreConfig(): Promise<{ companyId: string; environment: string; clientId: string; clientSecret: string }> {
  const config = await storage.getAutomationConfig("procore_config");
  if (!config?.value) {
    throw new Error("Procore not configured. Please save your Procore credentials in Settings.");
  }
  const val = config.value as any;
  return {
    companyId: val.companyId || "598134325683880",
    environment: val.environment || "production",
    clientId: val.clientId || "",
    clientSecret: val.clientSecret || "",
  };
}

function getBaseUrl(environment: string): string {
  return environment === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";
}

function getLoginUrl(environment: string): string {
  return environment === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";
}

async function getAccessToken(): Promise<string> {
  const token = await storage.getOAuthToken("procore");
  if (!token?.accessToken) {
    throw new Error("No Procore OAuth token found. Please authenticate via OAuth first.");
  }

  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now() + 60000) {
    if (token.refreshToken) {
      return await refreshAccessToken(token.refreshToken);
    }
    throw new Error("Procore token expired and no refresh token available. Please re-authenticate.");
  }

  return token.accessToken;
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const config = await getProcoreConfig();
  const loginUrl = getLoginUrl(config.environment);

  const response = await fetch(`${loginUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to refresh Procore token: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const expiresAt = new Date(Date.now() + (data.expires_in || 7200) * 1000);

  await storage.upsertOAuthToken({
    provider: "procore",
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    tokenType: "Bearer",
    expiresAt,
  });

  console.log("Procore token refreshed successfully");
  return data.access_token;
}

async function fetchProcorePages<T>(endpoint: string, companyId: string): Promise<T[]> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const allResults: T[] = [];
  let page = 1;

  while (true) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${baseUrl}${endpoint}${separator}per_page=100&page=${page}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Procore token expired or invalid. Please re-authenticate.");
      }
      const errText = await response.text();
      throw new Error(`Procore API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) break;

    allResults.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return allResults;
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

export async function syncProcoreProjects(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const allProjects = await fetchProcorePages<any>(
    `/rest/v1.0/projects?company_id=${companyId}`,
    companyId
  );

  let created = 0, updated = 0, changes = 0;

  for (const project of allProjects) {
    const procoreId = String(project.id);
    const existing = await storage.getProcoreProjectByProcoreId(procoreId);

    const data = {
      procoreId,
      name: project.name || null,
      displayName: project.display_name || null,
      projectNumber: project.project_number || null,
      address: project.address || null,
      city: project.city || null,
      stateCode: project.state_code || null,
      zip: project.zip || null,
      countryCode: project.country_code || null,
      phone: project.phone || null,
      active: project.active ?? null,
      stage: project.stage || null,
      projectStageName: project.project_stage?.name || null,
      startDate: project.start_date || null,
      completionDate: project.completion_date || null,
      projectedFinishDate: project.projected_finish_date || null,
      estimatedValue: project.estimated_value ? String(project.estimated_value) : null,
      totalValue: project.total_value ? String(project.total_value) : null,
      storeNumber: project.store_number || null,
      deliveryMethod: project.delivery_method || null,
      workScope: project.work_scope || null,
      companyId: project.company?.id ? String(project.company.id) : null,
      companyName: project.company?.name || null,
      properties: project,
      procoreUpdatedAt: project.updated_at ? new Date(project.updated_at) : null,
    };

    const trackFields = ['name', 'displayName', 'projectNumber', 'address', 'city', 'stateCode', 'zip', 'phone', 'active', 'stage', 'projectStageName', 'startDate', 'completionDate', 'projectedFinishDate', 'estimatedValue', 'totalValue', 'deliveryMethod', 'companyName'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'project',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: project,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'project',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: project,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreProject(data);
  }

  return { synced: allProjects.length, created, updated, changes };
}

export async function syncProcoreVendors(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const allVendors = await fetchProcorePages<any>(
    `/rest/v1.0/vendors?company_id=${companyId}`,
    companyId
  );

  let created = 0, updated = 0, changes = 0;

  for (const vendor of allVendors) {
    const procoreId = String(vendor.id);
    const existing = await storage.getProcoreVendorByProcoreId(procoreId);

    const data = {
      procoreId,
      name: vendor.name || null,
      abbreviatedName: vendor.abbreviated_name || null,
      address: vendor.address || null,
      city: vendor.city || null,
      stateCode: vendor.state_code || null,
      zip: vendor.zip || null,
      countryCode: vendor.country_code || null,
      emailAddress: vendor.email_address || null,
      businessPhone: vendor.business_phone || null,
      mobilePhone: vendor.mobile_phone || null,
      faxNumber: vendor.fax_number || null,
      website: vendor.website || null,
      legalName: vendor.legal_name || null,
      licenseNumber: vendor.license_number || null,
      isActive: vendor.is_active ?? null,
      tradeName: vendor.trade_name || null,
      laborUnion: vendor.labor_union || null,
      contactCount: vendor.contact_count ?? null,
      childrenCount: vendor.children_count ?? null,
      notes: vendor.notes || null,
      companyId: companyId,
      properties: vendor,
      procoreUpdatedAt: vendor.updated_at ? new Date(vendor.updated_at) : null,
    };

    const trackFields = ['name', 'abbreviatedName', 'address', 'city', 'stateCode', 'zip', 'emailAddress', 'businessPhone', 'mobilePhone', 'website', 'legalName', 'licenseNumber', 'isActive', 'tradeName', 'laborUnion'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'vendor',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: vendor,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'vendor',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: vendor,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreVendor(data);
  }

  return { synced: allVendors.length, created, updated, changes };
}

export async function syncProcoreUsers(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const allUsers = await fetchProcorePages<any>(
    `/rest/v1.0/companies/${companyId}/users`,
    companyId
  );

  let created = 0, updated = 0, changes = 0;

  for (const user of allUsers) {
    const procoreId = String(user.id);
    const existing = await storage.getProcoreUserByProcoreId(procoreId);

    const data = {
      procoreId,
      name: user.name || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      emailAddress: user.email_address || null,
      jobTitle: user.job_title || null,
      businessPhone: user.business_phone || null,
      mobilePhone: user.mobile_phone || null,
      address: user.address || null,
      city: user.city || null,
      stateCode: user.state_code || null,
      zip: user.zip || null,
      countryCode: user.country_code || null,
      isActive: user.is_active ?? null,
      isEmployee: user.is_employee ?? null,
      lastLoginAt: user.last_login_at || null,
      employeeId: user.employee_id ? String(user.employee_id) : null,
      vendorId: user.vendor?.id ? String(user.vendor.id) : null,
      vendorName: user.vendor?.name || null,
      companyId: companyId,
      properties: user,
      procoreUpdatedAt: user.updated_at ? new Date(user.updated_at) : null,
    };

    const trackFields = ['name', 'firstName', 'lastName', 'emailAddress', 'jobTitle', 'businessPhone', 'mobilePhone', 'address', 'city', 'stateCode', 'zip', 'isActive', 'isEmployee', 'vendorName'];

    if (existing) {
      const changedFields = detectChanges(existing, data, trackFields);
      for (const change of changedFields) {
        await storage.createProcoreChangeHistory({
          entityType: 'user',
          entityProcoreId: procoreId,
          changeType: 'field_update',
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          fullSnapshot: user,
          syncedAt: new Date(),
        });
        changes++;
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'user',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: user,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreUser(data);
  }

  return { synced: allUsers.length, created, updated, changes };
}

export async function runFullProcoreSync(): Promise<{
  projects: { synced: number; created: number; updated: number; changes: number };
  vendors: { synced: number; created: number; updated: number; changes: number };
  users: { synced: number; created: number; updated: number; changes: number };
  purgedHistory: number;
  duration: number;
}> {
  const start = Date.now();

  const projects = await syncProcoreProjects();
  const [vendors, users] = await Promise.all([
    syncProcoreVendors(),
    syncProcoreUsers(),
  ]);

  const purgedHistory = await storage.purgeProcoreChangeHistory(14);
  const duration = Date.now() - start;

  return {
    projects,
    vendors,
    users,
    purgedHistory,
    duration,
  };
}
