import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertStageMappingSchema, insertSyncMappingSchema } from "@shared/schema";
import { z } from "zod";
import session from "express-session";
import bcrypt from "bcrypt";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { testHubSpotConnection, runFullHubSpotSync, syncHubSpotPipelines } from "./hubspot";
import { runFullProcoreSync, syncProcoreBidBoard, updateProcoreBidStatus, fetchProcoreBidDetail, proxyProcoreAttachment } from "./procore";

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

      res.json({ success: true, ...result });
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
      res.json(counts);
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

  app.patch("/api/procore/bids/:bidId/status", requireAuth, async (req, res) => {
    try {
      const { bidId } = req.params;
      const { awarded } = req.body;
      const bid = await storage.getProcoreBidByProcoreId(bidId);
      if (!bid) return res.status(404).json({ message: "Bid not found" });
      const result = await updateProcoreBidStatus(bid.projectId!, bid.bidPackageId!, bidId, awarded);
      await storage.upsertProcoreBid({
        ...bid,
        awarded: result.awarded ?? null,
        bidStatus: result.bid_status || bid.bidStatus,
        properties: result,
        procoreUpdatedAt: result.updated_at || bid.procoreUpdatedAt,
      });
      await storage.createAuditLog({
        action: "procore_bid_status_update",
        entityType: "bid",
        entityId: bidId,
        source: "procore",
        status: "success",
        details: { awarded, vendorName: bid.vendorName, bidPackageTitle: bid.bidPackageTitle },
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
        ...bid,
        awarded: detail.awarded ?? null,
        bidStatus: detail.bid_status || bid.bidStatus,
        lumpSumAmount: detail.lump_sum_amount != null ? String(detail.lump_sum_amount) : bid.lumpSumAmount,
        bidderComments: detail.bidder_comments || bid.bidderComments,
        properties: detail,
        procoreUpdatedAt: detail.updated_at || bid.procoreUpdatedAt,
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

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), version: "2.0.0" });
  });

  return httpServer;
}
