import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import {
  testHubSpotConnection,
  runFullHubSpotSync,
  syncHubSpotPipelines,
} from "../hubspot";
import {
  syncHubspotCompanyToProcore,
  syncHubspotContactToProcore,
  runBulkHubspotToProcoreSync,
  testMatchingForCompany,
  testMatchingForContact,
  triggerPostSyncProcoreUpdates,
} from "../hubspot-procore-sync";

export function registerHubSpotRoutes(app: Express, requireAuth: RequestHandler) {
  // ============= Integration Config =============
  app.get("/api/integrations/config", requireAuth, asyncHandler(async (_req, res) => {
    const [hubspot, procore, companycam] = await Promise.all([
      storage.getAutomationConfig("hubspot_config"),
      storage.getAutomationConfig("procore_config"),
      storage.getAutomationConfig("companycam_config"),
    ]);
    res.json({
      hubspot: hubspot?.value || {},
      procore: procore?.value || {},
      companycam: companycam?.value || {},
    });
  }));

  app.post("/api/integrations/hubspot/save", requireAuth, asyncHandler(async (req, res) => {
    const { accessToken, portalId, webhookUrl } = req.body;

    // Trim whitespace from inputs
    const trimmedAccessToken = accessToken?.trim();
    const trimmedPortalId = portalId?.trim();

    if (!trimmedAccessToken) return res.status(400).json({ message: "Access token is required" });

    await storage.upsertOAuthToken({
      provider: "hubspot",
      accessToken: trimmedAccessToken,
      tokenType: "Bearer",
    });

    await storage.upsertAutomationConfig({
      key: "hubspot_config",
      value: { portalId: trimmedPortalId, webhookUrl: webhookUrl?.trim(), configuredAt: new Date().toISOString() },
      description: "HubSpot CRM configuration",
      isActive: true,
    });

    await storage.createAuditLog({
      action: "integration_configured",
      entityType: "hubspot",
      source: "settings",
      status: "success",
      details: { portalId, hasAccessToken: true },
    });

    res.json({ success: true, message: "HubSpot configuration saved" });
  }));

  app.post("/api/integrations/hubspot/test", requireAuth, asyncHandler(async (_req, res) => {
    const result = await testHubSpotConnection();
    res.json(result);
  }));

  app.post("/api/integrations/hubspot/sync", requireAuth, asyncHandler(async (_req, res) => {
    const result = await runFullHubSpotSync();

    await storage.createAuditLog({
      action: "hubspot_full_sync",
      entityType: "all",
      source: "hubspot",
      status: "success",
      details: result,
      durationMs: result.duration,
    });

    let procoreAutoSync = null;
    try {
      procoreAutoSync = await triggerPostSyncProcoreUpdates({
        companies: result.companies,
        contacts: result.contacts,
      });
    } catch (autoErr: any) {
      console.error('[HubSpot→Procore] Post-sync auto-trigger failed:', autoErr.message);
      procoreAutoSync = { error: autoErr.message };
    }

    res.json({ success: true, ...result, procoreAutoSync });
  }));

  app.get("/api/integrations/hubspot/pipelines", requireAuth, asyncHandler(async (_req, res) => {
    const pipelines = await syncHubSpotPipelines();
    res.json({ success: true, pipelines });
  }));

  app.get("/api/integrations/hubspot/data-counts", requireAuth, asyncHandler(async (_req, res) => {
    const counts = await storage.getHubspotDataCounts();
    res.json(counts);
  }));

  // ============= HubSpot Data =============
  app.get("/api/hubspot/companies", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getHubspotCompanies({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/hubspot/contacts", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getHubspotContacts({
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/hubspot/deals", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getHubspotDeals({
      search: req.query.search as string,
      pipeline: req.query.pipeline as string,
      stage: req.query.stage as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  app.get("/api/hubspot/pipelines", requireAuth, asyncHandler(async (_req, res) => {
    const pipelines = await storage.getHubspotPipelines();
    res.json(pipelines);
  }));

  app.get("/api/hubspot/change-history", requireAuth, asyncHandler(async (req, res) => {
    const result = await storage.getHubspotChangeHistoryList({
      entityType: req.query.entityType as string,
      changeType: req.query.changeType as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }));

  // ============= HubSpot Owner Mappings =============
  app.get("/api/hubspot/owner-mappings", requireAuth, asyncHandler(async (_req, res) => {
    const mappings = await storage.getHubspotOwnerMappings();
    res.json(mappings);
  }));

  app.post("/api/hubspot/owner-mappings", requireAuth, asyncHandler(async (req, res) => {
    const { hubspotOwnerId, email, name } = req.body;
    if (!hubspotOwnerId || !email) {
      return res.status(400).json({ error: "hubspotOwnerId and email are required" });
    }
    const mapping = await storage.upsertHubspotOwnerMapping({ hubspotOwnerId: String(hubspotOwnerId), email, name: name || null });
    res.json(mapping);
  }));

  app.post("/api/hubspot/owner-mappings/bulk", requireAuth, asyncHandler(async (req, res) => {
    const { mappings } = req.body as { mappings: Array<{ hubspotOwnerId: string; email: string; name?: string }> };
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ error: "mappings array is required" });
    }
    let created = 0;
    for (const m of mappings) {
      const id = String(m.hubspotOwnerId ?? (m as any)["HS ID #"] ?? "").trim();
      const email = String(m.email ?? "").trim();
      const name = m.name ? String(m.name).trim() : null;
      if (!id || !email) continue;
      await storage.upsertHubspotOwnerMapping({ hubspotOwnerId: id, email, name });
      created++;
    }
    res.json({ success: true, created });
  }));

  app.delete("/api/hubspot/owner-mappings/:hubspotOwnerId", requireAuth, asyncHandler(async (req, res) => {
    const hubspotOwnerId = req.params.hubspotOwnerId as string;
    await storage.deleteHubspotOwnerMapping(hubspotOwnerId);
    res.json({ success: true });
  }));

  // ============= HubSpot-Procore Automation =============
  app.get("/api/automation/hubspot-procore/config", requireAuth, asyncHandler(async (_req, res) => {
    const config = await storage.getAutomationConfig("hubspot_procore_auto_sync");
    res.json(config?.value || { enabled: false });
  }));

  app.post("/api/automation/hubspot-procore/config", requireAuth, asyncHandler(async (req, res) => {
    await storage.upsertAutomationConfig({
      key: "hubspot_procore_auto_sync",
      value: req.body,
      description: "HubSpot → Procore vendor directory auto-sync configuration",
    });
    res.json({ success: true });
  }));

  app.post("/api/automation/hubspot-procore/sync-company/:hubspotId", requireAuth, asyncHandler(async (req, res) => {
    const result = await syncHubspotCompanyToProcore(req.params.hubspotId as string);
    res.json(result);
  }));

  app.post("/api/automation/hubspot-procore/sync-contact/:hubspotId", requireAuth, asyncHandler(async (req, res) => {
    const result = await syncHubspotContactToProcore(req.params.hubspotId as string);
    res.json(result);
  }));

  app.post("/api/automation/hubspot-procore/bulk-sync", requireAuth, asyncHandler(async (req, res) => {
    const type = req.body.type || 'both';
    const result = await runBulkHubspotToProcoreSync(type);
    res.json(result);
  }));

  app.get("/api/automation/hubspot-procore/test-match/company/:hubspotId", requireAuth, asyncHandler(async (req, res) => {
    const result = await testMatchingForCompany(req.params.hubspotId as string);
    res.json(result);
  }));

  app.get("/api/automation/hubspot-procore/test-match/contact/:hubspotId", requireAuth, asyncHandler(async (req, res) => {
    const result = await testMatchingForContact(req.params.hubspotId as string);
    res.json(result);
  }));

  // ============= Provider Disconnect =============
  app.post("/api/integrations/:provider/disconnect", requireAuth, asyncHandler(async (req, res) => {
    const provider = req.params.provider as string;
    const token = await storage.getOAuthToken(provider);
    if (token) {
      await storage.upsertOAuthToken({
        provider,
        accessToken: "",
        tokenType: "Bearer",
      });
    }

    await storage.createAuditLog({
      action: "integration_disconnected",
      entityType: provider,
      source: "settings",
      status: "success",
      details: { disconnectedAt: new Date().toISOString() },
    });

    res.json({ success: true, message: `${provider} disconnected` });
  }));
}
