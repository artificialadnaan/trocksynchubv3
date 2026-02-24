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

export async function syncProcoreProjects(): Promise<{ synced: number; created: number; updated: number; changes: number }> {
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

  return { synced: companyProjects.length, created, updated, changes };
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

export async function runFullProcoreSync(): Promise<{
  projects: { synced: number; created: number; updated: number; changes: number };
  vendors: { synced: number; created: number; updated: number; changes: number };
  users: { synced: number; created: number; updated: number; changes: number };
  bidBoard: { bidPackages: number; bids: number; bidForms: number };
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

  const purgedHistory = await storage.purgeProcoreChangeHistory(14);
  const duration = Date.now() - start;

  return {
    projects,
    vendors,
    users,
    bidBoard,
    purgedHistory,
    duration,
  };
}
