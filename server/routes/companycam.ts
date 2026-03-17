import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { runFullCompanycamSync } from "../companycam";

export function registerCompanyCamRoutes(app: Express, requireAuth: RequestHandler) {
  // ============= CompanyCam Integration Config =============
  app.post("/api/integrations/companycam/save", requireAuth, asyncHandler(async (req, res) => {
    const { apiToken, webhookUrl } = req.body;
    if (!apiToken) return res.status(400).json({ message: "API token is required" });

    await storage.upsertOAuthToken({
      provider: "companycam",
      accessToken: apiToken,
      tokenType: "Bearer",
    });

    await storage.upsertAutomationConfig({
      key: "companycam_config",
      value: { webhookUrl, configuredAt: new Date().toISOString() },
      description: "CompanyCam configuration",
      isActive: true,
    });

    await storage.createAuditLog({
      action: "integration_configured",
      entityType: "companycam",
      source: "settings",
      status: "success",
      details: { hasApiToken: true },
    });

    res.json({ success: true, message: "CompanyCam configuration saved" });
  }));

  app.post("/api/integrations/companycam/sync", requireAuth, asyncHandler(async (_req, res) => {
    const result = await runFullCompanycamSync();
    res.json(result);
  }));

  app.get("/api/integrations/companycam/data-counts", requireAuth, asyncHandler(async (_req, res) => {
    const counts = await storage.getCompanycamDataCounts();
    res.json(counts);
  }));

  app.post("/api/integrations/companycam/test", requireAuth, asyncHandler(async (_req, res) => {
    const token = await storage.getOAuthToken("companycam");
    const apiToken = token?.accessToken || process.env.COMPANYCAM_API_TOKEN;
    if (!apiToken) return res.json({ success: false, message: "No CompanyCam API token configured" });

    const axios = (await import("axios")).default;
    const response = await axios.get("https://api.companycam.com/v2/projects?per_page=1", {
      headers: { Authorization: `Bearer ${apiToken}` },
      timeout: 10000,
    });

    res.json({
      success: true,
      message: `Connected! Found ${response.data.length > 0 ? "projects" : "no projects yet"} in your CompanyCam account.`,
    });
  }));

  // ============= CompanyCam Data =============
  app.get("/api/companycam/projects", requireAuth, asyncHandler(async (req, res) => {
    const { search, status, limit, offset } = req.query;
    const result = await storage.getCompanycamProjects({
      search: search as string,
      status: status as string,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  }));

  app.get("/api/companycam/users", requireAuth, asyncHandler(async (req, res) => {
    const { search, role, limit, offset } = req.query;
    const result = await storage.getCompanycamUsers({
      search: search as string,
      role: role as string,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  }));

  app.get("/api/companycam/photos", requireAuth, asyncHandler(async (req, res) => {
    const { search, projectId, limit, offset } = req.query;
    const result = await storage.getCompanycamPhotos({
      search: search as string,
      projectId: projectId as string,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  }));

  app.get("/api/companycam/change-history", requireAuth, asyncHandler(async (req, res) => {
    const { entityType, changeType, limit, offset } = req.query;
    const result = await storage.getCompanycamChangeHistory({
      entityType: entityType as string,
      changeType: changeType as string,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  }));

  // ============= CompanyCam Automation =============
  app.post("/api/companycam/find-or-create", requireAuth, asyncHandler(async (req, res) => {
    const { name, streetAddress, city, state, postalCode, hubspotDealId, procoreProjectId, dedupeThreshold } = req.body;
    const { findOrCreateCompanyCamProject } = await import('../companycam-automation');
    const result = await findOrCreateCompanyCamProject(
      { name, streetAddress, city, state, postalCode },
      { hubspotDealId, procoreProjectId, dedupeThreshold }
    );
    res.json(result);
  }));

  app.post("/api/companycam/link", requireAuth, asyncHandler(async (req, res) => {
    const { companycamId, hubspotDealId, procoreProjectId } = req.body;
    const { linkCompanyCamProject } = await import('../companycam-automation');
    const result = await linkCompanyCamProject(companycamId, { hubspotDealId, procoreProjectId });
    res.json(result);
  }));

  app.get("/api/companycam/search", requireAuth, asyncHandler(async (req, res) => {
    const { name, address } = req.query;
    const { searchCompanyCamProjects } = await import('../companycam-automation');
    const results = await searchCompanyCamProjects({
      name: name as string,
      address: address as string,
    });
    res.json(results);
  }));

  app.get("/api/companycam/duplicates", requireAuth, asyncHandler(async (_req, res) => {
    const { findDuplicateCompanyCamProjects } = await import('../companycam-automation');
    const duplicates = await findDuplicateCompanyCamProjects();
    res.json(duplicates);
  }));

  app.post("/api/companycam/bulk-match", requireAuth, asyncHandler(async (req, res) => {
    const autoSync = req.query.autoSync === 'true';

    // Optionally sync CompanyCam data first
    if (autoSync) {
      console.log('[CompanyCam Bulk Match] Auto-syncing CompanyCam projects first...');
      const syncResult = await runFullCompanycamSync();
      console.log(`[CompanyCam Bulk Match] Sync complete: ${syncResult.projects?.synced || 0} projects synced`);
    }

    const { bulkMatchCompanyCamToProcore } = await import('../companycam-automation');
    const result = await bulkMatchCompanyCamToProcore();
    res.json(result);
  }));
}
