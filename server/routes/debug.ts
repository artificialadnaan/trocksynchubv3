import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";

export function registerDebugRoutes(app: Express, requireAuth: RequestHandler) {
  // Debug: Procore extraction field mapping (requires auth, disabled in production)
  app.get("/api/debug/procore-extraction/:projectId", requireAuth, asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    const projectId = String(req.params.projectId ?? "");
    if (!projectId) return res.status(400).json({ message: "projectId required" });
    const { extractProjectDocuments } = await import("../procore-documents");
    const { getProcoreClient, getCompanyId } = await import("../procore");
    const client = await getProcoreClient();
    const companyId = await getCompanyId();
    const [extracted, rawFoldersResponse, rawPrimeContractsRes, rawCommitmentsRes] = await Promise.all([
      extractProjectDocuments(projectId),
      client.get("/rest/v1.0/folders", { params: { project_id: projectId } }).then((r: any) => r.data).catch((e: any) => ({ error: e.message })),
      client.get("/rest/v1.0/prime_contracts", { params: { project_id: projectId, company_id: companyId, per_page: 100 } }).then((r: any) => r.data).catch((e: any) => ({ error: e.message })),
      client.get("/rest/v1.0/work_order_contracts", { params: { project_id: projectId, company_id: companyId, per_page: 100 } }).then((r: any) => r.data).catch((e: any) => ({ error: e.message })),
    ]);

    // Sample recursive fetch: first folder with has_children_files to verify files are returned
    let rawRecursiveFolderFetch: any = null;
    const rootList = Array.isArray(rawFoldersResponse) ? rawFoldersResponse : rawFoldersResponse?.folders ?? [];
    const firstWithFiles = rootList.find((f: any) => f?.has_children_files === true);
    if (firstWithFiles?.id) {
      try {
        const rec = await client.get(`/rest/v1.0/folders/${firstWithFiles.id}`, { params: { project_id: projectId } });
        rawRecursiveFolderFetch = { folderId: firstWithFiles.id, folderName: firstWithFiles.name, response: rec.data };
      } catch (e: any) {
        rawRecursiveFolderFetch = { folderId: firstWithFiles.id, error: e.message };
      }
    }
    function fileCount(folder: any): number {
      const files = folder.files?.length ?? 0;
      const sub = folder.subfolders?.reduce((s: number, f: any) => s + fileCount(f), 0) ?? 0;
      return files + sub;
    }
    const folderSummary = extracted.folders.map((f: any) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      fileCount: fileCount(f),
      files: (f.files ?? []).slice(0, 5).map((file: any) => ({ name: file.name, downloadUrl: file.downloadUrl, size: file.size, mimeType: file.mimeType })),
    }));
    const totalFolderFiles = extracted.folders.reduce((sum: number, f: any) => sum + fileCount(f), 0);
    res.json({
      projectId: extracted.projectId,
      projectName: extracted.projectName,
      extractedAt: extracted.extractedAt,
      counts: {
        folders: extracted.folders.length,
        totalFolderFiles,
        drawings: extracted.drawings.length,
        submittals: extracted.submittals.length,
        rfis: extracted.rfis.length,
        bidPackages: extracted.bidPackages.length,
        photos: extracted.photos.length,
        hasBudget: !!extracted.budget.summary,
        emails: extracted.emails.length,
        incidents: extracted.incidents.length,
        punchList: extracted.punchList.length,
        meetings: extracted.meetings.length,
        schedule: extracted.schedule.length,
        dailyLogs: extracted.dailyLogs.items.length + extracted.dailyLogs.attachments.length,
        specifications: extracted.specifications.length,
        primeContracts: extracted.primeContractsData?.length ?? extracted.primeContracts.length,
        commitments: (extracted.commitmentsData?.subcontracts?.length ?? 0) + (extracted.commitmentsData?.purchaseOrders?.length ?? 0) || extracted.commitments.subcontracts.length + extracted.commitments.purchaseOrders.length,
        changeOrders: extracted.changeOrdersData?.length ?? extracted.changeOrders.length,
        changeEvents: extracted.changeEventsData?.length ?? extracted.changeEvents.length,
        directCosts: extracted.directCostsData?.length ?? extracted.directCosts.length,
        invoicing: extracted.invoicingData?.length ?? extracted.invoicing.length,
        directory: extracted.directory.length,
        estimating: extracted.estimating.length,
      },
      folderSummary,
      sampleFirst3: {
        folders: extracted.folders.slice(0, 3),
        drawings: extracted.drawings.slice(0, 3),
        submittals: extracted.submittals.slice(0, 3),
        rfis: extracted.rfis.slice(0, 3),
        photos: extracted.photos.slice(0, 3),
        bidPackages: extracted.bidPackages.slice(0, 3),
        emails: extracted.emails.slice(0, 3),
        incidents: extracted.incidents.slice(0, 3),
        punchList: extracted.punchList.slice(0, 3),
        meetings: extracted.meetings.slice(0, 3),
      },
      rawPhotosSample: extracted.photos.slice(0, 3).map((p: any) => ({
        id: p.id,
        name: p.name,
        downloadUrl: p.downloadUrl,
        metadata: p.metadata,
      })),
      imageCategories: extracted.imageCategories,
      budgetSummary: extracted.budget.summary,
      budgetLineItemsCount: extracted.budget.lineItems?.length ?? 0,
      rawFoldersFromProcore: Array.isArray(rawFoldersResponse) ? rawFoldersResponse.slice(0, 3) : rawFoldersResponse,
      rawRecursiveFolderFetch,
      extractionErrors: extracted.extractionErrors ?? null,
      rawPrimeContracts: rawPrimeContractsRes,
      rawCommitments: rawCommitmentsRes,
    });
  }));

  // Debug: raw Procore HTTP test (requires auth, disabled in production)
  app.get("/api/debug/procore-raw-test", requireAuth, asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    const projectId = "598134326238301";
    const { getProcoreAuthForDebug } = await import("../procore");
    const { accessToken, companyId, baseUrl, environment } = await getProcoreAuthForDebug();

    const testUrls = [
      // Original v1.0 project-scoped
      `${baseUrl}/rest/v1.0/projects/${projectId}/prime_contracts?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/projects/${projectId}/work_order_contracts?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/projects/${projectId}/punch_items?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/folders?project_id=${projectId}&per_page=5`,
      `${baseUrl}/rest/v1.0/images?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // v1.1 path variants
      `${baseUrl}/rest/v1.1/projects/${projectId}/prime_contracts?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.1/projects/${projectId}/work_order_contracts?company_id=${companyId}&per_page=5`,
      // project_id as query param instead of path param
      `${baseUrl}/rest/v1.0/prime_contracts?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/work_order_contracts?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/punch_items?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // singular instead of plural
      `${baseUrl}/rest/v1.0/projects/${projectId}/prime_contract?company_id=${companyId}&per_page=5`,
      // v2.0
      `${baseUrl}/rest/v2.0/projects/${projectId}/prime_contracts?company_id=${companyId}&per_page=5`,
      // company scoped
      `${baseUrl}/rest/v1.0/companies/${companyId}/projects/${projectId}/prime_contracts?company_id=${companyId}&per_page=5`,
      // Directory - project-level directory (project users only) vs full company
      `${baseUrl}/rest/v1.0/projects/${projectId}/directory?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/projects/${projectId}/users?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/project_directory?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/project_users?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/users?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v2.0/directory?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Direct costs - try v1.0 instead of v1.1
      `${baseUrl}/rest/v1.0/direct_costs?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Daily logs - might need different endpoint name
      `${baseUrl}/rest/v1.0/daily_log/list?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/daily_logs/list?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Incidents
      `${baseUrl}/rest/v1.0/incidents/list?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v2.0/incidents?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Drawing areas
      `${baseUrl}/rest/v1.1/drawing_areas?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Change orders - might need different name
      `${baseUrl}/rest/v1.0/change_order/packages?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/change_order_packages?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Emails - might be "correspondence" or "email_communications"
      `${baseUrl}/rest/v1.0/email_communications?project_id=${projectId}&company_id=${companyId}&per_page=5`,
      // Submittals and RFIs - path param (were working before query switch)
      `${baseUrl}/rest/v1.0/projects/${projectId}/submittals?company_id=${companyId}&per_page=5`,
      `${baseUrl}/rest/v1.0/projects/${projectId}/rfis?company_id=${companyId}&per_page=5`,
    ];

    const results: Array<{ url: string; status: number; statusText: string; bodyPreview: string }> = [];

    for (const url of testUrls) {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Procore-Company-Id": companyId,
        },
      });
      const body = await resp.text();
      results.push({
        url,
        status: resp.status,
        statusText: resp.statusText,
        bodyPreview: body.substring(0, 500),
      });
    }

    res.json({
      baseUrl,
      companyId,
      environment,
      tokenPresent: !!accessToken,
      projectId,
      results,
    });
  }));

  // Diagnostic endpoint to debug HubSpot pipeline issues
  app.get("/api/debug/hubspot-pipelines", requireAuth, asyncHandler(async (_req: any, res: any) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    const results: any = {
      timestamp: new Date().toISOString(),
      tokenStatus: 'unknown',
      apiResponse: null,
      error: null,
      databasePipelines: [],
    };

    // Check token status
    const token = await storage.getOAuthToken("hubspot");
    results.tokenStatus = {
      hasToken: !!token?.accessToken,
      tokenLength: token?.accessToken?.length || 0,
      tokenPresent: !!token?.accessToken,
      hasRefreshToken: !!token?.refreshToken,
      expiresAt: token?.expiresAt,
      isExpired: token?.expiresAt ? new Date(token.expiresAt).getTime() < Date.now() : 'no expiry set',
    };

    // Check env var
    results.envVarSet = !!process.env.HUBSPOT_ACCESS_TOKEN;

    // Try to fetch pipelines directly from HubSpot API
    const { getAccessToken } = await import('../hubspot');
    const accessToken = await getAccessToken();
    results.resolvedTokenPresent = !!accessToken;

    // Make direct API call to HubSpot
    console.log('[debug] Making direct API call to HubSpot pipelines endpoint...');
    const apiResponse = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    results.apiStatusCode = apiResponse.status;
    results.apiStatusText = apiResponse.statusText;

    if (apiResponse.ok) {
      const data = await apiResponse.json();
      results.apiResponse = {
        pipelineCount: data.results?.length || 0,
        pipelines: data.results?.map((p: any) => ({
          id: p.id,
          label: p.label,
          stageCount: p.stages?.length || 0,
          stages: p.stages?.map((s: any) => ({ id: s.id, label: s.label })),
        })),
      };
    } else {
      const errorText = await apiResponse.text();
      results.apiError = errorText;
    }

    // Check what's in the database
    const dbPipelines = await storage.getHubspotPipelines();
    results.databasePipelines = dbPipelines.map(p => ({
      id: p.id,
      hubspotId: p.hubspotId,
      label: p.label,
      stageCount: (p.stages as any[])?.length || 0,
    }));

    res.json(results);
  }));
}
