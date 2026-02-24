import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertStageMappingSchema, insertSyncMappingSchema } from "@shared/schema";
import { z } from "zod";
import session from "express-session";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { testHubSpotConnection, runFullHubSpotSync, syncHubSpotPipelines, updateHubSpotDealStage } from "./hubspot";
import { runFullProcoreSync, syncProcoreBidBoard, updateProcoreProject, updateProcoreBid, fetchProcoreBidDetail, proxyProcoreAttachment, fetchProcoreProjectStages } from "./procore";
import { runFullCompanycamSync } from "./companycam";
import { processHubspotWebhookForProcore, syncHubspotCompanyToProcore, syncHubspotContactToProcore, runBulkHubspotToProcoreSync, testMatchingForCompany, testMatchingForContact, triggerPostSyncProcoreUpdates } from "./hubspot-procore-sync";

const PgSession = connectPgSimple(session);

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use(
    session({
      store: new PgSession({ pool, createTableIfMissing: true }),
      secret: process.env.SESSION_SECRET || "trock-sync-hub-secret",
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false },
    })
  );

  function requireAuth(req: any, res: any, next: any) {
    if (req.session?.userId) {
      return next();
    }
    res.status(401).json({ message: "Unauthorized" });
  }

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await storage.getUserByUsername(username);
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ message: "Invalid credentials" });
      }
      (req.session as any).userId = user.id;
      res.json({ id: user.id, username: user.username, role: user.role });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { username, password } = req.body;
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ message: "Username already exists" });
      }
      const user = await storage.createUser({ username, password });
      (req.session as any).userId = user.id;
      res.json({ id: user.id, username: user.username, role: user.role });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!(req.session as any)?.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const user = await storage.getUser((req.session as any).userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    res.json({ id: user.id, username: user.username, role: user.role });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ message: "Logged out" });
    });
  });

  app.get("/api/dashboard/stats", requireAuth, async (_req, res) => {
    try {
      const stats = await storage.getDashboardStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/dashboard/connections", requireAuth, async (_req, res) => {
    try {
      const [hubspot, procore, companycam] = await Promise.all([
        storage.getOAuthToken("hubspot"),
        storage.getOAuthToken("procore"),
        storage.getOAuthToken("companycam"),
      ]);

      let hubspotConnected = !!hubspot?.accessToken || !!process.env.HUBSPOT_ACCESS_TOKEN;
      if (!hubspotConnected) {
        try {
          const testResult = await testHubSpotConnection();
          hubspotConnected = testResult.success;
        } catch { hubspotConnected = false; }
      }

      res.json({
        hubspot: { connected: hubspotConnected, expiresAt: hubspot?.expiresAt },
        procore: { connected: !!procore?.accessToken, expiresAt: procore?.expiresAt },
        companycam: { connected: !!(companycam?.accessToken) || !!process.env.COMPANYCAM_API_TOKEN, expiresAt: companycam?.expiresAt },
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/sync-mappings", requireAuth, async (req, res) => {
    try {
      const query = req.query.search as string;
      const mappings = query ? await storage.searchSyncMappings(query) : await storage.getSyncMappings();
      res.json(mappings);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/sync-mappings", requireAuth, async (req, res) => {
    try {
      const data = insertSyncMappingSchema.parse(req.body);
      const mapping = await storage.createSyncMapping(data);
      res.json(mapping);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.patch("/api/sync-mappings/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const mapping = await storage.updateSyncMapping(id, req.body);
      if (!mapping) return res.status(404).json({ message: "Not found" });
      res.json(mapping);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/stage-mappings", requireAuth, async (_req, res) => {
    try {
      const mappings = await storage.getStageMappings();
      res.json(mappings);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/stage-mappings", requireAuth, async (req, res) => {
    try {
      const data = insertStageMappingSchema.parse(req.body);
      const mapping = await storage.createStageMapping(data);
      res.json(mapping);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.patch("/api/stage-mappings/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const mapping = await storage.updateStageMapping(id, req.body);
      if (!mapping) return res.status(404).json({ message: "Not found" });
      res.json(mapping);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.delete("/api/stage-mappings/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteStageMapping(id);
      res.json({ message: "Deleted" });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/webhook-logs", requireAuth, async (req, res) => {
    try {
      const filters = {
        source: req.query.source as string,
        status: req.query.status as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      };
      const result = await storage.getWebhookLogs(filters);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/webhook-logs/:id/retry", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const log = await storage.updateWebhookLog(id, { status: "retrying", retryCount: 0 });
      if (!log) return res.status(404).json({ message: "Not found" });
      res.json(log);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/audit-logs", requireAuth, async (req, res) => {
    try {
      const filters = {
        entityType: req.query.entityType as string,
        status: req.query.status as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
        startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
        endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      };
      const result = await storage.getAuditLogs(filters);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/automation-config", requireAuth, async (_req, res) => {
    try {
      const configs = await storage.getAutomationConfigs();
      res.json(configs);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.put("/api/automation-config", requireAuth, async (req, res) => {
    try {
      const config = await storage.upsertAutomationConfig(req.body);
      res.json(config);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/poll-jobs", requireAuth, async (_req, res) => {
    try {
      const jobs = await storage.getPollJobs();
      res.json(jobs);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/poll-jobs/:jobName", requireAuth, async (req, res) => {
    try {
      const job = await storage.updatePollJob(req.params.jobName, req.body);
      if (!job) return res.status(404).json({ message: "Not found" });
      res.json(job);
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/oauth/procore/authorize", async (_req, res) => {
    const config = await storage.getAutomationConfig("procore_config");
    const clientId = (config?.value as any)?.clientId;
    const env = (config?.value as any)?.environment || "production";
    const host = process.env.REPLIT_DEV_DOMAIN ? 'https://' + process.env.REPLIT_DEV_DOMAIN : 'http://localhost:5000';
    const redirectUri = `${host}/api/oauth/procore/callback`;
    const baseUrl = env === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";
    if (!clientId) return res.status(400).json({ message: "Procore Client ID not configured. Save your credentials first." });
    const url = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ url });
  });

  app.get("/api/oauth/procore/callback", async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) return res.status(400).json({ message: "Missing authorization code" });
      const config = await storage.getAutomationConfig("procore_config");
      const clientId = (config?.value as any)?.clientId;
      const clientSecret = (config?.value as any)?.clientSecret;
      const env = (config?.value as any)?.environment || "production";
      const host = process.env.REPLIT_DEV_DOMAIN ? 'https://' + process.env.REPLIT_DEV_DOMAIN : 'http://localhost:5000';
      const redirectUri = `${host}/api/oauth/procore/callback`;
      const baseUrl = env === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";

      const axios = (await import("axios")).default;
      const response = await axios.post(`${baseUrl}/oauth/token`, {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });

      const { access_token, refresh_token, expires_in } = response.data;
      const expiresAt = new Date(Date.now() + expires_in * 1000);

      await storage.upsertOAuthToken({
        provider: "procore",
        accessToken: access_token,
        refreshToken: refresh_token,
        tokenType: "Bearer",
        expiresAt,
      });

      await storage.createAuditLog({
        action: "oauth_connect",
        entityType: "procore",
        source: "oauth",
        status: "success",
        details: { message: "Procore OAuth connected successfully" },
      });

      res.redirect("/#/settings?procore=connected");
    } catch (e: any) {
      res.redirect("/#/settings?procore=error&message=" + encodeURIComponent(e.message));
    }
  });

  app.post("/webhooks/hubspot", async (req, res) => {
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const event of events) {
        const idempotencyKey = `hs_${event.eventId || event.objectId}_${Date.now()}`;
        const existing = await storage.checkIdempotencyKey(idempotencyKey);
        if (existing) continue;

        const webhookLog = await storage.createWebhookLog({
          source: "hubspot",
          eventType: event.subscriptionType || event.eventType || "unknown",
          resourceId: String(event.objectId || ""),
          resourceType: event.objectType || "unknown",
          status: "received",
          payload: event,
          idempotencyKey,
        });

        await storage.createIdempotencyKey({
          key: idempotencyKey,
          source: "hubspot",
          eventType: event.subscriptionType || "unknown",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        await storage.createAuditLog({
          action: "webhook_received",
          entityType: event.objectType || "unknown",
          entityId: String(event.objectId || ""),
          source: "hubspot",
          status: "received",
          details: event,
          idempotencyKey,
        });

        await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });

        const eventType = event.subscriptionType || event.eventType || "";
        const objectType = event.objectType || "";
        const objectId = String(event.objectId || "");
        try {
          await processHubspotWebhookForProcore(eventType, objectType, objectId);
        } catch (autoErr: any) {
          console.error(`HubSpot→Procore auto-sync error for ${objectType} ${objectId}:`, autoErr.message);
        }
      }
      res.status(200).json({ received: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/webhooks/procore", async (req, res) => {
    try {
      const event = req.body;
      const idempotencyKey = `pc_${event.id || event.resource_id}_${Date.now()}`;
      const existing = await storage.checkIdempotencyKey(idempotencyKey);
      if (existing) return res.status(200).json({ received: true });

      const webhookLog = await storage.createWebhookLog({
        source: "procore",
        eventType: event.event_type || "unknown",
        resourceId: String(event.resource_id || ""),
        resourceType: event.resource_name || "unknown",
        status: "received",
        payload: event,
        idempotencyKey,
      });

      await storage.createIdempotencyKey({
        key: idempotencyKey,
        source: "procore",
        eventType: event.event_type || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      await storage.createAuditLog({
        action: "webhook_received",
        entityType: event.resource_name || "unknown",
        entityId: String(event.resource_id || ""),
        source: "procore",
        status: "received",
        details: event,
        idempotencyKey,
      });

      await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });
      res.status(200).json({ received: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/webhooks/companycam", async (req, res) => {
    try {
      const event = req.body;
      const idempotencyKey = `cc_${event.data?.id || Date.now()}`;
      const existing = await storage.checkIdempotencyKey(idempotencyKey);
      if (existing) return res.status(200).json({ received: true });

      const webhookLog = await storage.createWebhookLog({
        source: "companycam",
        eventType: event.event_type || "unknown",
        resourceId: String(event.data?.id || ""),
        resourceType: "project",
        status: "received",
        payload: event,
        idempotencyKey,
      });

      await storage.createIdempotencyKey({
        key: idempotencyKey,
        source: "companycam",
        eventType: event.event_type || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      await storage.createAuditLog({
        action: "webhook_received",
        entityType: "project",
        entityId: String(event.data?.id || ""),
        source: "companycam",
        status: "received",
        details: event,
        idempotencyKey,
      });

      await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });
      res.status(200).json({ received: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/integrations/config", requireAuth, async (_req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/hubspot/save", requireAuth, async (req, res) => {
    try {
      const { accessToken, portalId, webhookUrl } = req.body;
      if (!accessToken) return res.status(400).json({ message: "Access token is required" });

      await storage.upsertOAuthToken({
        provider: "hubspot",
        accessToken,
        tokenType: "Bearer",
      });

      await storage.upsertAutomationConfig({
        key: "hubspot_config",
        value: { portalId, webhookUrl, configuredAt: new Date().toISOString() },
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
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/hubspot/test", requireAuth, async (_req, res) => {
    try {
      const result = await testHubSpotConnection();
      res.json(result);
    } catch (e: any) {
      res.json({ success: false, message: e.message });
    }
  });

  app.post("/api/integrations/hubspot/sync", requireAuth, async (_req, res) => {
    try {
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
    } catch (e: any) {
      await storage.createAuditLog({
        action: "hubspot_full_sync",
        entityType: "all",
        source: "hubspot",
        status: "error",
        errorMessage: e.message,
        details: { error: e.message },
      });
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/integrations/hubspot/pipelines", requireAuth, async (_req, res) => {
    try {
      const pipelines = await syncHubSpotPipelines();
      res.json({ success: true, pipelines });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/integrations/hubspot/data-counts", requireAuth, async (_req, res) => {
    try {
      const counts = await storage.getHubspotDataCounts();
      res.json(counts);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/hubspot/companies", requireAuth, async (req, res) => {
    try {
      const result = await storage.getHubspotCompanies({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/hubspot/contacts", requireAuth, async (req, res) => {
    try {
      const result = await storage.getHubspotContacts({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/hubspot/deals", requireAuth, async (req, res) => {
    try {
      const result = await storage.getHubspotDeals({
        search: req.query.search as string,
        pipeline: req.query.pipeline as string,
        stage: req.query.stage as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/hubspot/pipelines", requireAuth, async (_req, res) => {
    try {
      const pipelines = await storage.getHubspotPipelines();
      res.json(pipelines);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/hubspot/change-history", requireAuth, async (req, res) => {
    try {
      const result = await storage.getHubspotChangeHistoryList({
        entityType: req.query.entityType as string,
        changeType: req.query.changeType as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/procore/save", requireAuth, async (req, res) => {
    try {
      const { clientId, clientSecret, companyId, environment } = req.body;
      if (!clientId || !clientSecret) return res.status(400).json({ message: "Client ID and Client Secret are required" });

      await storage.upsertAutomationConfig({
        key: "procore_config",
        value: {
          clientId,
          clientSecret,
          companyId,
          environment: environment || "production",
          configuredAt: new Date().toISOString(),
        },
        description: "Procore configuration",
        isActive: true,
      });

      await storage.createAuditLog({
        action: "integration_configured",
        entityType: "procore",
        source: "settings",
        status: "success",
        details: { companyId, environment, hasCredentials: true },
      });

      res.json({ success: true, message: "Procore configuration saved" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/procore/test", requireAuth, async (_req, res) => {
    try {
      const token = await storage.getOAuthToken("procore");
      if (!token?.accessToken) {
        return res.json({ success: false, message: "No Procore OAuth token found. Use the OAuth flow to connect." });
      }

      const config = await storage.getAutomationConfig("procore_config");
      const env = (config?.value as any)?.environment || "production";
      const baseUrl = env === "sandbox" ? "https://sandbox.procore.com" : "https://api.procore.com";

      const axios = (await import("axios")).default;
      const response = await axios.get(`${baseUrl}/rest/v1.0/me`, {
        headers: { Authorization: `Bearer ${token.accessToken}` },
        timeout: 10000,
      });

      res.json({
        success: true,
        message: `Connected as ${response.data.name || response.data.login}`,
      });
    } catch (e: any) {
      const msg = e.response?.status === 401
        ? "Token expired or invalid. Please re-authenticate via OAuth."
        : e.response?.data?.message || e.message;
      res.json({ success: false, message: msg });
    }
  });

  app.post("/api/integrations/companycam/save", requireAuth, async (req, res) => {
    try {
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
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/companycam/sync", requireAuth, async (_req, res) => {
    try {
      const result = await runFullCompanycamSync();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/integrations/companycam/data-counts", requireAuth, async (_req, res) => {
    try {
      const counts = await storage.getCompanycamDataCounts();
      res.json(counts);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/companycam/projects", requireAuth, async (req, res) => {
    try {
      const { search, status, limit, offset } = req.query;
      const result = await storage.getCompanycamProjects({
        search: search as string,
        status: status as string,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/companycam/users", requireAuth, async (req, res) => {
    try {
      const { search, role, limit, offset } = req.query;
      const result = await storage.getCompanycamUsers({
        search: search as string,
        role: role as string,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/companycam/photos", requireAuth, async (req, res) => {
    try {
      const { search, projectId, limit, offset } = req.query;
      const result = await storage.getCompanycamPhotos({
        search: search as string,
        projectId: projectId as string,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/companycam/change-history", requireAuth, async (req, res) => {
    try {
      const { entityType, changeType, limit, offset } = req.query;
      const result = await storage.getCompanycamChangeHistory({
        entityType: entityType as string,
        changeType: changeType as string,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/integrations/companycam/test", requireAuth, async (_req, res) => {
    try {
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
    } catch (e: any) {
      const msg = e.response?.status === 401
        ? "Invalid API token. Please check your CompanyCam token."
        : e.response?.data?.message || e.message;
      res.json({ success: false, message: msg });
    }
  });

  app.get("/api/automation/hubspot-procore/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("hubspot_procore_auto_sync");
      res.json(config?.value || { enabled: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/hubspot-procore/config", requireAuth, async (req, res) => {
    try {
      await storage.upsertAutomationConfig({
        key: "hubspot_procore_auto_sync",
        value: req.body,
        description: "HubSpot → Procore vendor directory auto-sync configuration",
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/hubspot-procore/sync-company/:hubspotId", requireAuth, async (req, res) => {
    try {
      const result = await syncHubspotCompanyToProcore(req.params.hubspotId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ action: 'error', message: e.message });
    }
  });

  app.post("/api/automation/hubspot-procore/sync-contact/:hubspotId", requireAuth, async (req, res) => {
    try {
      const result = await syncHubspotContactToProcore(req.params.hubspotId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ action: 'error', message: e.message });
    }
  });

  app.post("/api/automation/hubspot-procore/bulk-sync", requireAuth, async (req, res) => {
    try {
      const type = req.body.type || 'both';
      const result = await runBulkHubspotToProcoreSync(type);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/automation/hubspot-procore/test-match/company/:hubspotId", requireAuth, async (req, res) => {
    try {
      const result = await testMatchingForCompany(req.params.hubspotId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/automation/hubspot-procore/test-match/contact/:hubspotId", requireAuth, async (req, res) => {
    try {
      const result = await testMatchingForContact(req.params.hubspotId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/integrations/:provider/disconnect", requireAuth, async (req, res) => {
    try {
      const provider = req.params.provider;
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
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/procore/sync", requireAuth, async (_req, res) => {
    try {
      const result = await runFullProcoreSync();

      await storage.createAuditLog({
        action: "procore_full_sync",
        entityType: "all",
        source: "procore",
        status: "success",
        details: result,
        durationMs: result.duration,
      });

      res.json({ success: true, ...result });
    } catch (e: any) {
      await storage.createAuditLog({
        action: "procore_full_sync",
        entityType: "all",
        source: "procore",
        status: "error",
        errorMessage: e.message,
        details: { error: e.message },
      });
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/integrations/procore/data-counts", requireAuth, async (_req, res) => {
    try {
      const counts = await storage.getProcoreDataCounts();
      const bidboardCount = await storage.getBidboardEstimateCount();
      res.json({ ...counts, bidboardEstimates: bidboardCount });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/projects", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreProjects({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/vendors", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreVendors({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/users", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreUsers({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/change-history", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreChangeHistory({
        entityType: req.query.entityType as string,
        changeType: req.query.changeType as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/procore/sync-bidboard", requireAuth, async (_req, res) => {
    try {
      const result = await syncProcoreBidBoard();
      await storage.createAuditLog({
        action: "procore_bidboard_sync",
        entityType: "bid_board",
        source: "procore",
        status: "success",
        details: result,
      });
      res.json({ success: true, ...result });
    } catch (e: any) {
      await storage.createAuditLog({
        action: "procore_bidboard_sync",
        entityType: "bid_board",
        source: "procore",
        status: "error",
        errorMessage: e.message,
      });
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/procore/bid-packages", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreBidPackages({
        search: req.query.search as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/bids", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreBids({
        search: req.query.search as string,
        bidPackageId: req.query.bidPackageId as string,
        bidStatus: req.query.bidStatus as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/project-stages", requireAuth, async (req, res) => {
    try {
      const stages = await fetchProcoreProjectStages();
      res.json(stages);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/procore/projects/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const fields = req.body;
      if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ message: "No fields to update" });
      const project = await storage.getProcoreProjectByProcoreId(projectId);
      if (!project) return res.status(404).json({ message: "Project not found in local DB" });
      const result = await updateProcoreProject(projectId, fields);
      await storage.upsertProcoreProject({
        procoreId: project.procoreId,
        name: result.name || project.name,
        displayName: result.display_name || project.displayName,
        projectNumber: result.project_number || project.projectNumber,
        address: result.address || project.address,
        city: result.city || project.city,
        stateCode: result.state_code || project.stateCode,
        zip: result.zip || project.zip,
        countryCode: result.country_code || project.countryCode,
        phone: result.phone || project.phone,
        active: result.active ?? project.active,
        stage: result.project_stage?.name || result.stage || project.stage,
        projectStageName: result.project_stage?.name || project.projectStageName,
        startDate: result.start_date || project.startDate,
        completionDate: result.completion_date || project.completionDate,
        projectedFinishDate: result.projected_finish_date || project.projectedFinishDate,
        estimatedValue: result.estimated_value != null ? String(result.estimated_value) : project.estimatedValue,
        totalValue: result.total_value != null ? String(result.total_value) : project.totalValue,
        storeNumber: project.storeNumber,
        deliveryMethod: result.delivery_method || project.deliveryMethod,
        workScope: project.workScope,
        companyId: project.companyId,
        companyName: project.companyName,
        properties: result,
        lastSyncedAt: new Date(),
        procoreUpdatedAt: result.updated_at ? new Date(result.updated_at) : project.procoreUpdatedAt,
      });
      await storage.createAuditLog({
        action: "procore_project_update",
        entityType: "project",
        entityId: projectId,
        source: "procore",
        status: "success",
        details: { fields: Object.keys(fields), projectName: project.name },
      });
      res.json({ success: true, project: result });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.patch("/api/procore/bids/:bidId", requireAuth, async (req, res) => {
    try {
      const { bidId } = req.params;
      const fields = req.body;
      if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ message: "No fields to update" });
      const bid = await storage.getProcoreBidByProcoreId(bidId);
      if (!bid) return res.status(404).json({ message: "Bid not found" });
      const result = await updateProcoreBid(bid.projectId!, bid.bidPackageId!, bidId, fields);
      await storage.upsertProcoreBid({
        procoreId: bid.procoreId,
        bidPackageId: bid.bidPackageId,
        bidPackageTitle: bid.bidPackageTitle,
        bidFormId: bid.bidFormId,
        bidFormTitle: bid.bidFormTitle,
        projectId: bid.projectId,
        projectName: bid.projectName,
        projectAddress: bid.projectAddress,
        vendorId: bid.vendorId,
        vendorName: bid.vendorName,
        vendorTrades: bid.vendorTrades,
        bidStatus: result.bid_status || bid.bidStatus,
        awarded: result.awarded ?? null,
        submitted: result.submitted ?? bid.submitted,
        isBidderCommitted: result.is_bidder_committed ?? bid.isBidderCommitted,
        lumpSumEnabled: bid.lumpSumEnabled,
        lumpSumAmount: result.lump_sum_amount != null ? String(result.lump_sum_amount) : bid.lumpSumAmount,
        bidderComments: result.bidder_comments || bid.bidderComments,
        dueDate: bid.dueDate,
        invitationLastSentAt: bid.invitationLastSentAt,
        bidRequesterName: bid.bidRequesterName,
        bidRequesterEmail: bid.bidRequesterEmail,
        bidRequesterCompany: bid.bidRequesterCompany,
        requireNda: bid.requireNda,
        ndaStatus: bid.ndaStatus,
        showBidInEstimating: bid.showBidInEstimating,
        companyId: bid.companyId,
        properties: result,
        procoreCreatedAt: bid.procoreCreatedAt,
        procoreUpdatedAt: result.updated_at ? new Date(result.updated_at) : bid.procoreUpdatedAt,
        lastSyncedAt: new Date(),
      });
      await storage.createAuditLog({
        action: "procore_bid_update",
        entityType: "bid",
        entityId: bidId,
        source: "procore",
        status: "success",
        details: { fields: Object.keys(fields), vendorName: bid.vendorName, bidPackageTitle: bid.bidPackageTitle },
      });
      res.json({ success: true, bid: result });
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get("/api/procore/bids/:bidId/detail", requireAuth, async (req, res) => {
    try {
      const { bidId } = req.params;
      const bid = await storage.getProcoreBidByProcoreId(bidId);
      if (!bid) return res.status(404).json({ message: "Bid not found in local DB" });
      const detail = await fetchProcoreBidDetail(bid.projectId!, bid.bidPackageId!, bidId);
      await storage.upsertProcoreBid({
        procoreId: bid.procoreId,
        bidPackageId: bid.bidPackageId,
        bidPackageTitle: bid.bidPackageTitle,
        bidFormId: bid.bidFormId,
        bidFormTitle: bid.bidFormTitle,
        projectId: bid.projectId,
        projectName: bid.projectName,
        projectAddress: bid.projectAddress,
        vendorId: bid.vendorId,
        vendorName: bid.vendorName,
        vendorTrades: bid.vendorTrades,
        bidStatus: detail.bid_status || bid.bidStatus,
        awarded: detail.awarded ?? null,
        submitted: detail.submitted ?? bid.submitted,
        isBidderCommitted: detail.is_bidder_committed ?? bid.isBidderCommitted,
        lumpSumEnabled: bid.lumpSumEnabled,
        lumpSumAmount: detail.lump_sum_amount != null ? String(detail.lump_sum_amount) : bid.lumpSumAmount,
        bidderComments: detail.bidder_comments || bid.bidderComments,
        dueDate: bid.dueDate,
        invitationLastSentAt: bid.invitationLastSentAt,
        bidRequesterName: bid.bidRequesterName,
        bidRequesterEmail: bid.bidRequesterEmail,
        bidRequesterCompany: bid.bidRequesterCompany,
        requireNda: bid.requireNda,
        ndaStatus: bid.ndaStatus,
        showBidInEstimating: bid.showBidInEstimating,
        companyId: bid.companyId,
        properties: detail,
        procoreCreatedAt: bid.procoreCreatedAt,
        procoreUpdatedAt: detail.updated_at ? new Date(detail.updated_at) : bid.procoreUpdatedAt,
        lastSyncedAt: new Date(),
      });
      res.json(detail);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/attachments/proxy", requireAuth, async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) return res.status(400).json({ message: "url parameter required" });
      const { buffer, contentType, filename } = await proxyProcoreAttachment(url);
      res.setHeader("Content-Type", contentType || "application/octet-stream");
      if (filename) res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.send(buffer);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/bid-forms", requireAuth, async (req, res) => {
    try {
      const result = await storage.getProcoreBidForms({
        search: req.query.search as string,
        bidPackageId: req.query.bidPackageId as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  const multer = (await import("multer")).default;
  const XLSX = (await import("xlsx")).default;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  app.post("/api/bidboard/import", requireAuth, upload.single("file"), async (req: any, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet) as any[];

      if (!rows.length) return res.status(400).json({ message: "Empty spreadsheet" });

      const oldEstimates = await storage.getBidboardEstimates({ limit: 10000, offset: 0 });
      const oldStatusMap = new Map<string, string>();
      for (const est of oldEstimates.data) {
        if (est.name && est.status) {
          oldStatusMap.set(est.name.trim().toLowerCase(), est.status);
        }
      }

      const dbProjectNames = await storage.getProcoreProjects({ limit: 10000, offset: 0 });
      const dbNameMap = new Map<string, string>();
      for (const p of dbProjectNames.data) {
        dbNameMap.set((p.name || "").trim().toLowerCase(), String(p.procoreId));
      }

      await storage.clearBidboardEstimates();

      let imported = 0, matched = 0, unmatched = 0;
      const statusChanges: { name: string; oldStatus: string; newStatus: string }[] = [];

      for (const row of rows) {
        const name = (row.Name || "").trim();
        if (!name) continue;

        const newStatus = (row.Status || "").trim();

        let createdDate: Date | null = null;
        if (row["Created Date"]) {
          if (typeof row["Created Date"] === "number") {
            createdDate = new Date((row["Created Date"] - 25569) * 86400000);
          } else {
            createdDate = new Date(row["Created Date"]);
          }
        }
        let dueDate: Date | null = null;
        if (row["Due Date"]) {
          if (typeof row["Due Date"] === "number") {
            dueDate = new Date((row["Due Date"] - 25569) * 86400000);
          } else {
            dueDate = new Date(row["Due Date"]);
          }
        }

        const nameLC = name.toLowerCase();
        const exactMatch = dbNameMap.get(nameLC);
        let matchStatus = "unmatched";
        let procoreProjectId: string | null = null;

        if (exactMatch) {
          matchStatus = "matched";
          procoreProjectId = exactMatch;
          matched++;
        } else {
          for (const [dbName, dbId] of dbNameMap.entries()) {
            if (dbName.includes(nameLC) || nameLC.includes(dbName)) {
              matchStatus = "partial";
              procoreProjectId = dbId;
              matched++;
              break;
            }
          }
          if (matchStatus === "unmatched") unmatched++;
        }

        const oldStatus = oldStatusMap.get(nameLC);
        if (oldStatus && newStatus && oldStatus !== newStatus) {
          statusChanges.push({ name, oldStatus, newStatus });
        }

        await storage.upsertBidboardEstimate({
          name,
          estimator: (row.Estimator || "").trim() || null,
          office: (row.Office || "").trim() || null,
          status: newStatus || null,
          salesPricePerArea: (row["Sales Price Per Area"] || "").toString().trim() || null,
          projectCost: row["Project Cost"] != null ? String(row["Project Cost"]) : null,
          profitMargin: row["Profit Margin"] != null ? String(row["Profit Margin"]) : null,
          totalSales: row["Total Sales"] != null ? String(row["Total Sales"]) : null,
          createdDate,
          dueDate,
          customerName: (row["Customer Name"] || "").trim() || null,
          customerContact: (row["Customer Contact"] || "").trim() || null,
          projectNumber: row["Project #"] ? String(row["Project #"]).trim() : null,
          procoreProjectId,
          matchStatus,
        });
        imported++;
      }

      let hubspotSyncResult = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, details: [] as any[] };

      if (statusChanges.length > 0) {
        const mappingConfig = await storage.getAutomationConfig("bidboard_hubspot_stage_mapping");
        const mappingValue = mappingConfig?.value as { mappings?: Record<string, string>; enabled?: boolean } | undefined;
        
        if (mappingValue?.enabled && mappingValue.mappings && Object.keys(mappingValue.mappings).length > 0) {
          const changedNames = statusChanges.map(sc => sc.name);
          const matchingDeals = await storage.getHubspotDealsByDealNames(changedNames);
          const dealsByName = new Map<string, { hubspotId: string; dealName: string; dealStage: string | null }>();
          for (const d of matchingDeals) {
            if (d.dealName) {
              dealsByName.set(d.dealName.trim().toLowerCase(), {
                hubspotId: d.hubspotId,
                dealName: d.dealName,
                dealStage: d.dealStage,
              });
            }
          }

          for (const change of statusChanges) {
            const targetStageId = mappingValue.mappings[change.newStatus];
            if (!targetStageId) {
              hubspotSyncResult.skipped++;
              continue;
            }

            const deal = dealsByName.get(change.name.trim().toLowerCase());
            if (!deal) {
              hubspotSyncResult.skipped++;
              hubspotSyncResult.details.push({
                name: change.name,
                status: "skipped",
                reason: "No matching HubSpot deal",
              });
              continue;
            }

            if (deal.dealStage === targetStageId) {
              hubspotSyncResult.skipped++;
              continue;
            }

            hubspotSyncResult.attempted++;
            const result = await updateHubSpotDealStage(deal.hubspotId, targetStageId);
            if (result.success) {
              hubspotSyncResult.succeeded++;
              hubspotSyncResult.details.push({
                name: change.name,
                hubspotId: deal.hubspotId,
                status: "updated",
                oldBidBoardStatus: change.oldStatus,
                newBidBoardStatus: change.newStatus,
                newHubSpotStage: targetStageId,
              });
              await storage.createAuditLog({
                action: "hubspot_stage_sync",
                entityType: "deal",
                entityId: deal.hubspotId,
                source: "bidboard_import",
                status: "success",
                details: {
                  dealName: deal.dealName,
                  oldBidBoardStatus: change.oldStatus,
                  newBidBoardStatus: change.newStatus,
                  newHubSpotStageId: targetStageId,
                },
              });
            } else {
              hubspotSyncResult.failed++;
              hubspotSyncResult.details.push({
                name: change.name,
                hubspotId: deal.hubspotId,
                status: "failed",
                error: result.message,
              });
            }
          }
        }
      }

      await storage.createAuditLog({
        action: "bidboard_import",
        entityType: "bidboard",
        entityId: null,
        source: "upload",
        status: "success",
        details: {
          imported, matched, unmatched, totalRows: rows.length,
          statusChanges: statusChanges.length,
          hubspotSync: hubspotSyncResult,
        },
      });

      res.json({
        success: true, imported, matched, unmatched, totalRows: rows.length,
        statusChanges: statusChanges.length,
        hubspotSync: hubspotSyncResult,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bidboard/estimates", requireAuth, async (req, res) => {
    try {
      const result = await storage.getBidboardEstimates({
        search: req.query.search as string,
        status: req.query.status as string,
        matchStatus: req.query.matchStatus as string,
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/bidboard/count", requireAuth, async (_req, res) => {
    try {
      const count = await storage.getBidboardEstimateCount();
      res.json({ count });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/stage-mapping/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("bidboard_hubspot_stage_mapping");
      res.json(config?.value || { mappings: {}, enabled: false });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/stage-mapping/config", requireAuth, async (req, res) => {
    try {
      const { mappings, enabled } = req.body;
      await storage.upsertAutomationConfig({
        key: "bidboard_hubspot_stage_mapping",
        value: { mappings: mappings || {}, enabled: !!enabled },
        description: "Maps BidBoard estimate statuses to HubSpot deal stages",
        isActive: true,
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/stage-mapping/hubspot-stages", requireAuth, async (_req, res) => {
    try {
      const pipelines = await storage.getHubspotPipelines();
      const stages: { stageId: string; label: string; pipelineLabel: string }[] = [];
      for (const p of pipelines) {
        const pStages = (p.stages as any[]) || [];
        for (const s of pStages) {
          stages.push({ stageId: s.stageId, label: s.label, pipelineLabel: p.label });
        }
      }
      res.json(stages);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/stage-mapping/bidboard-statuses", requireAuth, async (_req, res) => {
    try {
      const result = await storage.getBidboardDistinctStatuses();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), version: "2.0.0" });
  });

  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let pollingRunning = false;
  let lastPollAt: Date | null = null;
  let lastPollResult: any = null;

  async function runPollingCycle() {
    if (pollingRunning) {
      console.log('[Polling] Skipping — previous cycle still running');
      return;
    }
    pollingRunning = true;
    console.log('[Polling] Starting HubSpot sync cycle...');
    try {
      const result = await runFullHubSpotSync();
      let procoreAutoSync = null;
      try {
        procoreAutoSync = await triggerPostSyncProcoreUpdates({
          companies: result.companies,
          contacts: result.contacts,
        });
      } catch (autoErr: any) {
        console.error('[Polling] Procore auto-sync failed:', autoErr.message);
        procoreAutoSync = { error: autoErr.message };
      }

      lastPollAt = new Date();
      lastPollResult = {
        companies: result.companies,
        contacts: result.contacts,
        deals: result.deals,
        procoreAutoSync,
        duration: result.duration,
      };

      const hasChanges = result.companies.created > 0 || result.companies.updated > 0 ||
        result.contacts.created > 0 || result.contacts.updated > 0;

      if (hasChanges) {
        await storage.createAuditLog({
          action: 'hubspot_polling_sync',
          entityType: 'all',
          source: 'polling',
          status: 'success',
          details: lastPollResult as any,
          durationMs: result.duration,
        });
      }

      console.log(`[Polling] Complete in ${(result.duration / 1000).toFixed(1)}s — Companies: ${result.companies.created} new, ${result.companies.updated} updated | Contacts: ${result.contacts.created} new, ${result.contacts.updated} updated`);
    } catch (e: any) {
      console.error('[Polling] HubSpot sync failed:', e.message);
      lastPollAt = new Date();
      lastPollResult = { error: e.message };
    } finally {
      pollingRunning = false;
    }
  }

  async function startPolling(intervalMinutes: number) {
    stopPolling();
    console.log(`[Polling] Starting automatic HubSpot sync every ${intervalMinutes} minutes`);
    pollingTimer = setInterval(() => runPollingCycle(), intervalMinutes * 60 * 1000);
    setTimeout(() => runPollingCycle(), 5000);
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
      console.log('[Polling] Stopped automatic HubSpot sync');
    }
  }

  app.get("/api/automation/polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("hubspot_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 10,
        isRunning: pollingTimer !== null,
        lastPollAt: lastPollAt?.toISOString() || null,
        lastPollResult,
        currentlyPolling: pollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = intervalMinutes || 10;
      await storage.upsertAutomationConfig({
        key: "hubspot_polling",
        value: { enabled, intervalMinutes: interval },
        description: "Automatic HubSpot polling sync configuration",
      });

      if (enabled) {
        startPolling(interval);
      } else {
        stopPolling();
      }

      res.json({ success: true, enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (pollingRunning) {
        return res.json({ message: "Sync already in progress", running: true });
      }
      runPollingCycle();
      res.json({ message: "Sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  (async () => {
    try {
      const config = await storage.getAutomationConfig("hubspot_polling");
      const val = (config?.value as any);
      if (val?.enabled) {
        startPolling(val.intervalMinutes || 10);
      }
    } catch (e) {
      console.log('[Polling] No saved config, polling disabled by default');
    }
  })();

  return httpServer;
}
