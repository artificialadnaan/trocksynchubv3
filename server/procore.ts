/**
 * Procore Integration Module
 * ==========================
 * 
 * This module handles all interactions with the Procore Construction Management API.
 * It manages OAuth authentication, project data synchronization, and BidBoard operations.
 * 
 * Key Features:
 * - OAuth 2.0 authentication with automatic token refresh
 * - Full sync of projects, vendors, users, and bid packages
 * - BidBoard (estimating) data synchronization
 * - Role assignment tracking and notifications
 * - Change detection for stage transitions
 * 
 * Procore Project Lifecycle:
 * 1. BidBoard Phase: Projects in estimating (pre-award)
 *    - Synced via syncProcoreBidBoard()
 *    - Stage changes trigger HubSpot updates
 * 
 * 2. Portfolio Phase: Active projects (post-award)
 *    - Transitioned via Playwright automation
 *    - Documents, budgets, change orders tracked
 * 
 * API Endpoints Used:
 * - /rest/v1.0/projects: Project CRUD
 * - /rest/v1.0/companies/{id}/vendors: Vendor directory
 * - /rest/v1.0/companies/{id}/users: User management
 * - /rest/v1.1/projects/{id}/bid_packages: BidBoard data
 * 
 * Key Functions:
 * - getProcoreClient(): Returns authenticated API client
 * - runFullProcoreSync(): Syncs all Procore data to local database
 * - syncProcoreBidBoard(): Syncs BidBoard/estimating projects
 * - syncProcoreRoleAssignments(): Tracks project role changes
 * - getCompanyId(): Gets configured Procore company ID
 * 
 * @module procore
 */

import { storage } from './storage';

/**
 * Gets Procore configuration from database.
 * Falls back to default company ID if not configured.
 */
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

function projectDataFromApi(project: any): any {
  if (project.address && typeof project.address === 'object' && project.address.street !== undefined) {
    return {
      procoreId: String(project.id),
      name: project.name || null,
      displayName: project.name || null,
      projectNumber: null,
      address: project.address?.street || null,
      city: project.address?.city || null,
      stateCode: project.address?.state_code || null,
      zip: project.address?.zip || null,
      countryCode: project.address?.country_code || null,
      phone: null,
      active: project.status_name !== 'Inactive' ? true : false,
      stage: null,
      projectStageName: project.stage_name || null,
      startDate: null,
      completionDate: null,
      projectedFinishDate: null,
      estimatedValue: null,
      totalValue: null,
      storeNumber: null,
      deliveryMethod: null,
      workScope: null,
      companyId: null,
      companyName: null,
      properties: project,
      procoreUpdatedAt: null,
    };
  }
  return {
    procoreId: String(project.id),
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
}

// Export helper functions for external use (e.g., procore-documents.ts)
export async function getCompanyId(): Promise<string> {
  const config = await getProcoreConfig();
  return config.companyId;
}

export async function getProcoreClient(): Promise<{
  get: (endpoint: string, options?: { params?: Record<string, any>; responseType?: string }) => Promise<{ data: any; headers?: any }>;
}> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  return {
    async get(endpoint: string, options?: { params?: Record<string, any>; responseType?: string }) {
      // Handle both full URLs and relative endpoints
      const isFullUrl = endpoint.startsWith('http://') || endpoint.startsWith('https://');
      const url = isFullUrl ? new URL(endpoint) : new URL(`${baseUrl}${endpoint}`);
      
      // Add query params
      if (options?.params) {
        for (const [key, value] of Object.entries(options.params)) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
          }
        }
      }

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
          'Procore-Company-Id': companyId,
        },
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Procore API error ${response.status}: ${errText}`);
      }

      // Handle different response types
      if (options?.responseType === 'arraybuffer') {
        const buffer = await response.arrayBuffer();
        return { data: Buffer.from(buffer), headers: Object.fromEntries(response.headers.entries()) };
      }

      const data = await response.json();
      return { data, headers: Object.fromEntries(response.headers.entries()) };
    },
  };
}

export async function syncProcoreProjects(): Promise<{ synced: number; created: number; updated: number; changes: number; stageChanges: Array<{ procoreId: string; projectName: string; oldStage: string; newStage: string }> }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const companyProjects = await fetchProcoreJson(
    `/rest/v1.0/companies/${companyId}/projects?per_page=500`,
    companyId
  ) as any[];
  console.log(`[procore] Company-level projects: ${companyProjects.length}`);

  const detailedProjects = await fetchProcorePages<any>(
    `/rest/v1.0/projects?company_id=${companyId}`,
    companyId
  );
  console.log(`[procore] Detailed projects (user-level): ${detailedProjects.length}`);

  const detailedMap = new Map<string, any>();
  for (const p of detailedProjects) {
    detailedMap.set(String(p.id), p);
  }

  let created = 0, updated = 0, changes = 0;
  const stageChanges: Array<{ procoreId: string; projectName: string; oldStage: string; newStage: string }> = [];

  for (const project of companyProjects) {
    const procoreId = String(project.id);
    const existing = await storage.getProcoreProjectByProcoreId(procoreId);
    const detailed = detailedMap.get(procoreId);
    const source = detailed || project;
    const data = projectDataFromApi(source);

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
          fullSnapshot: source,
          syncedAt: new Date(),
        });
        changes++;
        if (change.field === 'stage' || change.field === 'projectStageName') {
          stageChanges.push({
            procoreId,
            projectName: data.name || 'Unknown',
            oldStage: change.oldValue,
            newStage: change.newValue,
          });
        }
      }
      if (changedFields.length > 0) updated++;
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'project',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: source,
        syncedAt: new Date(),
      });
      created++;
      changes++;
    }

    await storage.upsertProcoreProject(data);
  }

  return { synced: companyProjects.length, created, updated, changes, stageChanges };
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

/**
 * Fetch and sync a single Procore user by ID.
 * Called by webhook handlers for real-time user updates.
 * Uses upsert to handle both create and update cases.
 */
export async function syncSingleProcoreUser(userId: string): Promise<{ success: boolean; action: 'created' | 'updated' | 'deleted'; error?: string }> {
  try {
    const config = await getProcoreConfig();
    const companyId = config.companyId;
    const client = await getProcoreClient();
    
    let user;
    try {
      const response = await client.get(`/rest/v1.0/companies/${companyId}/users/${userId}`);
      user = response.data;
    } catch (fetchErr: any) {
      if (fetchErr.response?.status === 404) {
        await storage.deleteProcoreUser(userId);
        console.log(`[procore] User ${userId} deleted (not found in Procore)`);
        return { success: true, action: 'deleted' };
      }
      throw fetchErr;
    }
    
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
    
    const action = existing ? 'updated' : 'created';
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
      }
    } else {
      await storage.createProcoreChangeHistory({
        entityType: 'user',
        entityProcoreId: procoreId,
        changeType: 'created',
        fullSnapshot: user,
        syncedAt: new Date(),
      });
    }
    
    await storage.upsertProcoreUser(data);
    console.log(`[procore] User ${procoreId} ${action} via webhook`);
    return { success: true, action };
  } catch (err: any) {
    console.error(`[procore] Failed to sync user ${userId}:`, err.message);
    return { success: false, action: 'updated', error: err.message };
  }
}

async function fetchProcoreJson(endpoint: string, companyId: string): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Procore-Company-Id': companyId,
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Procore token expired or invalid.");
    const errText = await response.text();
    throw new Error(`Procore API error ${response.status}: ${errText}`);
  }
  return response.json();
}

export async function fetchProcoreProjectStages(): Promise<any[]> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  try {
    return await fetchProcoreJson(`/rest/v1.0/companies/${companyId}/project_stages`, companyId);
  } catch {
    const projects = await fetchProcoreJson(`/rest/v1.0/companies/${companyId}/projects?per_page=300`, companyId);
    const stageMap = new Map<number, string>();
    for (const p of projects) {
      if (p.project_stage?.id && p.project_stage?.name) {
        stageMap.set(p.project_stage.id, p.project_stage.name);
      }
    }
    return Array.from(stageMap.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

export async function fetchProcoreProjectDetail(projectId: string): Promise<any> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  return fetchProcoreJson(`/rest/v1.0/projects/${projectId}?company_id=${companyId}`, companyId);
}

export async function getProjectTeamMembers(projectId: string): Promise<Array<{
  name: string;
  email: string;
  role: string;
}>> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  try {
    const assignments = await fetchProcoreJson(
      `/rest/v1.0/project_roles?project_id=${projectId}&company_id=${companyId}`,
      companyId
    ) as any[];

    if (!Array.isArray(assignments)) return [];

    const teamMembers: Array<{ name: string; email: string; role: string }> = [];

    for (const assignment of assignments) {
      const roleName = assignment.role || 'Unknown Role';
      const assigneeId = assignment.user_id ? String(assignment.user_id) : (assignment.contact_id ? String(assignment.contact_id) : null);
      if (!assigneeId) continue;

      const nameParts = (assignment.name || '').split(' (');
      const assigneeName = nameParts[0] || '';
      let assigneeEmail = assignment.email_address || assignment.email || '';

      if (!assigneeEmail) {
        const user = await storage.getProcoreUserByProcoreId(assigneeId);
        assigneeEmail = user?.emailAddress || '';
      }

      teamMembers.push({
        name: assigneeName,
        email: assigneeEmail,
        role: roleName,
      });
    }

    return teamMembers;
  } catch (err: any) {
    console.error(`[procore] Error fetching team members for project ${projectId}:`, err.message);
    return [];
  }
}

export async function deactivateProject(projectId: string): Promise<boolean> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const response = await fetch(
    `${baseUrl}/rest/v1.0/projects/${projectId}?company_id=${companyId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify({ project: { active: false } }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to deactivate project: ${response.status} ${errText}`);
  }

  console.log(`[procore] Project ${projectId} deactivated successfully`);
  return true;
}

export async function updateProcoreProject(
  projectId: string,
  fields: Record<string, any>
): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const body: any = { project: fields };

  const response = await fetch(
    `${baseUrl}/rest/v1.0/projects/${projectId}?company_id=${companyId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to update project: ${response.status} ${errText}`);
  }

  return response.json();
}

export async function updateProcoreBid(
  projectId: string,
  bidPackageId: string,
  bidId: string,
  fields: Record<string, any>
): Promise<any> {
  const accessToken = await getAccessToken();
  const config = await getProcoreConfig();
  const baseUrl = getBaseUrl(config.environment);
  const companyId = config.companyId;

  const response = await fetch(
    `${baseUrl}/rest/v1.0/projects/${projectId}/bid_packages/${bidPackageId}/bids/${bidId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Procore-Company-Id': companyId,
      },
      body: JSON.stringify({ bid: fields }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to update bid: ${response.status} ${errText}`);
  }

  return response.json();
}

export async function fetchProcoreBidDetail(
  projectId: string,
  bidPackageId: string,
  bidId: string
): Promise<any> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;
  return fetchProcoreJson(
    `/rest/v1.0/projects/${projectId}/bid_packages/${bidPackageId}/bids/${bidId}`,
    companyId
  );
}

export async function proxyProcoreAttachment(url: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
  const filename = filenameMatch?.[1] || 'attachment';
  return { buffer, contentType, filename };
}

export async function syncProcoreBidBoard(): Promise<{ bidPackages: number; bids: number; bidForms: number }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  const bidPackagesResp = await fetchProcoreJson(
    `/rest/v1.0/companies/${companyId}/bid_packages?per_page=100`,
    companyId
  );
  const allPackages = bidPackagesResp.bidPackages || bidPackagesResp || [];
  console.log(`Bid Board: fetched ${allPackages.length} bid packages`);

  let totalBids = 0;
  let totalForms = 0;

  const projectBidMap: Record<string, string[]> = {};
  for (const pkg of allPackages) {
    const projId = String(pkg.project_id);
    if (!projectBidMap[projId]) projectBidMap[projId] = [];
    projectBidMap[projId].push(String(pkg.id));
  }

  for (const pkg of allPackages) {
    const procoreId = String(pkg.id);
    await storage.upsertProcoreBidPackage({
      procoreId,
      projectId: pkg.project_id ? String(pkg.project_id) : null,
      projectName: pkg.project_name || null,
      projectLocation: pkg.project_location || null,
      title: pkg.title || null,
      number: pkg.number ?? null,
      bidDueDate: pkg.bid_due_date || null,
      formattedBidDueDate: pkg.formatted_bid_due_date || null,
      accountingMethod: pkg.accounting_method || null,
      open: pkg.open ?? null,
      hidden: pkg.hidden ?? null,
      sealed: pkg.sealed ?? null,
      hasBidDocs: pkg.has_bid_docs ?? null,
      acceptPostDueSubmissions: pkg.accept_post_due_submissions ?? null,
      allowBidderSum: pkg.allow_bidder_sum ?? null,
      enablePrebidWalkthrough: pkg.enable_prebid_walkthrough ?? null,
      enablePrebidRfiDeadline: pkg.enable_prebid_rfi_deadline ?? null,
      preBidRfiDeadlineDate: pkg.pre_bid_rfi_deadline_date || null,
      bidInvitesSentCount: pkg.bid_invites_sent_count ?? null,
      bidsReceivedCount: pkg.bids_received_count ?? null,
      bidEmailMessage: pkg.formatted_bid_email_message || null,
      bidWebMessage: pkg.formatted_bid_web_message || null,
      companyId: companyId,
      properties: pkg,
    });

    await storage.createProcoreChangeHistory({
      entityType: 'bid_package',
      entityProcoreId: procoreId,
      changeType: 'synced',
      fullSnapshot: pkg,
      syncedAt: new Date(),
    });
  }

  for (const [projId, pkgIds] of Object.entries(projectBidMap)) {
    for (const pkgId of pkgIds) {
      try {
        const bids = await fetchProcoreJson(
          `/rest/v1.0/projects/${projId}/bid_packages/${pkgId}/bids?per_page=100`,
          companyId
        );
        if (Array.isArray(bids)) {
          for (const bid of bids) {
            await storage.upsertProcoreBid({
              procoreId: String(bid.id),
              bidPackageId: bid.bid_package_id ? String(bid.bid_package_id) : null,
              bidPackageTitle: bid.bid_package_title || null,
              bidFormId: bid.bid_form_id ? String(bid.bid_form_id) : null,
              bidFormTitle: bid.bid_form_title || null,
              projectId: projId,
              projectName: bid.project?.name || null,
              projectAddress: bid.project?.address || null,
              vendorId: bid.vendor?.id ? String(bid.vendor.id) : null,
              vendorName: bid.vendor?.name || null,
              vendorTrades: bid.vendor?.trades || null,
              bidStatus: bid.bid_status || null,
              awarded: bid.awarded ?? null,
              submitted: bid.submitted ?? null,
              isBidderCommitted: bid.is_bidder_committed ?? null,
              lumpSumEnabled: bid.lump_sum_enabled ?? null,
              lumpSumAmount: bid.lump_sum_amount != null ? String(bid.lump_sum_amount) : null,
              bidderComments: bid.bidder_comments || null,
              dueDate: bid.due_date || null,
              invitationLastSentAt: bid.invitation_last_sent_at || null,
              bidRequesterName: bid.bid_requester ? `${bid.bid_requester.first_name || ''} ${bid.bid_requester.last_name || ''}`.trim() : null,
              bidRequesterEmail: bid.bid_requester?.email_address || null,
              bidRequesterCompany: bid.bid_requester?.company || null,
              requireNda: bid.require_nda ?? null,
              ndaStatus: bid.nda_status || null,
              showBidInEstimating: bid.show_bid_in_estimating ?? null,
              companyId: companyId,
              properties: bid,
              procoreCreatedAt: bid.created_at || null,
              procoreUpdatedAt: bid.updated_at || null,
            });
            totalBids++;
          }
        }
      } catch (e: any) {
        console.error(`Error fetching bids for project ${projId}/package ${pkgId}: ${e.message}`);
      }

      try {
        const forms = await fetchProcoreJson(
          `/rest/v1.0/projects/${projId}/bid_packages/${pkgId}/bid_forms?per_page=100`,
          companyId
        );
        if (Array.isArray(forms)) {
          for (const form of forms) {
            await storage.upsertProcoreBidForm({
              procoreId: String(form.id),
              bidPackageId: pkgId,
              projectId: projId,
              title: form.title || null,
              proposalId: form.proposal_id ? String(form.proposal_id) : null,
              proposalName: form.proposal_name || null,
              companyId: companyId,
              properties: form,
            });
            totalForms++;
          }
        }
      } catch (e: any) {
        console.error(`Error fetching bid forms for project ${projId}/package ${pkgId}: ${e.message}`);
      }
    }
  }

  console.log(`Bid Board sync complete: ${allPackages.length} packages, ${totalBids} bids, ${totalForms} forms`);
  return { bidPackages: allPackages.length, bids: totalBids, bidForms: totalForms };
}

// Mutex to prevent concurrent role assignment syncs
let roleAssignmentSyncInProgress = false;
const roleAssignmentSyncQueue: string[] = [];

export async function syncProcoreRoleAssignments(projectIds?: string[]): Promise<{ synced: number; newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }> }> {
  // Prevent concurrent syncs to avoid duplicate emails
  if (roleAssignmentSyncInProgress) {
    console.log('[procore] Role assignment sync already in progress, skipping to prevent duplicates');
    return { synced: 0, newAssignments: [] };
  }
  
  roleAssignmentSyncInProgress = true;
  
  try {
    return await performRoleAssignmentSync(projectIds);
  } finally {
    roleAssignmentSyncInProgress = false;
  }
}

async function performRoleAssignmentSync(projectIds?: string[]): Promise<{ synced: number; newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }> }> {
  const config = await getProcoreConfig();
  const companyId = config.companyId;

  let projectsToSync: Array<{ procoreId: string; name: string }> = [];

  if (projectIds && projectIds.length > 0) {
    for (const pid of projectIds) {
      const p = await storage.getProcoreProjectByProcoreId(pid);
      if (p) projectsToSync.push({ procoreId: pid, name: p.name || '' });
    }
  } else {
    const { data: allProjects } = await storage.getProcoreProjects({ limit: 10000 });
    projectsToSync = allProjects
      .filter(p => p.active !== false)
      .map(p => ({ procoreId: p.procoreId, name: p.name || '' }));
  }

  console.log(`[procore] Syncing role assignments for ${projectsToSync.length} active projects...`);
  let synced = 0;
  const newAssignments: Array<{ procoreProjectId: string; projectName: string; roleName: string; assigneeId: string; assigneeName: string; assigneeEmail: string; assigneeCompany: string }> = [];

  for (const project of projectsToSync) {
    try {
      const assignments = await fetchProcoreJson(
        `/rest/v1.0/project_roles?project_id=${project.procoreId}&company_id=${companyId}`,
        companyId
      ) as any[];

      if (!Array.isArray(assignments)) continue;

      const existingAssignments = await storage.getProcoreRoleAssignmentsByProject(project.procoreId);
      const existingKeys = new Set(existingAssignments.map(a => `${a.roleName}||${a.assigneeId}`));

      for (const assignment of assignments) {
        const roleName = assignment.role || 'Unknown Role';
        const assigneeId = assignment.user_id ? String(assignment.user_id) : (assignment.contact_id ? String(assignment.contact_id) : null);
        if (!assigneeId) continue;
        const nameParts = (assignment.name || '').split(' (');
        const assigneeName = nameParts[0] || '';
        const assigneeCompany = nameParts[1] ? nameParts[1].replace(')', '') : '';
        let assigneeEmail = assignment.email_address || assignment.email || '';
        if (!assigneeEmail) {
          const user = await storage.getProcoreUserByProcoreId(assigneeId);
          assigneeEmail = user?.emailAddress || '';
        }

        const isNew = !existingKeys.has(`${roleName}||${assigneeId}`);

        await storage.upsertProcoreRoleAssignment({
          procoreProjectId: project.procoreId,
          projectName: project.name,
          roleId: assignment.id ? String(assignment.id) : null,
          roleName,
          assigneeId,
          assigneeName,
          assigneeEmail,
          assigneeCompany,
          properties: assignment,
          lastSyncedAt: new Date(),
        });

        if (isNew) {
          newAssignments.push({
            procoreProjectId: project.procoreId,
            projectName: project.name,
            roleName,
            assigneeId,
            assigneeName,
            assigneeEmail,
            assigneeCompany,
          });
        }

        synced++;
      }
    } catch (err: any) {
      if (err.message?.includes('403') || err.message?.includes('404')) {
        continue;
      }
      console.error(`[procore] Error fetching role assignments for project ${project.procoreId}:`, err.message);
    }
  }

  console.log(`[procore] Synced ${synced} role assignments, ${newAssignments.length} new assignments`);
  return { synced, newAssignments };
}

export async function runFullProcoreSync(): Promise<{
  projects: { synced: number; created: number; updated: number; changes: number };
  vendors: { synced: number; created: number; updated: number; changes: number };
  users: { synced: number; created: number; updated: number; changes: number };
  bidBoard: { bidPackages: number; bids: number; bidForms: number };
  roleAssignments: { synced: number; newAssignments: number };
  purgedHistory: number;
  duration: number;
}> {
  const start = Date.now();

  const projects = await syncProcoreProjects();
  const [vendors, users] = await Promise.all([
    syncProcoreVendors(),
    syncProcoreUsers(),
  ]);
  const bidBoard = await syncProcoreBidBoard();

  let roleAssignmentResult = { synced: 0, newAssignments: [] as any[] };
  try {
    roleAssignmentResult = await syncProcoreRoleAssignments();
  } catch (err: any) {
    console.error(`[procore] Role assignment sync failed:`, err.message);
  }

  if (roleAssignmentResult.newAssignments.length > 0) {
    try {
      const { sendRoleAssignmentEmails } = await import('./email-notifications');
      await sendRoleAssignmentEmails(roleAssignmentResult.newAssignments);
    } catch (err: any) {
      console.error(`[procore] Email notifications failed:`, err.message);
    }
  }

  if (projects.stageChanges && projects.stageChanges.length > 0) {
    console.log(`[procore] Detected ${projects.stageChanges.length} stage change(s) during polling, processing...`);
    
    // Check if stage sync automation is enabled (disabled by default)
    const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
    const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;
    
    if (!stageSyncEnabled) {
      console.log(`[procore] Stage sync disabled - skipping HubSpot updates for ${projects.stageChanges.length} stage change(s)`);
    } else {
    try {
      const { sendStageChangeEmail } = await import('./email-notifications');
      const { mapProcoreStageToHubspot, resolveHubspotStageId } = await import('./procore-hubspot-sync');
      const { updateHubSpotDealStage } = await import('./hubspot');

      for (const sc of projects.stageChanges) {
        const mapping = await storage.getSyncMappingByProcoreProjectId(sc.procoreId);
        if (mapping?.hubspotDealId) {
          // Map Procore stage to HubSpot stage label, then resolve to actual stage ID
          const hubspotStageLabel = mapProcoreStageToHubspot(sc.newStage);
          const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);
          
          if (!resolvedStage) {
            console.log(`[procore] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
            continue;
          }
          
          const hubspotStageId = resolvedStage.stageId;
          const hubspotStageName = resolvedStage.stageName;

          const updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
          console.log(`[procore] Polling stage change: HubSpot deal ${mapping.hubspotDealId} updated to ${hubspotStageName}: ${updateResult.message}`);

          const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);
          await sendStageChangeEmail({
            hubspotDealId: mapping.hubspotDealId,
            dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
            procoreProjectId: sc.procoreId,
            procoreProjectName: sc.projectName,
            oldStage: sc.oldStage,
            newStage: sc.newStage,
            hubspotStageName,
          });

          await storage.createAuditLog({
            action: 'polling_stage_change_processed',
            entityType: 'project_stage',
            entityId: sc.procoreId,
            source: 'polling',
            status: 'success',
            details: { procoreId: sc.procoreId, projectName: sc.projectName, oldStage: sc.oldStage, newStage: sc.newStage, hubspotDealId: mapping.hubspotDealId, hubspotStageId, hubspotStageName },
          });
        } else {
          console.log(`[procore] Stage change for ${sc.projectName} (${sc.procoreId}) has no HubSpot mapping, skipping email`);
        }
      }
    } catch (err: any) {
      console.error(`[procore] Stage change email processing failed:`, err.message);
    }
    } // End stageSyncEnabled check
  }

  const purgedHistory = await storage.purgeProcoreChangeHistory(14);
  const duration = Date.now() - start;

  return {
    projects,
    vendors,
    users,
    bidBoard,
    roleAssignments: { synced: roleAssignmentResult.synced, newAssignments: roleAssignmentResult.newAssignments.length },
    purgedHistory,
    duration,
  };
}
