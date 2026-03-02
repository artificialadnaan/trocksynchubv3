/**
 * API Routes Module
 * ==================
 * 
 * This module defines all HTTP API endpoints for the T-Rock Sync Hub.
 * It handles REST endpoints, webhook receivers, and OAuth callbacks.
 * 
 * Route Categories:
 * 
 * 1. AUTHENTICATION (/api/auth/*)
 *    - POST /api/auth/login: User login
 *    - POST /api/auth/logout: User logout
 *    - GET /api/auth/me: Current user info
 * 
 * 2. SYNC OPERATIONS (/api/sync/*)
 *    - GET /api/sync/overview: Sync statistics
 *    - GET /api/sync/mappings: All sync mappings
 *    - POST /api/sync/trigger: Trigger sync operation
 *    - POST /api/sync/link: Manual link creation
 *    - POST /api/sync/unlink: Remove link
 * 
 * 3. HUBSPOT (/api/hubspot/*)
 *    - GET /api/hubspot/deals: List deals
 *    - POST /api/hubspot/sync: Full sync
 *    - OAuth callback endpoints
 * 
 * 4. PROCORE (/api/procore/*)
 *    - GET /api/procore/projects: List projects
 *    - POST /api/procore/sync: Full sync
 *    - OAuth callback endpoints
 * 
 * 5. COMPANYCAM (/api/companycam/*)
 *    - GET /api/companycam/projects: List projects
 *    - POST /api/companycam/bulk-match: Batch matching
 *    - POST /api/companycam/sync: Full sync
 * 
 * 6. WEBHOOKS (/webhooks/*)
 *    - POST /webhooks/hubspot: HubSpot events
 *    - POST /webhooks/procore: Procore events
 * 
 * 7. PLAYWRIGHT AUTOMATION (/api/bidboard/*, /api/portfolio/*)
 *    - POST /api/bidboard/scrape: Scrape BidBoard
 *    - POST /api/portfolio/transition: Portfolio transition
 *    - Playwright testing endpoints
 * 
 * 8. SETTINGS & CONFIG (/api/settings/*, /api/automation/*)
 *    - GET/POST automation config
 *    - Email template management
 *    - Stage mapping management
 * 
 * Authentication:
 * Most endpoints require authentication via session cookie.
 * Use requireAuth middleware for protected routes.
 * Webhook endpoints use signature verification instead.
 * 
 * @module routes
 */

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
import { runFullProcoreSync, syncProcoreBidBoard, syncProcoreRoleAssignments, updateProcoreProject, updateProcoreBid, fetchProcoreBidDetail, proxyProcoreAttachment, fetchProcoreProjectStages, fetchProcoreProjectDetail } from "./procore";
import { runFullCompanycamSync } from "./companycam";
import { processHubspotWebhookForProcore, syncHubspotCompanyToProcore, syncHubspotContactToProcore, runBulkHubspotToProcoreSync, testMatchingForCompany, testMatchingForContact, triggerPostSyncProcoreUpdates } from "./hubspot-procore-sync";
import { sendRoleAssignmentEmails, sendStageChangeEmail } from "./email-notifications";
import { sendEmail } from "./email-service";
import { isGmailConnected } from "./gmail";
import { assignProjectNumber, processNewDealWebhook, getProjectNumberRegistry } from "./deal-project-number";
import { syncProcoreToHubspot, getSyncOverview, unlinkMapping, createManualMapping, getUnmatchedProjects, mapProcoreStageToHubspot, resolveHubspotStageId } from "./procore-hubspot-sync";
import { runBidBoardPolling, getAutomationStatus, enableBidBoardAutomation, manualSyncProject, onBidBoardProjectCreated, detectAndProcessNewProjects } from "./bidboard-automation";
import { testLogin as testProcoreLogin, saveProcoreCredentials, logout as logoutProcore } from "./playwright/auth";
import { runPortfolioTransition, runFullPortfolioWorkflow } from "./playwright/portfolio";
import { syncHubSpotClientToBidBoard, runBidBoardScrape } from "./playwright/bidboard";
import { syncHubSpotAttachmentsToBidBoard, syncBidBoardDocumentsToPortfolio } from "./playwright/documents";
import { closeBrowser } from "./playwright/browser";

const PgSession = connectPgSimple(session);

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.set("trust proxy", 1);

  app.use(
    session({
      store: new PgSession({ pool, createTableIfMissing: false }),
      secret: process.env.SESSION_SECRET || "trock-sync-hub-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      },
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

  app.get("/api/sync-mappings/lookup", requireAuth, async (_req, res) => {
    try {
      const mappings = await storage.getSyncMappings();
      const lookup: Record<string, { hubspotDealId: string | null; hubspotDealName: string | null; procoreProjectId: string | null; procoreProjectName: string | null; procoreProjectNumber: string | null; companycamProjectId: string | null }> = {};
      for (const m of mappings) {
        const entry = {
          hubspotDealId: m.hubspotDealId,
          hubspotDealName: m.hubspotDealName,
          procoreProjectId: m.procoreProjectId,
          procoreProjectName: m.procoreProjectName,
          procoreProjectNumber: m.procoreProjectNumber,
          companycamProjectId: m.companyCamProjectId,
        };
        if (m.procoreProjectId) {
          lookup[`procore:${m.procoreProjectId}`] = entry;
          lookup[`bidboard:${m.procoreProjectId}`] = entry;
        }
        if (m.hubspotDealId) {
          lookup[`hubspot:${m.hubspotDealId}`] = entry;
        }
        if (m.companyCamProjectId) {
          lookup[`companycam:${m.companyCamProjectId}`] = entry;
        }
      }
      res.json(lookup);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
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
    const clientId = (config?.value as any)?.clientId || process.env.PROCORE_CLIENT_ID;
    const env = (config?.value as any)?.environment || "production";
    const host = process.env.APP_URL || (process.env.REPLIT_DEV_DOMAIN ? 'https://' + process.env.REPLIT_DEV_DOMAIN : `http://localhost:${process.env.PORT || 5000}`);
    const redirectUri = `${host}/api/oauth/procore/callback`;
    const baseUrl = env === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";
    if (!clientId) return res.status(400).json({ message: "Procore Client ID not configured. Set PROCORE_CLIENT_ID environment variable or save credentials in settings." });
    const url = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ url });
  });

  app.get("/api/oauth/procore/callback", async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) return res.status(400).json({ message: "Missing authorization code" });
      const config = await storage.getAutomationConfig("procore_config");
      const clientId = (config?.value as any)?.clientId || process.env.PROCORE_CLIENT_ID;
      const clientSecret = (config?.value as any)?.clientSecret || process.env.PROCORE_CLIENT_SECRET;
      const env = (config?.value as any)?.environment || "production";
      const host = process.env.APP_URL || (process.env.REPLIT_DEV_DOMAIN ? 'https://' + process.env.REPLIT_DEV_DOMAIN : `http://localhost:${process.env.PORT || 5000}`);
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

  // ============= HubSpot OAuth =============
  app.get("/api/oauth/hubspot/authorize", async (_req, res) => {
    try {
      const { getHubSpotAuthUrl, getHubSpotOAuthConfig } = await import("./hubspot");
      const config = getHubSpotOAuthConfig();
      
      if (!config.clientId) {
        return res.status(400).json({ 
          message: "HubSpot Client ID not configured. Set HUBSPOT_CLIENT_ID environment variable." 
        });
      }
      
      const url = getHubSpotAuthUrl();
      console.log('[hubspot-oauth] Generated auth URL, redirecting to HubSpot...');
      res.json({ url });
    } catch (e: any) {
      console.error('[hubspot-oauth] Failed to generate auth URL:', e);
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/oauth/hubspot/callback", async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      
      if (error) {
        console.error('[hubspot-oauth] OAuth error:', error, error_description);
        return res.redirect(`/#/settings?hubspot=error&message=${encodeURIComponent(error_description as string || error as string)}`);
      }
      
      if (!code) {
        return res.redirect("/#/settings?hubspot=error&message=Missing%20authorization%20code");
      }

      console.log('[hubspot-oauth] Received authorization code, exchanging for tokens...');
      
      const { exchangeHubSpotCode } = await import("./hubspot");
      const tokens = await exchangeHubSpotCode(code as string);
      
      // Save tokens to database
      await storage.upsertOAuthToken({
        provider: "hubspot",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      });

      await storage.createAuditLog({
        action: "oauth_connect",
        entityType: "hubspot",
        source: "oauth",
        status: "success",
        details: { message: "HubSpot OAuth connected successfully" },
      });

      console.log('[hubspot-oauth] OAuth connection successful');
      res.redirect("/#/settings?hubspot=connected");
    } catch (e: any) {
      console.error("[hubspot-oauth] Callback error:", e);
      res.redirect("/#/settings?hubspot=error&message=" + encodeURIComponent(e.message));
    }
  });

  // ============= Microsoft OAuth (OneDrive + Outlook) =============
  app.get("/api/oauth/microsoft/authorize", async (_req, res) => {
    try {
      const { getMicrosoftAuthUrl } = await import("./microsoft");
      const url = getMicrosoftAuthUrl();
      res.json({ url });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/oauth/microsoft/callback", async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) {
        return res.redirect(`/#/settings?microsoft=error&message=${encodeURIComponent(error_description as string || error as string)}`);
      }
      if (!code) {
        return res.redirect("/#/settings?microsoft=error&message=Missing%20authorization%20code");
      }

      const { exchangeMicrosoftCode } = await import("./microsoft");
      await exchangeMicrosoftCode(code as string);

      await storage.createAuditLog({
        action: "oauth_connect",
        entityType: "microsoft",
        source: "oauth",
        status: "success",
        details: { message: "Microsoft OAuth connected (OneDrive + Outlook)" },
      });

      res.redirect("/#/settings?microsoft=connected");
    } catch (e: any) {
      console.error("[Microsoft OAuth] Callback error:", e);
      res.redirect("/#/settings?microsoft=error&message=" + encodeURIComponent(e.message));
    }
  });

  app.get("/api/integrations/microsoft/status", requireAuth, async (_req, res) => {
    try {
      const { isMicrosoftConnected } = await import("./microsoft");
      const status = await isMicrosoftConnected();
      res.json(status);
    } catch (e: any) {
      res.json({ connected: false, error: e.message });
    }
  });

  app.post("/api/integrations/microsoft/disconnect", requireAuth, async (_req, res) => {
    try {
      const { disconnectMicrosoft } = await import("./microsoft");
      await disconnectMicrosoft();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/microsoft/test", requireAuth, async (_req, res) => {
    try {
      const { getMicrosoftTokens, listOneDriveFolder } = await import("./microsoft");
      const tokens = await getMicrosoftTokens();
      if (!tokens) {
        return res.json({ success: false, message: "Microsoft not connected" });
      }

      // Test OneDrive access
      try {
        await listOneDriveFolder("");
      } catch (e: any) {
        return res.json({ success: false, message: `OneDrive access failed: ${e.message}` });
      }

      res.json({ success: true, message: `Connected as ${tokens.userEmail}` });
    } catch (e: any) {
      res.json({ success: false, message: e.message });
    }
  });

  // ============= SharePoint Configuration =============
  app.get("/api/integrations/sharepoint/config", requireAuth, async (_req, res) => {
    try {
      const { getSharePointConfig, isSharePointConnected } = await import("./microsoft");
      const config = await getSharePointConfig();
      const connected = await isSharePointConnected();
      res.json({ config, connected });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/sharepoint/config", requireAuth, async (req, res) => {
    try {
      const { siteUrl, siteName, documentLibrary } = req.body;
      
      if (!siteUrl || !siteName) {
        return res.status(400).json({ message: "Site URL and Site Name are required" });
      }

      const { setSharePointConfig } = await import("./microsoft");
      await setSharePointConfig({
        siteUrl: siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        siteName,
        documentLibrary: documentLibrary || 'Documents',
      });

      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/integrations/sharepoint/sites", requireAuth, async (_req, res) => {
    try {
      const { listSharePointSites, isMicrosoftConnected } = await import("./microsoft");
      const msStatus = await isMicrosoftConnected();
      if (!msStatus.connected) {
        return res.status(400).json({ message: "Microsoft not connected. Please connect Microsoft 365 first." });
      }
      const sites = await listSharePointSites();
      res.json(sites);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/integrations/sharepoint/drives", requireAuth, async (req, res) => {
    try {
      const { listSharePointDrives, isMicrosoftConnected, getSharePointSiteId } = await import("./microsoft");
      const msStatus = await isMicrosoftConnected();
      if (!msStatus.connected) {
        return res.status(400).json({ message: "Microsoft not connected" });
      }
      
      const siteId = req.query.siteId as string || await getSharePointSiteId();
      if (!siteId) {
        return res.status(400).json({ message: "SharePoint site not configured" });
      }
      
      const drives = await listSharePointDrives(siteId);
      res.json(drives);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/sharepoint/test", requireAuth, async (_req, res) => {
    try {
      const { isSharePointConnected, getSharePointConfig, listSharePointFolder } = await import("./microsoft");
      
      const connected = await isSharePointConnected();
      if (!connected) {
        const config = await getSharePointConfig();
        if (!config) {
          return res.json({ success: false, message: "SharePoint not configured. Please configure site URL and name." });
        }
        return res.json({ success: false, message: "Unable to connect to SharePoint site. Please verify configuration." });
      }

      // Test folder access
      try {
        await listSharePointFolder("");
        res.json({ success: true, message: "SharePoint connection verified" });
      } catch (e: any) {
        res.json({ success: false, message: `SharePoint access failed: ${e.message}` });
      }
    } catch (e: any) {
      res.json({ success: false, message: e.message });
    }
  });

  // ============= Google OAuth (Gmail) =============
  app.get("/api/oauth/google/authorize", async (_req, res) => {
    try {
      const { getGmailAuthUrl } = await import("./gmail");
      const url = getGmailAuthUrl();
      res.json({ url });
    } catch (e: any) {
      res.status(400).json({ message: e.message });
    }
  });

  app.get("/api/oauth/google/callback", async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) {
        return res.redirect(`/#/settings?gmail=error&message=${encodeURIComponent(error_description as string || error as string)}`);
      }
      if (!code) {
        return res.redirect("/#/settings?gmail=error&message=Missing%20authorization%20code");
      }

      const { exchangeGoogleCode } = await import("./gmail");
      await exchangeGoogleCode(code as string);

      await storage.createAuditLog({
        action: "oauth_connect",
        entityType: "gmail",
        source: "oauth",
        status: "success",
        details: { message: "Gmail OAuth connected" },
      });

      res.redirect("/#/settings?gmail=connected");
    } catch (e: any) {
      console.error("[Gmail OAuth] Callback error:", e);
      res.redirect("/#/settings?gmail=error&message=" + encodeURIComponent(e.message));
    }
  });

  app.get("/api/integrations/gmail/status", requireAuth, async (_req, res) => {
    try {
      const { getGmailConnectionStatus } = await import("./gmail");
      const status = await getGmailConnectionStatus();
      res.json(status);
    } catch (e: any) {
      res.json({ connected: false, error: e.message });
    }
  });

  app.post("/api/integrations/gmail/disconnect", requireAuth, async (_req, res) => {
    try {
      const { disconnectGmail } = await import("./gmail");
      await disconnectGmail();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/integrations/gmail/test", requireAuth, async (_req, res) => {
    try {
      const { getGmailConnectionStatus, isGmailConnected } = await import("./gmail");
      const status = await getGmailConnectionStatus();
      if (!status.connected) {
        return res.json({ success: false, message: "Gmail not connected" });
      }
      res.json({ success: true, message: `Connected${status.email ? ` as ${status.email}` : ''} via ${status.method}` });
    } catch (e: any) {
      res.json({ success: false, message: e.message });
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

        if (objectType === "deal" && (eventType.includes("creation") || eventType.includes("create"))) {
          try {
            await processNewDealWebhook(objectId);
          } catch (pnErr: any) {
            console.error(`[project-number] Webhook error for deal ${objectId}:`, pnErr.message);
          }
        }

        // Handle deal stage changes - trigger BidBoard project creation
        if (objectType === "deal" && eventType.includes("propertyChange")) {
          const changedProperty = event.propertyName || "";
          const newValue = event.propertyValue || "";
          
          if (changedProperty === "dealstage") {
            try {
              const { processDealStageChange } = await import("./hubspot-bidboard-trigger");
              await processDealStageChange(objectId, newValue);
            } catch (stageErr: any) {
              console.error(`[hubspot-bidboard] Stage change error for deal ${objectId}:`, stageErr.message);
            }
          }
        }

        // Handle contact events - sync contact data in real-time via webhook
        if (objectType === "contact") {
          try {
            const { syncSingleHubSpotContact, deleteHubSpotContact } = await import("./hubspot");
            if (eventType.includes("deletion") || eventType.includes("delete")) {
              await deleteHubSpotContact(objectId);
            } else {
              // creation, propertyChange, or any other contact event - fetch and sync
              await syncSingleHubSpotContact(objectId);
            }
          } catch (contactErr: any) {
            console.error(`[hubspot] Contact sync error for ${objectId}:`, contactErr.message);
          }
        }

        // Handle company events - sync company data in real-time via webhook
        if (objectType === "company") {
          try {
            const { syncSingleHubSpotCompany } = await import("./hubspot");
            if (!eventType.includes("deletion") && !eventType.includes("delete")) {
              await syncSingleHubSpotCompany(objectId);
            }
            // Note: Company deletion would require implementing deleteHubspotCompany handler
          } catch (companyErr: any) {
            console.error(`[hubspot] Company sync error for ${objectId}:`, companyErr.message);
          }
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
      const idempotencyKey = `pc_${event.id || event.resource_id}_${event.timestamp || Date.now()}`;
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

      res.status(200).json({ received: true });

      const resourceName = (event.resource_name || "").toLowerCase().replace(/\s+/g, '_');
      const eventType = (event.event_type || "").toLowerCase();

      const roleRelatedResources = ["project_role_assignments", "project_roles", "project_users"];
      if (roleRelatedResources.includes(resourceName) && (eventType === "create" || eventType === "update")) {
        if (typeof recordWebhookRoleEvent === 'function') recordWebhookRoleEvent();
        try {
          const projectId = String(event.project_id || "");
          if (projectId) {
            console.log(`[webhook] ${resourceName} ${eventType} for project ${projectId}, syncing role assignments...`);
            const result = await syncProcoreRoleAssignments([projectId]);
            if (result.newAssignments.length > 0) {
              const { sendRoleAssignmentEmails } = await import('./email-notifications');
              const emailResult = await sendRoleAssignmentEmails(result.newAssignments);
              console.log(`[webhook] Role assignment email result: ${emailResult.sent} sent, ${emailResult.skipped} skipped, ${emailResult.failed} failed`);
            }
            await storage.createAuditLog({
              action: "webhook_role_assignment_processed",
              entityType: "project_role_assignment",
              entityId: String(event.resource_id || ""),
              source: "procore",
              status: "success",
              details: { projectId, synced: result.synced, newAssignments: result.newAssignments.length, eventType },
            });
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing role assignment webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_role_assignment_processed",
            entityType: "project_role_assignment",
            entityId: String(event.resource_id || ""),
            source: "procore",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      if (resourceName === "projects" && eventType === "update") {
        try {
          const projectId = String(event.project_id || event.resource_id || "");
          if (projectId) {
            console.log(`[webhook] Project update detected for ${projectId}, checking for changes...`);

            const project = await storage.getProcoreProjectByProcoreId(projectId);
            if (!project) {
              console.log(`[webhook] Project ${projectId} not found locally, skipping change check`);
            } else {
              const { fetchProcoreProjectDetail } = await import('./procore');
              const freshProject = await fetchProcoreProjectDetail(projectId);
              
              // Check for project deactivation (status changed to inactive)
              const wasActive = project.active ?? true;
              const isNowActive = freshProject?.active ?? true;
              
              if (wasActive && !isNowActive) {
                console.log(`[webhook] Project ${project.name} (${projectId}) was DEACTIVATED - triggering archive & data extraction...`);
                
                // Update local project record first
                await storage.upsertProcoreProject({
                  ...project,
                  active: false,
                  lastSyncedAt: new Date(),
                });
                
                // Trigger archive and data extraction
                try {
                  const { runProjectCloseout } = await import('./closeout-automation');
                  const closeoutResult = await runProjectCloseout(projectId, {
                    sendSurvey: true,
                    archiveToSharePoint: true,
                    deactivateProject: false, // Already deactivated in Procore
                    updateHubSpotStage: true,
                  });
                  
                  console.log(`[webhook] Closeout automation completed for deactivated project ${projectId}:`, closeoutResult);
                  
                  await storage.createAuditLog({
                    action: 'project_deactivation_closeout',
                    entityType: 'project',
                    entityId: projectId,
                    source: 'procore',
                    status: 'success',
                    details: {
                      projectId,
                      projectName: project.name,
                      closeoutResult,
                      triggeredBy: 'procore_webhook',
                    },
                  });
                } catch (closeoutErr: any) {
                  console.error(`[webhook] Closeout automation failed for project ${projectId}:`, closeoutErr.message);
                  await storage.createAuditLog({
                    action: 'project_deactivation_closeout',
                    entityType: 'project',
                    entityId: projectId,
                    source: 'procore',
                    status: 'error',
                    errorMessage: closeoutErr.message,
                    details: { projectId, projectName: project.name },
                  });
                }
              }
              
              // Check for stage changes
              const newStage = freshProject?.project_stage?.name || freshProject?.stage_name || freshProject?.stage || null;
              const oldStage = project.projectStageName || project.stage || null;

              if (newStage && oldStage && newStage.trim() !== oldStage.trim()) {
                console.log(`[webhook] Stage change detected: "${oldStage}" → "${newStage}" for project ${project.name}`);

                await storage.upsertProcoreProject({
                  ...project,
                  stage: newStage,
                  projectStageName: newStage,
                  lastSyncedAt: new Date(),
                });

                const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
                if (mapping?.hubspotDealId) {
                  // Check if stage sync automation is enabled (disabled by default)
                  const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
                  const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;
                  
                  if (!stageSyncEnabled) {
                    console.log(`[webhook] Stage sync disabled - skipping HubSpot update for deal ${mapping.hubspotDealId}`);
                  } else {
                  // Map Procore stage to HubSpot stage label, then resolve to actual stage ID
                  const hubspotStageLabel = mapProcoreStageToHubspot(newStage);
                  const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);
                  
                  if (!resolvedStage) {
                    console.log(`[webhook] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
                    await storage.createAuditLog({
                      action: 'webhook_stage_change_processed',
                      entityType: 'project_stage',
                      entityId: projectId,
                      source: 'procore',
                      status: 'error',
                      details: { projectId, projectName: project.name, oldStage, newStage, error: `No HubSpot stage found for label: ${hubspotStageLabel}` },
                    });
                  } else {
                  const hubspotStageId = resolvedStage.stageId;
                  const hubspotStageName = resolvedStage.stageName;

                  const updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
                  console.log(`[webhook] HubSpot deal ${mapping.hubspotDealId} stage updated: ${updateResult.message}`);

                  const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);

                  const emailResult = await sendStageChangeEmail({
                    hubspotDealId: mapping.hubspotDealId,
                    dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
                    procoreProjectId: projectId,
                    procoreProjectName: project.name || 'Unknown Project',
                    oldStage: oldStage,
                    newStage: newStage,
                    hubspotStageName,
                  });

                  await storage.createAuditLog({
                    action: 'webhook_stage_change_processed',
                    entityType: 'project_stage',
                    entityId: projectId,
                    source: 'procore',
                    status: 'success',
                    details: {
                      projectId,
                      projectName: project.name,
                      oldStage,
                      newStage,
                      hubspotDealId: mapping.hubspotDealId,
                      hubspotStageId,
                      hubspotStageName,
                      hubspotUpdateSuccess: updateResult.success,
                      emailSent: emailResult.sent,
                      emailRecipient: emailResult.ownerEmail,
                    },
                  });
                  } // End resolvedStage check
                  } // End stageSyncEnabled check
                } else {
                  console.log(`[webhook] No HubSpot mapping found for project ${projectId}, stage change logged but not synced`);
                  await storage.createAuditLog({
                    action: 'webhook_stage_change_processed',
                    entityType: 'project_stage',
                    entityId: projectId,
                    source: 'procore',
                    status: 'success',
                    details: { projectId, projectName: project.name, oldStage, newStage, hubspotDealId: null, reason: 'no_hubspot_mapping' },
                  });
                }
              }
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing project stage change:`, err.message);
          await storage.createAuditLog({
            action: 'webhook_stage_change_processed',
            entityType: 'project_stage',
            entityId: String(event.resource_id || ""),
            source: 'procore',
            status: 'error',
            errorMessage: err.message,
            details: event,
          });
        }
      }

      const changeOrderResources = ['change_order', 'change_order_package', 'change_orders', 'change_order_packages'];
      if (changeOrderResources.includes(resourceName) && ['create', 'update', 'delete'].includes(eventType)) {
        try {
          const projectId = String(event.project_id || "");
          if (projectId) {
            console.log(`[webhook] Change order ${eventType} detected for project ${projectId}, syncing to HubSpot...`);
            const { handleChangeOrderWebhook } = await import('./change-order-sync');
            const result = await handleChangeOrderWebhook({
              resource_name: event.resource_name,
              event_type: eventType,
              resource_id: String(event.resource_id || ""),
              project_id: projectId,
            });
            if (result.processed) {
              console.log(`[webhook] Change order sync result:`, result.result);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing change order webhook:`, err.message);
          await storage.createAuditLog({
            action: 'webhook_change_order_processed',
            entityType: 'change_order',
            entityId: String(event.resource_id || ""),
            source: 'procore',
            status: 'error',
            errorMessage: err.message,
            details: event,
          });
        }
      }

      // Handle user events - sync user data in real-time via webhook
      if (resourceName === "users" || resourceName === "user") {
        try {
          const userId = String(event.resource_id || "");
          if (userId) {
            const { syncSingleProcoreUser } = await import("./procore");
            if (eventType === "delete") {
              await storage.deleteProcoreUser(userId);
              console.log(`[webhook] Procore user ${userId} deleted via webhook`);
            } else {
              const result = await syncSingleProcoreUser(userId);
              console.log(`[webhook] Procore user ${userId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing user webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_user_sync",
            entityType: "user",
            entityId: String(event.resource_id || ""),
            source: "procore",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });
    } catch (e: any) {
      res.status(200).json({ received: true });
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

      const resourceType = event.resource_type || event.event_type?.split('.')[0] || "unknown";
      const eventType = event.event_type || "unknown";
      const resourceId = String(event.data?.id || "");

      await storage.createAuditLog({
        action: "webhook_received",
        entityType: resourceType,
        entityId: resourceId,
        source: "companycam",
        status: "received",
        details: event,
        idempotencyKey,
      });

      // Handle user events - sync user data in real-time via webhook
      if (resourceType === "user" || eventType.startsWith("user.")) {
        try {
          if (resourceId) {
            const { syncSingleCompanycamUser } = await import("./companycam");
            // CompanyCam doesn't typically send delete events, but handle if they do
            if (eventType.includes("deleted") || eventType.includes("delete")) {
              await storage.deleteCompanycamUser(resourceId);
              console.log(`[webhook] CompanyCam user ${resourceId} deleted via webhook`);
            } else {
              const result = await syncSingleCompanycamUser(resourceId);
              console.log(`[webhook] CompanyCam user ${resourceId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing CompanyCam user webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_user_sync",
            entityType: "user",
            entityId: resourceId,
            source: "companycam",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      // Handle project events - sync project data in real-time via webhook
      if (resourceType === "project" || eventType.startsWith("project.")) {
        try {
          if (resourceId) {
            if (eventType.includes("deleted") || eventType.includes("delete")) {
              await storage.deleteCompanycamProject(resourceId);
              console.log(`[webhook] CompanyCam project ${resourceId} deleted via webhook`);
            } else {
              const { syncSingleCompanycamProject } = await import("./companycam");
              const result = await syncSingleCompanycamProject(resourceId);
              console.log(`[webhook] CompanyCam project ${resourceId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing CompanyCam project webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_project_sync",
            entityType: "project",
            entityId: resourceId,
            source: "companycam",
            status: "error",
            errorMessage: err.message,
          });
        }
      }

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
      
      // Trim whitespace from all inputs to prevent issues with copy-paste
      const trimmedClientId = clientId?.trim();
      const trimmedClientSecret = clientSecret?.trim();
      const trimmedCompanyId = companyId?.trim();
      
      if (!trimmedClientId || !trimmedClientSecret) return res.status(400).json({ message: "Client ID and Client Secret are required" });

      await storage.upsertAutomationConfig({
        key: "procore_config",
        value: {
          clientId: trimmedClientId,
          clientSecret: trimmedClientSecret,
          companyId: trimmedCompanyId,
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

  app.post("/api/procore/check-stage-change/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const localProject = await storage.getProcoreProjectByProcoreId(projectId);
      if (!localProject) return res.status(404).json({ message: "Project not found locally" });

      const freshProject = await fetchProcoreProjectDetail(projectId);
      const newStage = freshProject?.project_stage?.name || freshProject?.stage_name || freshProject?.stage || null;
      const oldStage = localProject.projectStageName || localProject.stage || null;

      const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);

      if (!newStage) {
        return res.json({ message: "No stage found on Procore project", oldStage, newStage: null, mapping: mapping?.hubspotDealId || null });
      }

      if (!oldStage || newStage.trim() === oldStage.trim()) {
        return res.json({ message: "No stage change detected", oldStage, newStage, mapping: mapping?.hubspotDealId || null });
      }

      console.log(`[manual] Stage change detected for ${localProject.name}: "${oldStage}" → "${newStage}"`);

      await storage.upsertProcoreProject({
        ...localProject,
        stage: newStage,
        projectStageName: newStage,
        lastSyncedAt: new Date(),
      });

      let hubspotUpdate = null;
      let emailResult = null;

      if (mapping?.hubspotDealId) {
        // Map Procore stage to HubSpot stage label, then resolve to actual stage ID
        const hubspotStageLabel = mapProcoreStageToHubspot(newStage);
        const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);
        
        if (!resolvedStage) {
          console.log(`[manual] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
        } else {
          const hubspotStageId = resolvedStage.stageId;
          const hubspotStageName = resolvedStage.stageName;

          hubspotUpdate = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
          const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);

          emailResult = await sendStageChangeEmail({
            hubspotDealId: mapping.hubspotDealId,
            dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
            procoreProjectId: projectId,
            procoreProjectName: localProject.name || 'Unknown Project',
            oldStage,
            newStage,
            hubspotStageName,
          });

          await storage.createAuditLog({
            action: 'manual_stage_change_processed',
            entityType: 'project_stage',
            entityId: projectId,
            source: 'manual',
            status: 'success',
            details: { projectId, projectName: localProject.name, oldStage, newStage, hubspotDealId: mapping.hubspotDealId, hubspotStageId, hubspotStageName, emailSent: emailResult?.sent },
          });
        }
      }

      res.json({
        message: "Stage change processed",
        projectName: localProject.name,
        oldStage,
        newStage,
        hubspotDealId: mapping?.hubspotDealId || null,
        hubspotUpdate,
        emailResult,
      });
    } catch (e: any) {
      console.error(`[manual] Stage change check failed:`, e.message);
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

  app.post("/api/bidboard/import-url", requireAuth, async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string') return res.status(400).json({ message: "URL is required" });

      const response = await fetch(url);
      if (!response.ok) {
        return res.status(400).json({ message: `Failed to download file: ${response.status} ${response.statusText}. The link may have expired — S3 links are only valid for about 3 minutes.` });
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const workbook = XLSX.read(buffer, { type: "buffer" });
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
                source: "bidboard_url_import",
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
        source: "url_fetch",
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
      let pipelines = await storage.getHubspotPipelines();
      
      // If no pipelines in database, try to fetch from HubSpot directly
      if (pipelines.length === 0) {
        try {
          const { syncHubSpotPipelines } = await import('./hubspot');
          pipelines = await syncHubSpotPipelines();
          console.log(`[stage-mapping] Synced ${pipelines.length} pipelines from HubSpot`);
        } catch (syncError: any) {
          console.log('[stage-mapping] Could not sync pipelines from HubSpot:', syncError.message);
        }
      }
      
      const stages: { stageId: string; label: string; pipelineLabel: string; pipelineId: string }[] = [];
      for (const p of pipelines) {
        const pStages = (p.stages as any[]) || [];
        for (const s of pStages) {
          stages.push({ 
            stageId: s.stageId, 
            label: s.label, 
            pipelineLabel: p.label,
            pipelineId: p.hubspotId 
          });
        }
      }
      res.json(stages);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });
  
  // Dedicated endpoint to refresh HubSpot pipelines
  app.post("/api/stage-mapping/refresh-hubspot-pipelines", requireAuth, async (_req, res) => {
    try {
      console.log('[refresh-pipelines] Starting pipeline refresh...');
      const { syncHubSpotPipelines } = await import('./hubspot');
      const pipelines = await syncHubSpotPipelines();
      
      const stages: { stageId: string; label: string; pipelineLabel: string; pipelineId: string }[] = [];
      for (const p of pipelines) {
        const pStages = (p.stages as any[]) || [];
        for (const s of pStages) {
          stages.push({ 
            stageId: s.stageId, 
            label: s.label, 
            pipelineLabel: p.label,
            pipelineId: p.hubspotId 
          });
        }
      }
      
      console.log('[refresh-pipelines] Complete:', pipelines.length, 'pipelines,', stages.length, 'stages');
      
      res.json({ 
        success: true, 
        message: `Synced ${pipelines.length} pipelines with ${stages.length} stages`,
        pipelines: pipelines.length,
        stages 
      });
    } catch (e: any) {
      console.error('[refresh-pipelines] Error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });
  
  // Diagnostic endpoint to debug HubSpot pipeline issues
  app.get("/api/debug/hubspot-pipelines", requireAuth, async (_req, res) => {
    const results: any = {
      timestamp: new Date().toISOString(),
      tokenStatus: 'unknown',
      apiResponse: null,
      error: null,
      databasePipelines: [],
    };
    
    try {
      // Check token status
      const token = await storage.getOAuthToken("hubspot");
      results.tokenStatus = {
        hasToken: !!token?.accessToken,
        tokenLength: token?.accessToken?.length || 0,
        tokenPrefix: token?.accessToken?.substring(0, 20) + '...',
        hasRefreshToken: !!token?.refreshToken,
        expiresAt: token?.expiresAt,
        isExpired: token?.expiresAt ? new Date(token.expiresAt).getTime() < Date.now() : 'no expiry set',
      };
      
      // Check env var
      results.envVarSet = !!process.env.HUBSPOT_ACCESS_TOKEN;
      
      // Try to fetch pipelines directly from HubSpot API
      const { getAccessToken } = await import('./hubspot');
      const accessToken = await getAccessToken();
      results.resolvedTokenLength = accessToken.length;
      results.resolvedTokenPrefix = accessToken.substring(0, 20) + '...';
      
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
    } catch (e: any) {
      results.error = e.message;
      results.errorStack = e.stack?.split('\n').slice(0, 5);
      res.json(results);
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

  app.get("/api/email/templates", requireAuth, async (_req, res) => {
    try {
      const templates = await storage.getEmailTemplates();
      res.json(templates);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/email/templates/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await storage.updateEmailTemplate(id, req.body);
      if (!result) return res.status(404).json({ message: "Template not found" });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/email/send-log", requireAuth, async (req, res) => {
    try {
      const { templateKey, limit, offset } = req.query;
      const result = await storage.getEmailSendLogs({
        templateKey: templateKey as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/email/stats", requireAuth, async (_req, res) => {
    try {
      const { getEmailStats } = await import("./email-service");
      const stats = await getEmailStats();
      res.json(stats);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/email/config", requireAuth, async (_req, res) => {
    try {
      const { getEmailConfig } = await import("./email-service");
      const config = await getEmailConfig();
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/email/config", requireAuth, async (req, res) => {
    try {
      const { setEmailConfig } = await import("./email-service");
      await setEmailConfig(req.body);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/email/test", requireAuth, async (req, res) => {
    try {
      const { to, templateKey } = req.body;
      if (!to) return res.status(400).json({ message: "Recipient email required" });
      const template = templateKey ? await storage.getEmailTemplate(templateKey) : null;
      const subject = template ? template.subject.replace(/\{\{.*?\}\}/g, '[Test Value]') : 'Test Email from T-Rock Sync Hub';
      const htmlBody = template
        ? template.bodyHtml.replace(/\{\{(\w+)\}\}/g, (_, key) => `[${key}]`)
        : '<div style="font-family: Arial; padding: 20px;"><h2>Test Email</h2><p>This is a test email from T-Rock Sync Hub. If you received this, email notifications are working correctly.</p></div>';
      const result = await sendEmail({ to, subject, htmlBody, fromName: 'T-Rock Sync Hub' });
      if (result.success) {
        res.json({ success: true, messageId: result.messageId });
      } else {
        res.status(500).json({ success: false, message: result.error });
      }
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ============= Project Archive API =============
  app.get("/api/archive/projects", requireAuth, async (_req, res) => {
    try {
      const { getArchivableProjects } = await import("./project-archive");
      const projects = await getArchivableProjects();
      res.json(projects);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/archive/project/:projectId/summary", requireAuth, async (req, res) => {
    try {
      const { getProjectDocumentSummary } = await import("./project-archive");
      const summary = await getProjectDocumentSummary(req.params.projectId);
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/archive/start", requireAuth, async (req, res) => {
    try {
      const { projectId, options } = req.body;
      if (!projectId) {
        return res.status(400).json({ message: "Project ID required" });
      }

      const { startProjectArchive } = await import("./project-archive");
      const { archiveId } = await startProjectArchive(projectId, options);
      res.json({ archiveId });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/archive/progress/:archiveId", requireAuth, async (req, res) => {
    try {
      const { getArchiveProgress } = await import("./project-archive");
      const progress = getArchiveProgress(req.params.archiveId);
      if (!progress) {
        return res.status(404).json({ message: "Archive not found" });
      }
      res.json(progress);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/archive/sharepoint/status", requireAuth, async (_req, res) => {
    try {
      const { isSharePointConnected, getSharePointConfig, isMicrosoftConnected } = await import("./microsoft");
      const microsoftStatus = await isMicrosoftConnected();
      const config = await getSharePointConfig();
      const connected = await isSharePointConnected();
      res.json({ 
        connected, 
        microsoftConnected: microsoftStatus.connected,
        email: microsoftStatus.email,
        config 
      });
    } catch (e: any) {
      res.json({ connected: false, error: e.message });
    }
  });

  // Playwright-based document export (for API-unavailable data like specs)
  app.post("/api/archive/export-via-ui", requireAuth, async (req, res) => {
    try {
      const { projectId, options } = req.body;
      if (!projectId) {
        return res.status(400).json({ message: "Project ID required" });
      }

      const { ensureLoggedIn } = await import("./playwright/auth");
      const { exportAllProjectDataViaUI } = await import("./playwright/documents");
      const fs = await import("fs/promises");
      const path = await import("path");

      // Check if Procore browser credentials are configured
      const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");
      if (!credentialsConfig?.value || !(credentialsConfig.value as any).email) {
        return res.status(400).json({
          message: "Procore browser credentials not configured. Set up in BidBoard Automation settings.",
        });
      }

      // Ensure logged in
      const loginResult = await ensureLoggedIn();
      if (!loginResult.success) {
        return res.status(500).json({ message: loginResult.error || "Failed to log in to Procore" });
      }

      // Create temp directory for exports
      const outputDir = path.join(process.cwd(), ".playwright-temp", `export-${projectId}-${Date.now()}`);
      await fs.mkdir(outputDir, { recursive: true });

      // Run UI-based exports
      const result = await exportAllProjectDataViaUI(
        loginResult.page,
        projectId,
        outputDir,
        options
      );

      res.json({
        success: result.success,
        filesExported: result.files.length,
        files: result.files.map((f) => ({
          name: f.name,
          type: f.type,
          localPath: f.localPath,
        })),
        errors: result.errors,
        outputDir,
      });
    } catch (e: any) {
      console.error("[Archive] UI export error:", e);
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/procore/sync-role-assignments", requireAuth, async (req, res) => {
    try {
      const { projectIds } = req.body || {};
      const result = await syncProcoreRoleAssignments(projectIds);
      let emailResult = { sent: 0, skipped: 0, failed: 0 };
      if (result.newAssignments.length > 0) {
        try {
          const { sendRoleAssignmentEmails } = await import('./email-notifications');
          emailResult = await sendRoleAssignmentEmails(result.newAssignments);
        } catch (emailErr: any) {
          console.error(`[procore] Email notifications failed:`, emailErr.message);
        }
      }
      res.json({ ...result, emails: emailResult });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore/role-assignments", requireAuth, async (req, res) => {
    try {
      const { search, roleName, projectId, limit, offset } = req.query;
      if (projectId) {
        const data = await storage.getProcoreRoleAssignmentsByProject(projectId as string);
        return res.json({ data, total: data.length });
      }
      const result = await storage.getProcoreRoleAssignments({
        search: search as string,
        roleName: roleName as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/procore-hubspot/sync", requireAuth, async (_req, res) => {
    try {
      const result = await syncProcoreToHubspot();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore-hubspot/overview", requireAuth, async (_req, res) => {
    try {
      const result = await getSyncOverview();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore-hubspot/mappings", requireAuth, async (req, res) => {
    try {
      const { search } = req.query;
      if (search) {
        const result = await storage.searchSyncMappings(search as string);
        return res.json({ data: result, total: result.length });
      }
      const result = await storage.getSyncMappings();
      res.json({ data: result, total: result.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/procore-hubspot/unmatched", requireAuth, async (_req, res) => {
    try {
      const result = await getUnmatchedProjects();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/procore-hubspot/manual-link", requireAuth, async (req, res) => {
    try {
      const { procoreProjectId, hubspotDealId, writeProjectNumber } = req.body;
      if (!procoreProjectId || !hubspotDealId) {
        return res.status(400).json({ message: "Both procoreProjectId and hubspotDealId are required" });
      }
      const result = await createManualMapping(procoreProjectId, hubspotDealId, writeProjectNumber !== false);
      if (!result.success) return res.status(400).json(result);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.delete("/api/procore-hubspot/mappings/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await unlinkMapping(id);
      if (!success) return res.status(404).json({ message: "Mapping not found" });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/deal-project-number/assign", requireAuth, async (req, res) => {
    try {
      const { hubspotDealId } = req.body;
      if (!hubspotDealId) return res.status(400).json({ message: "hubspotDealId is required" });
      const result = await assignProjectNumber(hubspotDealId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/deal-project-number/registry", requireAuth, async (req, res) => {
    try {
      const { search, limit, offset } = req.query;
      const result = await getProjectNumberRegistry({
        search: search as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/deal-project-number/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("deal_project_number");
      res.json(config?.value || { enabled: false });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/deal-project-number/config", requireAuth, async (req, res) => {
    try {
      await storage.upsertAutomationConfig({
        key: "deal_project_number",
        value: req.body,
        description: "Auto-assign project numbers to new HubSpot deals",
      });
      res.json({ success: true });
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

      let projectNumberResults: any[] = [];
      if (result.deals.newDealIds && result.deals.newDealIds.length > 0) {
        console.log(`[Polling] ${result.deals.newDealIds.length} new deal(s) detected, assigning project numbers...`);
        for (const dealId of result.deals.newDealIds) {
          try {
            const pnResult = await processNewDealWebhook(dealId);
            projectNumberResults.push({ dealId, result: pnResult });
          } catch (pnErr: any) {
            console.error(`[Polling] Project number assignment failed for deal ${dealId}:`, pnErr.message);
            projectNumberResults.push({ dealId, error: pnErr.message });
          }
        }
      }

      lastPollAt = new Date();
      lastPollResult = {
        companies: result.companies,
        contacts: result.contacts,
        deals: result.deals,
        procoreAutoSync,
        projectNumberResults: projectNumberResults.length > 0 ? projectNumberResults : undefined,
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
      const isAuthError = e.message?.includes('expired') || e.message?.includes('401') || e.message?.includes('Unauthorized') || e.message?.includes('EXPIRED_AUTHENTICATION');
      if (isAuthError) {
        console.error('[Polling] HubSpot auth failed (token expired or invalid) — disabling polling. Please reconnect HubSpot.');
        stopPolling();
        try {
          await storage.upsertAutomationConfig({
            key: "hubspot_polling",
            value: { enabled: false, intervalMinutes: 10, disabledReason: 'auth_expired', disabledAt: new Date().toISOString() },
            description: "Automatic HubSpot polling sync configuration",
          });
        } catch (_) {}
      }
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

  let procorePollingTimer: ReturnType<typeof setInterval> | null = null;
  let procorePollingRunning = false;
  let lastProcorePollAt: Date | null = null;
  let lastProcorePollResult: any = null;

  async function runProcorePollingCycle() {
    if (procorePollingRunning) {
      console.log('[ProcorePolling] Skipping — previous cycle still running');
      return;
    }
    procorePollingRunning = true;
    const startTime = Date.now();
    console.log('[ProcorePolling] Starting Procore data sync cycle...');
    try {
      const result = await runFullProcoreSync();
      const duration = Date.now() - startTime;
      lastProcorePollAt = new Date();
      lastProcorePollResult = { ...result, duration };

      const hasChanges = result.projects.created > 0 || result.projects.updated > 0 ||
        result.vendors.created > 0 || result.vendors.updated > 0 ||
        result.users.created > 0 || result.users.updated > 0;

      if (hasChanges) {
        await storage.createAuditLog({
          action: 'procore_polling_sync',
          entityType: 'all',
          source: 'polling',
          status: 'success',
          details: lastProcorePollResult as any,
          durationMs: duration,
        });
      }

      console.log(`[ProcorePolling] Complete in ${(duration / 1000).toFixed(1)}s — Projects: ${result.projects.created} new, ${result.projects.updated} updated | Vendors: ${result.vendors.created} new, ${result.vendors.updated} updated | Users: ${result.users.created} new, ${result.users.updated} updated`);
    } catch (e: any) {
      const isAuthError = e.message?.includes('expired') || e.message?.includes('401') || e.message?.includes('Unauthorized');
      if (isAuthError) {
        console.error('[ProcorePolling] Procore auth failed — disabling polling. Please re-authenticate Procore.');
        stopProcorePolling();
        try {
          await storage.upsertAutomationConfig({
            key: "procore_polling",
            value: { enabled: false, intervalMinutes: 15, disabledReason: 'auth_expired', disabledAt: new Date().toISOString() },
            description: "Automatic Procore data polling sync configuration",
          });
        } catch (_) {}
      }
      console.error('[ProcorePolling] Procore sync failed:', e.message);
      lastProcorePollAt = new Date();
      lastProcorePollResult = { error: e.message };
    } finally {
      procorePollingRunning = false;
    }
  }

  function startProcorePolling(intervalMinutes: number) {
    stopProcorePolling();
    console.log(`[ProcorePolling] Starting automatic Procore sync every ${intervalMinutes} minutes`);
    procorePollingTimer = setInterval(() => runProcorePollingCycle(), intervalMinutes * 60 * 1000);
    setTimeout(() => runProcorePollingCycle(), 15000);
  }

  function stopProcorePolling() {
    if (procorePollingTimer) {
      clearInterval(procorePollingTimer);
      procorePollingTimer = null;
      console.log('[ProcorePolling] Stopped automatic Procore sync');
    }
  }

  app.get("/api/automation/procore-polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("procore_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 15,
        isRunning: procorePollingTimer !== null,
        lastPollAt: lastProcorePollAt?.toISOString() || null,
        lastPollResult: lastProcorePollResult,
        currentlyPolling: procorePollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/procore-polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = intervalMinutes || 15;
      await storage.upsertAutomationConfig({
        key: "procore_polling",
        value: { enabled, intervalMinutes: interval },
        description: "Automatic Procore data polling sync configuration",
      });
      if (enabled) {
        startProcorePolling(interval);
      } else {
        stopProcorePolling();
      }
      res.json({ success: true, enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/procore-polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (procorePollingRunning) {
        return res.json({ message: "Procore sync already in progress", running: true });
      }
      runProcorePollingCycle();
      res.json({ message: "Procore sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  (async () => {
    try {
      const config = await storage.getAutomationConfig("procore_polling");
      const val = (config?.value as any);
      if (val?.enabled) {
        startProcorePolling(val.intervalMinutes || 15);
      }
    } catch (e) {
      console.log('[ProcorePolling] No saved config, Procore polling disabled by default');
    }
  })();

  let rolePollingTimer: ReturnType<typeof setInterval> | null = null;
  let rolePollingRunning = false;
  let lastRolePollAt: Date | null = null;
  let lastRolePollResult: any = null;
  let lastWebhookRoleEventAt: Date | null = null;

  async function runRolePollingCycle() {
    if (rolePollingRunning) {
      console.log('[RolePolling] Skipping — previous cycle still running');
      return;
    }
    rolePollingRunning = true;
    const startTime = Date.now();
    try {
      const result = await syncProcoreRoleAssignments();
      let emailResult = { sent: 0, skipped: 0, failed: 0 };
      if (result.newAssignments.length > 0) {
        try {
          const { sendRoleAssignmentEmails } = await import('./email-notifications');
          emailResult = await sendRoleAssignmentEmails(result.newAssignments);
        } catch (emailErr: any) {
          console.error('[RolePolling] Email notifications failed:', emailErr.message);
        }
      }
      const duration = Date.now() - startTime;
      lastRolePollAt = new Date();
      lastRolePollResult = {
        synced: result.synced,
        newAssignments: result.newAssignments.length,
        emails: emailResult,
        duration,
      };
      if (result.newAssignments.length > 0) {
        await storage.createAuditLog({
          action: 'role_assignment_polling_sync',
          entityType: 'project_role_assignment',
          source: 'polling',
          status: 'success',
          details: lastRolePollResult as any,
          durationMs: duration,
        });
        console.log(`[RolePolling] Complete in ${(duration / 1000).toFixed(1)}s — ${result.newAssignments.length} new assignments, ${emailResult.sent} emails sent`);
      } else {
        console.log(`[RolePolling] Complete in ${(duration / 1000).toFixed(1)}s — no new assignments`);
      }
    } catch (e: any) {
      console.error('[RolePolling] Role assignment sync failed:', e.message);
      lastRolePollAt = new Date();
      lastRolePollResult = { error: e.message };
    } finally {
      rolePollingRunning = false;
    }
  }

  function startRolePolling(intervalMinutes: number) {
    stopRolePolling();
    console.log(`[RolePolling] Starting automatic role assignment sync every ${intervalMinutes} minutes`);
    rolePollingTimer = setInterval(() => runRolePollingCycle(), intervalMinutes * 60 * 1000);
  }

  function stopRolePolling() {
    if (rolePollingTimer) {
      clearInterval(rolePollingTimer);
      rolePollingTimer = null;
      console.log('[RolePolling] Stopped automatic role assignment sync');
    }
  }

  function recordWebhookRoleEvent() {
    lastWebhookRoleEventAt = new Date();
  }

  app.get("/api/automation/role-polling/config", requireAuth, async (_req, res) => {
    try {
      const config = await storage.getAutomationConfig("role_assignment_polling");
      const val = (config?.value as any) || {};
      res.json({
        enabled: val.enabled || false,
        intervalMinutes: val.intervalMinutes || 5,
        isRunning: rolePollingTimer !== null,
        lastPollAt: lastRolePollAt?.toISOString() || null,
        lastPollResult: lastRolePollResult,
        currentlyPolling: rolePollingRunning,
        lastWebhookEventAt: lastWebhookRoleEventAt?.toISOString() || null,
        webhookActive: lastWebhookRoleEventAt
          ? (Date.now() - lastWebhookRoleEventAt.getTime()) < 30 * 60 * 1000
          : false,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/role-polling/config", requireAuth, async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      const interval = intervalMinutes || 5;
      await storage.upsertAutomationConfig({
        key: "role_assignment_polling",
        value: { enabled, intervalMinutes: interval },
        description: "Automatic Procore role assignment polling configuration",
      });
      if (enabled) {
        startRolePolling(interval);
      } else {
        stopRolePolling();
      }
      res.json({ success: true, enabled, intervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/automation/role-polling/trigger", requireAuth, async (_req, res) => {
    try {
      if (rolePollingRunning) {
        return res.json({ message: "Role assignment sync already in progress", running: true });
      }
      runRolePollingCycle();
      res.json({ message: "Role assignment sync triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  (async () => {
    try {
      const config = await storage.getAutomationConfig("role_assignment_polling");
      const val = (config?.value as any);
      if (val?.enabled) {
        startRolePolling(val.intervalMinutes || 5);
      }
    } catch (e) {
      console.log('[RolePolling] No saved config, role polling disabled by default');
    }
  })();

  // ============================================
  // BidBoard Playwright Automation Routes
  // ============================================

  let bidboardPollingTimer: ReturnType<typeof setInterval> | null = null;
  let lastBidboardPollAt: Date | null = null;
  let lastBidboardPollResult: any = null;
  let bidboardPollingRunning = false;

  async function runBidboardPollingCycle() {
    if (bidboardPollingRunning) {
      console.log('[BidBoardPolling] Already running, skipping');
      return;
    }

    bidboardPollingRunning = true;
    console.log('[BidBoardPolling] Starting polling cycle');
    const startTime = Date.now();

    try {
      const result = await runBidBoardPolling();
      lastBidboardPollAt = new Date();
      lastBidboardPollResult = result;

      const duration = Date.now() - startTime;
      console.log(`[BidBoardPolling] Complete in ${(duration / 1000).toFixed(1)}s — ${result.projectsScraped} projects, ${result.stageChanges.length} changes`);
    } catch (e: any) {
      console.error('[BidBoardPolling] Polling failed:', e.message);
      lastBidboardPollAt = new Date();
      lastBidboardPollResult = { error: e.message };
    } finally {
      bidboardPollingRunning = false;
    }
  }

  function startBidboardPolling(intervalMinutes: number) {
    stopBidboardPolling();
    console.log(`[BidBoardPolling] Starting automatic polling every ${intervalMinutes} minutes`);
    bidboardPollingTimer = setInterval(() => runBidboardPollingCycle(), intervalMinutes * 60 * 1000);
  }

  function stopBidboardPolling() {
    if (bidboardPollingTimer) {
      clearInterval(bidboardPollingTimer);
      bidboardPollingTimer = null;
      console.log('[BidBoardPolling] Stopped automatic polling');
    }
  }

  // BidBoard automation status
  app.get("/api/bidboard/status", requireAuth, async (_req, res) => {
    try {
      const status = await getAutomationStatus();
      res.json({
        ...status,
        isPolling: bidboardPollingTimer !== null,
        lastPollAt: lastBidboardPollAt?.toISOString() || null,
        lastPollResult: lastBidboardPollResult,
        currentlyPolling: bidboardPollingRunning,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // BidBoard automation config
  app.get("/api/bidboard/config", requireAuth, async (_req, res) => {
    try {
      const automationConfig = await storage.getAutomationConfig("bidboard_automation");
      const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");
      
      res.json({
        enabled: (automationConfig?.value as any)?.enabled || false,
        pollingIntervalMinutes: (automationConfig?.value as any)?.pollingIntervalMinutes || 60,
        hasCredentials: !!credentialsConfig?.value,
        sandbox: (credentialsConfig?.value as any)?.sandbox || false,
        email: (credentialsConfig?.value as any)?.email || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save BidBoard automation config
  app.post("/api/bidboard/config", requireAuth, async (req, res) => {
    try {
      const { enabled, pollingIntervalMinutes } = req.body;
      const interval = pollingIntervalMinutes || 60;

      await storage.upsertAutomationConfig({
        key: "bidboard_automation",
        value: { enabled, pollingIntervalMinutes: interval },
        description: "BidBoard Playwright automation configuration",
      });

      await enableBidBoardAutomation(enabled);

      if (enabled) {
        startBidboardPolling(interval);
      } else {
        stopBidboardPolling();
      }

      res.json({ success: true, enabled, pollingIntervalMinutes: interval });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Test Procore browser credentials
  app.post("/api/bidboard/test-credentials", requireAuth, async (req, res) => {
    try {
      const { email, password, sandbox } = req.body;
      const result = await testProcoreLogin(email, password, sandbox);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Save Procore browser credentials
  app.post("/api/bidboard/credentials", requireAuth, async (req, res) => {
    try {
      const { email, password, sandbox } = req.body;
      await saveProcoreCredentials(email, password, sandbox);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger immediate BidBoard poll
  app.post("/api/bidboard/poll", requireAuth, async (_req, res) => {
    try {
      if (bidboardPollingRunning) {
        return res.json({ message: "BidBoard polling already in progress", running: true });
      }
      runBidboardPollingCycle();
      res.json({ message: "BidBoard polling triggered", running: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get scraped projects
  app.get("/api/bidboard/projects", requireAuth, async (_req, res) => {
    try {
      const states = await storage.getBidboardSyncStates();
      res.json(states);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get automation logs
  app.get("/api/bidboard/logs", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const logs = await storage.getBidboardAutomationLogs(limit);
      res.json(logs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual sync project stage to HubSpot
  app.post("/api/bidboard/sync-project/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const result = await manualSyncProject(projectId);
      res.json(result || { success: false, error: "Project not found" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Push HubSpot client data to BidBoard
  app.post("/api/bidboard/push-client-data", requireAuth, async (req, res) => {
    try {
      const { projectId, hubspotDealId } = req.body;
      const result = await syncHubSpotClientToBidBoard(projectId, hubspotDealId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Setup new BidBoard project with HubSpot data (client data + attachments)
  app.post("/api/bidboard/setup-new-project", requireAuth, async (req, res) => {
    try {
      const { projectId, hubspotDealId, syncClientData, syncAttachments } = req.body;
      const result = await onBidBoardProjectCreated(projectId, hubspotDealId, {
        syncClientData,
        syncAttachments,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Detect and process new BidBoard projects
  app.post("/api/bidboard/detect-new-projects", requireAuth, async (req, res) => {
    try {
      const result = await detectAndProcessNewProjects();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create BidBoard project from HubSpot deal (manual trigger)
  app.post("/api/bidboard/create-from-deal", requireAuth, async (req, res) => {
    try {
      const { dealId, stage } = req.body;
      if (!dealId) {
        return res.status(400).json({ error: "dealId is required" });
      }
      const { triggerBidBoardCreationForDeal } = await import("./hubspot-bidboard-trigger");
      const result = await triggerBidBoardCreationForDeal(dealId, stage || "Estimate in Progress");
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get HubSpot → BidBoard auto-create configuration
  app.get("/api/bidboard/auto-create-config", requireAuth, async (req, res) => {
    try {
      const enabledConfig = await storage.getAutomationConfig("hubspot_bidboard_auto_create");
      const stagesConfig = await storage.getAutomationConfig("hubspot_bidboard_trigger_stages");
      
      res.json({
        enabled: (enabledConfig?.value as any)?.enabled || false,
        triggerStages: (stagesConfig?.value as any)?.stages || [
          { hubspotStageId: "rfp", hubspotStageLabel: "RFP", bidboardStage: "Estimate in Progress" },
          { hubspotStageId: "service_rfp", hubspotStageLabel: "Service RFP", bidboardStage: "Service – Estimating" },
        ],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Update HubSpot → BidBoard auto-create configuration
  app.post("/api/bidboard/auto-create-config", requireAuth, async (req, res) => {
    try {
      const { enabled, triggerStages } = req.body;
      
      if (typeof enabled === "boolean") {
        await storage.upsertAutomationConfig("hubspot_bidboard_auto_create", { enabled });
      }
      
      if (Array.isArray(triggerStages)) {
        await storage.upsertAutomationConfig("hubspot_bidboard_trigger_stages", { stages: triggerStages });
      }
      
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Export-based BidBoard sync (uses Procore's Excel export feature)
  app.post("/api/bidboard/export-sync", requireAuth, async (req, res) => {
    try {
      const { runBidBoardExportSync } = await import('./playwright/bidboard');
      const result = await runBidBoardExportSync();
      
      await storage.createAuditLog({
        action: "bidboard_export_sync",
        entityType: "bidboard",
        source: "playwright",
        status: result.errors.length > 0 ? "partial" : "success",
        details: {
          projectCount: result.projects.length,
          changeCount: result.changes.length,
          errors: result.errors,
        },
      });
      
      res.json({
        success: result.errors.length === 0,
        projects: result.projects.length,
        changes: result.changes,
        errors: result.errors,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Send project to Portfolio
  app.post("/api/bidboard/send-to-portfolio/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const { importToBudget, createPrimeContract, sendKickoffEmail, addClientToDirectory, clientData } = req.body;
      
      if (importToBudget || createPrimeContract || sendKickoffEmail || addClientToDirectory) {
        const result = await runFullPortfolioWorkflow(projectId, {
          importToBudget,
          createPrimeContract,
          sendKickoffEmail,
          addClientToDirectory,
          clientData,
        });
        res.json(result);
      } else {
        const result = await runPortfolioTransition(projectId);
        res.json(result);
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sync HubSpot attachments to BidBoard
  app.post("/api/bidboard/sync-documents/hubspot-to-bidboard", requireAuth, async (req, res) => {
    try {
      const { projectId, hubspotDealId } = req.body;
      const result = await syncHubSpotAttachmentsToBidBoard(projectId, hubspotDealId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sync BidBoard documents to Portfolio
  app.post("/api/bidboard/sync-documents/bidboard-to-portfolio", requireAuth, async (req, res) => {
    try {
      const { bidboardProjectId, portfolioProjectId } = req.body;
      const result = await syncBidBoardDocumentsToPortfolio(bidboardProjectId, portfolioProjectId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Logout Procore browser session
  app.post("/api/bidboard/logout", requireAuth, async (_req, res) => {
    try {
      await logoutProcore();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Close browser (cleanup)
  app.post("/api/bidboard/close-browser", requireAuth, async (_req, res) => {
    try {
      await closeBrowser();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================
  // BidBoard ↔ HubSpot Deal Linking
  // ============================================

  // Link a HubSpot deal to a BidBoard project (before portfolio)
  app.post("/api/bidboard/link-deal", requireAuth, async (req, res) => {
    try {
      const { hubspotDealId, bidboardProjectId, bidboardProjectName, hubspotDealName } = req.body;
      
      if (!hubspotDealId || !bidboardProjectId) {
        return res.status(400).json({ message: "hubspotDealId and bidboardProjectId are required" });
      }
      
      // Check if mapping already exists
      let mapping = await storage.getSyncMappingByHubspotDealId(hubspotDealId);
      
      if (mapping) {
        // Update existing mapping
        const updated = await storage.updateSyncMapping(mapping.id, {
          bidboardProjectId,
          bidboardProjectName: bidboardProjectName || mapping.bidboardProjectName,
          procoreProjectId: bidboardProjectId, // For backwards compatibility
          procoreProjectName: bidboardProjectName || mapping.procoreProjectName,
          projectPhase: 'bidboard',
          lastSyncAt: new Date(),
        });
        
        await storage.createAuditLog({
          action: "bidboard_deal_linked",
          entityType: "sync_mapping",
          entityId: String(mapping.id),
          source: "api",
          status: "success",
          details: { hubspotDealId, bidboardProjectId, action: "updated" },
        });
        
        return res.json({ success: true, mapping: updated, action: "updated" });
      }
      
      // Create new mapping
      const newMapping = await storage.createSyncMapping({
        hubspotDealId,
        hubspotDealName,
        bidboardProjectId,
        bidboardProjectName,
        procoreProjectId: bidboardProjectId,
        procoreProjectName: bidboardProjectName,
        projectPhase: 'bidboard',
        lastSyncAt: new Date(),
        lastSyncStatus: 'linked',
      });
      
      await storage.createAuditLog({
        action: "bidboard_deal_linked",
        entityType: "sync_mapping",
        entityId: String(newMapping.id),
        source: "api",
        status: "success",
        details: { hubspotDealId, bidboardProjectId, action: "created" },
      });
      
      res.json({ success: true, mapping: newMapping, action: "created" });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Transition a project from BidBoard to Portfolio
  app.post("/api/bidboard/transition-to-portfolio", requireAuth, async (req, res) => {
    try {
      const { bidboardProjectId, portfolioProjectId, portfolioProjectName } = req.body;
      
      if (!bidboardProjectId || !portfolioProjectId) {
        return res.status(400).json({ message: "bidboardProjectId and portfolioProjectId are required" });
      }
      
      const mapping = await storage.transitionToPortfolio(bidboardProjectId, portfolioProjectId, portfolioProjectName);
      
      if (!mapping) {
        return res.status(404).json({ message: "No mapping found for BidBoard project" });
      }
      
      await storage.createAuditLog({
        action: "portfolio_transition",
        entityType: "sync_mapping",
        entityId: String(mapping.id),
        source: "api",
        status: "success",
        details: { bidboardProjectId, portfolioProjectId, hubspotDealId: mapping.hubspotDealId },
      });
      
      res.json({ success: true, mapping });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Get project phase info for a HubSpot deal
  app.get("/api/deals/:dealId/project-phase", requireAuth, async (req, res) => {
    try {
      const { dealId } = req.params;
      const mapping = await storage.getSyncMappingByHubspotDealId(dealId);
      
      if (!mapping) {
        return res.json({ 
          phase: null, 
          message: "No project linked to this deal" 
        });
      }
      
      res.json({
        phase: mapping.projectPhase || 'unknown',
        bidboardProjectId: mapping.bidboardProjectId,
        bidboardProjectName: mapping.bidboardProjectName,
        portfolioProjectId: mapping.portfolioProjectId,
        portfolioProjectName: mapping.portfolioProjectName,
        sentToPortfolioAt: mapping.sentToPortfolioAt,
        // Backwards compatibility
        procoreProjectId: mapping.procoreProjectId,
        procoreProjectName: mapping.procoreProjectName,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ============================================
  // Reporting Dashboard Endpoints
  // ============================================

  // Get full dashboard metrics
  app.get("/api/reports/dashboard", requireAuth, async (req, res) => {
    try {
      const { getDashboardMetrics } = await import('./reporting');
      const metrics = await getDashboardMetrics();
      res.json(metrics);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get deal stage distribution
  app.get("/api/reports/deals/stages", requireAuth, async (req, res) => {
    try {
      const { getDealStageDistribution } = await import('./reporting');
      const distribution = await getDealStageDistribution();
      res.json(distribution);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get project stage distribution
  app.get("/api/reports/projects/stages", requireAuth, async (req, res) => {
    try {
      const { getProjectStageDistribution } = await import('./reporting');
      const distribution = await getProjectStageDistribution();
      res.json(distribution);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get pipeline report
  app.get("/api/reports/pipeline", requireAuth, async (req, res) => {
    try {
      const { getPipelineReport } = await import('./reporting');
      const report = await getPipelineReport();
      res.json(report);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get sync health report
  app.get("/api/reports/health", requireAuth, async (req, res) => {
    try {
      const { getSyncHealthReport } = await import('./reporting');
      const health = await getSyncHealthReport();
      res.json(health);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get recent activity
  app.get("/api/reports/activity", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const { getRecentActivity } = await import('./reporting');
      const activity = await getRecentActivity(limit);
      res.json(activity);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================
  // Change Order Sync Endpoints
  // ============================================

  // Get change orders for a project
  app.get("/api/change-orders/:projectId", requireAuth, async (req, res) => {
    try {
      const { calculateTotalContractValue } = await import('./change-order-sync');
      const contractValue = await calculateTotalContractValue(req.params.projectId);
      res.json(contractValue);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sync change orders to HubSpot for a specific project
  app.post("/api/change-orders/sync/:projectId", requireAuth, async (req, res) => {
    try {
      const { syncChangeOrdersToHubSpot } = await import('./change-order-sync');
      const result = await syncChangeOrdersToHubSpot(req.params.projectId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Sync all project change orders to HubSpot
  app.post("/api/change-orders/sync-all", requireAuth, async (req, res) => {
    try {
      const { syncAllProjectChangeOrders } = await import('./change-order-sync');
      const result = await syncAllProjectChangeOrders();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================
  // CompanyCam Automation Endpoints
  // ============================================

  // Find or create CompanyCam project
  app.post("/api/companycam/find-or-create", requireAuth, async (req, res) => {
    try {
      const { name, streetAddress, city, state, postalCode, hubspotDealId, procoreProjectId, dedupeThreshold } = req.body;
      const { findOrCreateCompanyCamProject } = await import('./companycam-automation');
      const result = await findOrCreateCompanyCamProject(
        { name, streetAddress, city, state, postalCode },
        { hubspotDealId, procoreProjectId, dedupeThreshold }
      );
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Link existing CompanyCam project
  app.post("/api/companycam/link", requireAuth, async (req, res) => {
    try {
      const { companycamId, hubspotDealId, procoreProjectId } = req.body;
      const { linkCompanyCamProject } = await import('./companycam-automation');
      const result = await linkCompanyCamProject(companycamId, { hubspotDealId, procoreProjectId });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Search CompanyCam projects
  app.get("/api/companycam/search", requireAuth, async (req, res) => {
    try {
      const { name, address } = req.query;
      const { searchCompanyCamProjects } = await import('./companycam-automation');
      const results = await searchCompanyCamProjects({
        name: name as string,
        address: address as string,
      });
      res.json(results);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Find duplicate CompanyCam projects
  app.get("/api/companycam/duplicates", requireAuth, async (req, res) => {
    try {
      const { findDuplicateCompanyCamProjects } = await import('./companycam-automation');
      const duplicates = await findDuplicateCompanyCamProjects();
      res.json(duplicates);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Bulk auto-match CompanyCam projects to Procore projects
  app.post("/api/companycam/bulk-match", requireAuth, async (req, res) => {
    try {
      const autoSync = req.query.autoSync === 'true';
      
      // Optionally sync CompanyCam data first
      if (autoSync) {
        console.log('[CompanyCam Bulk Match] Auto-syncing CompanyCam projects first...');
        const syncResult = await runFullCompanycamSync();
        console.log(`[CompanyCam Bulk Match] Sync complete: ${syncResult.projects?.synced || 0} projects synced`);
      }
      
      const { bulkMatchCompanyCamToProcore } = await import('./companycam-automation');
      const result = await bulkMatchCompanyCamToProcore();
      res.json(result);
    } catch (e: any) {
      console.error('[CompanyCam Bulk Match] Error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ============================================
  // Closeout and Survey Endpoints
  // ============================================

  // Get closeout surveys list
  app.get("/api/closeout/surveys", requireAuth, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const surveys = await storage.getCloseoutSurveys({ limit, offset });
      res.json(surveys);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger closeout survey for a project
  app.post("/api/closeout/survey/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const { googleReviewLink } = req.body;
      const { triggerCloseoutSurvey } = await import('./closeout-automation');
      const result = await triggerCloseoutSurvey(projectId, { googleReviewLink });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public survey submission endpoint (no auth required)
  app.get("/api/survey/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const survey = await storage.getCloseoutSurveyByToken(token);
      if (!survey) {
        return res.status(404).json({ error: 'Survey not found' });
      }
      res.json({
        projectName: survey.procoreProjectName,
        clientName: survey.clientName,
        submitted: !!survey.submittedAt,
        rating: survey.rating,
        googleReviewLink: survey.googleReviewLink,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/survey/:token/submit", async (req, res) => {
    try {
      const { token } = req.params;
      const { rating, feedback, googleReviewClicked } = req.body;
      
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be between 1 and 5' });
      }
      
      const { submitSurveyResponse } = await import('./closeout-automation');
      const result = await submitSurveyResponse(token, {
        rating,
        feedback,
        googleReviewClicked,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Run full closeout workflow
  app.post("/api/closeout/run/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const { sendSurvey, archiveToSharePoint, deactivateProject, updateHubSpotStage, googleReviewLink } = req.body;
      const { runProjectCloseout } = await import('./closeout-automation');
      const result = await runProjectCloseout(projectId, {
        sendSurvey,
        archiveToSharePoint,
        deactivateProject,
        updateHubSpotStage,
        googleReviewLink,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Deactivate project after archive
  app.post("/api/closeout/deactivate/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const { archiveId } = req.body;
      
      if (archiveId) {
        const { deactivateProjectAfterArchive } = await import('./closeout-automation');
        const result = await deactivateProjectAfterArchive(projectId, archiveId);
        res.json(result);
      } else {
        const { deactivateProject } = await import('./procore');
        await deactivateProject(projectId);
        res.json({ success: true });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== TESTING MODE ====================

  // Get testing mode status
  app.get("/api/testing/mode", requireAuth, async (req, res) => {
    try {
      const mode = await storage.getTestingMode();
      res.json(mode);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Set testing mode
  app.post("/api/testing/mode", requireAuth, async (req, res) => {
    try {
      const { enabled, testEmail } = req.body;
      await storage.setTestingMode(enabled, testEmail || 'adnaan.iqbal@gmail.com');
      
      await storage.createAuditLog({
        action: enabled ? 'testing_mode_enabled' : 'testing_mode_disabled',
        entityType: 'settings',
        source: 'admin',
        status: 'success',
        details: { testEmail: testEmail || 'adnaan.iqbal@gmail.com' },
      });
      
      res.json({ success: true, enabled, testEmail: testEmail || 'adnaan.iqbal@gmail.com' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Send test email (to verify email configuration)
  app.post("/api/testing/send-test-email", requireAuth, async (req, res) => {
    try {
      const { templateKey, testRecipient } = req.body;
      const { sendEmail, renderTemplate } = await import('./email-service');
      
      const template = await storage.getEmailTemplate(templateKey);
      if (!template) {
        return res.status(404).json({ error: `Template '${templateKey}' not found` });
      }
      
      // Sample variables for testing
      const sampleVariables: Record<string, string> = {
        assigneeName: 'Test User',
        projectName: 'Sample Project - Test',
        roleName: 'Project Manager',
        projectId: '12345678',
        companyId: '598134325683880',
        procoreUrl: 'https://us02.procore.com/webclients/host/companies/598134325683880/projects/12345678/tools/projecthome',
        hubspotUrl: 'https://app-na2.hubspot.com/contacts/245227962/objects/0-3',
        companycamUrl: 'https://app.companycam.com/projects',
        previousStage: 'Estimating',
        newStage: 'Internal Review',
        hubspotStage: 'Internal Review',
        timestamp: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        recipientName: 'Test User',
        clientName: 'Test Client Inc.',
        projectAddress: '123 Test Street, Dallas, TX 75001',
        pmName: 'John PM',
        superName: 'Mike Super',
        date: new Date().toLocaleDateString('en-US', { dateStyle: 'long' }),
        projectsScanned: '15',
        stageChanges: '3',
        portfolioTransitions: '1',
        hubspotUpdates: '2',
        bidboardUrl: 'https://us02.procore.com/webclients/host/companies/598134325683880/projects',
        hubspotDealsUrl: 'https://app-na2.hubspot.com/contacts/245227962/objects/0-3/views/all/list',
        syncHubUrl: process.env.APP_URL || 'http://localhost:5000',
        nextSyncTime: '1 hour',
        changedProjects: '',
        surveyUrl: `${process.env.APP_URL || 'http://localhost:5000'}/survey/test-token`,
        googleReviewUrl: 'https://g.page/r/YOUR_GOOGLE_REVIEW_LINK/review',
        ownerName: 'Deal Owner',
        dealName: 'Sample Deal - Test',
      };
      
      const subject = renderTemplate(template.subject, sampleVariables);
      const htmlBody = renderTemplate(template.bodyHtml, sampleVariables);
      
      const result = await sendEmail({
        to: testRecipient || 'adnaan.iqbal@gmail.com',
        subject,
        htmlBody,
        fromName: 'T-Rock Sync Hub (Test)',
      });
      
      await storage.createAuditLog({
        action: 'test_email_sent',
        entityType: 'email',
        source: 'admin',
        status: result.success ? 'success' : 'failed',
        details: { templateKey, recipient: testRecipient, provider: result.provider },
      });
      
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== PLAYWRIGHT TESTING ====================

  // Get Playwright test status
  app.get("/api/testing/playwright/status", requireAuth, async (req, res) => {
    try {
      // Check if Playwright is available and browser can launch
      const { chromium } = await import('playwright');
      let browserAvailable = false;
      let browserVersion = '';
      
      try {
        const browser = await chromium.launch({ headless: true });
        browserVersion = browser.version();
        await browser.close();
        browserAvailable = true;
      } catch (browserError: any) {
        browserAvailable = false;
      }
      
      res.json({
        playwrightInstalled: true,
        browserAvailable,
        browserVersion,
      });
    } catch (e: any) {
      res.json({
        playwrightInstalled: false,
        browserAvailable: false,
        error: e.message,
      });
    }
  });

  // Run Playwright BidBoard test - capture a screenshot of BidBoard to verify selectors
  app.post("/api/testing/playwright/bidboard-screenshot", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.body;
      const { chromium } = await import('playwright');
      const { loginToProcore } = await import('./playwright/auth');
      
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      
      // Login to Procore
      const loggedIn = await loginToProcore(page);
      if (!loggedIn) {
        await browser.close();
        return res.status(400).json({ error: 'Failed to login to Procore' });
      }
      
      // Navigate to BidBoard (Estimating)
      // Procore URL structure: /webclients/host/companies/{companyId}/tools/bid-board for BidBoard list
      // or /webclients/host/companies/{companyId}/projects/{projectId}/tools/estimating for specific project
      const companyId = '598134325683880';
      const bidboardUrl = projectId
        ? `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/estimating`
        : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board`;

      console.log(`[playwright] Navigating to BidBoard: ${bidboardUrl}`);
      await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      // Take screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      const base64 = screenshotBuffer.toString('base64');
      
      await browser.close();
      
      await storage.createAuditLog({
        action: 'playwright_test_bidboard_screenshot',
        entityType: 'playwright',
        source: 'admin',
        status: 'success',
        details: { projectId, url: bidboardUrl },
      });
      
      res.json({
        success: true,
        screenshot: `data:image/png;base64,${base64}`,
        url: bidboardUrl,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Run Playwright test to extract BidBoard project data
  app.post("/api/testing/playwright/bidboard-extract", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId is required' });
      }
      
      const { chromium } = await import('playwright');
      const { loginToProcore } = await import('./playwright/auth');
      const { getBidBoardUrlNew, getPortfolioProjectUrlNew } = await import('./playwright/selectors');
      
      // Get company ID from config
      const procoreConfig = await storage.getAutomationConfig("procore_config");
      const companyId = (procoreConfig?.value as any)?.companyId;
      if (!companyId) {
        return res.status(400).json({ error: 'Procore company ID not configured' });
      }
      
      const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");
      const sandbox = (credentialsConfig?.value as any)?.sandbox || false;
      
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      
      const loggedIn = await loginToProcore(page);
      if (!loggedIn) {
        await browser.close();
        return res.status(400).json({ error: 'Failed to login to Procore' });
      }
      
      // Navigate to BidBoard list first
      const bidboardUrl = getBidBoardUrlNew(companyId, sandbox);
      console.log(`[bidboard-extract] Navigating to BidBoard: ${bidboardUrl}`);
      await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      // Then navigate to the specific project
      const projectUrl = getPortfolioProjectUrlNew(companyId, projectId, sandbox);
      console.log(`[bidboard-extract] Navigating to project: ${projectUrl}`);
      await page.goto(projectUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      const extractedData: Record<string, any> = {
        url: projectUrl,
        timestamp: new Date().toISOString(),
        pageTitle: await page.title(),
        elements: {},
      };
      
      // Try to extract various data points
      try {
        // Project name
        const projectNameEl = await page.$('h1, [data-testid="project-name"], .project-name');
        if (projectNameEl) {
          extractedData.elements.projectName = await projectNameEl.textContent();
        }
        
        // Stage/Status
        const stageEl = await page.$('[data-testid="project-stage"], .project-stage, .status-badge');
        if (stageEl) {
          extractedData.elements.stage = await stageEl.textContent();
        }
        
        // Documents list
        const docLinks = await page.$$('a[href*="documents"], a[href*="files"], .document-link');
        extractedData.elements.documentCount = docLinks.length;
        extractedData.elements.documents = await Promise.all(
          docLinks.slice(0, 10).map(async (link) => ({
            text: await link.textContent(),
            href: await link.getAttribute('href'),
          }))
        );
        
        // Tabs available
        const tabs = await page.$$('[role="tab"], .tab-item, nav a');
        extractedData.elements.tabs = await Promise.all(
          tabs.slice(0, 10).map(async (tab) => await tab.textContent())
        );
        
      } catch (extractError: any) {
        extractedData.extractionError = extractError.message;
      }
      
      // Take screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: false });
      extractedData.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      
      await browser.close();
      
      await storage.createAuditLog({
        action: 'playwright_test_bidboard_extract',
        entityType: 'playwright',
        source: 'admin',
        status: 'success',
        details: { projectId, elementsFound: Object.keys(extractedData.elements).length },
      });
      
      res.json({ success: true, data: extractedData });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Run Playwright test on Portfolio page
  app.post("/api/testing/playwright/portfolio-screenshot", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.body;
      const { chromium } = await import('playwright');
      const { loginToProcore } = await import('./playwright/auth');
      
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      
      const loggedIn = await loginToProcore(page);
      if (!loggedIn) {
        await browser.close();
        return res.status(400).json({ error: 'Failed to login to Procore' });
      }
      
      // Navigate to Portfolio/Project Home
      // Procore URL structure: /webclients/host/companies/{companyId}/tools/hubs/company-hub/views/portfolio for list
      // or /webclients/host/companies/{companyId}/projects/{projectId}/tools/projecthome for specific project
      const companyId = '598134325683880';
      const portfolioUrl = projectId
        ? `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/projecthome`
        : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/hubs/company-hub/views/portfolio`;

      console.log(`[playwright] Navigating to Portfolio: ${portfolioUrl}`);
      await page.goto(portfolioUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      const screenshotBuffer = await page.screenshot({ fullPage: true });
      const base64 = screenshotBuffer.toString('base64');
      
      await browser.close();
      
      res.json({
        success: true,
        screenshot: `data:image/png;base64,${base64}`,
        url: portfolioUrl,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Test BidBoard new project form (dry run - capture screenshot without creating)
  app.post("/api/testing/playwright/bidboard-new-project-form", requireAuth, async (req, res) => {
    try {
      const { chromium } = await import('playwright');
      const { loginToProcore } = await import('./playwright/auth');
      const { PROCORE_SELECTORS, getBidBoardUrl } = await import('./playwright/selectors');
      
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();
      
      const loggedIn = await loginToProcore(page);
      if (!loggedIn) {
        await browser.close();
        return res.status(400).json({ error: 'Failed to login to Procore' });
      }

      // Get company ID from config
      const config = await storage.getAutomationConfig("procore_config");
      const companyId = (config?.value as any)?.companyId || '598134325683880';
      const credentials = await storage.getAutomationConfig("procore_browser_credentials");
      const sandbox = (credentials?.value as any)?.sandbox || false;
      
      const bidboardUrl = getBidBoardUrl(companyId, sandbox);
      await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);

      const result: any = {
        success: true,
        steps: [],
        elementsFound: {},
        screenshots: {},
      };

      // Screenshot 1: BidBoard list
      result.screenshots.bidboardList = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
      result.steps.push('Captured BidBoard list');

      // Find "Create New Project" button
      const createButton = await page.$(PROCORE_SELECTORS.bidboard.createNewProject);
      result.elementsFound.createNewProjectButton = !!createButton;
      
      if (createButton) {
        await createButton.click();
        await page.waitForTimeout(2000);
        
        // Screenshot 2: New project form
        result.screenshots.newProjectForm = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
        result.steps.push('Clicked Create New Project, captured form');

        // Check for form elements
        result.elementsFound.nameInput = !!(await page.$(PROCORE_SELECTORS.newProject.nameInput));
        result.elementsFound.stageSelect = !!(await page.$(PROCORE_SELECTORS.newProject.stageSelect));
        result.elementsFound.clientNameInput = !!(await page.$(PROCORE_SELECTORS.newProject.clientNameInput));
        result.elementsFound.createButton = !!(await page.$(PROCORE_SELECTORS.newProject.createButton));
        result.elementsFound.cancelButton = !!(await page.$(PROCORE_SELECTORS.newProject.cancelButton));

        // Click cancel to close form without creating
        const cancelButton = await page.$(PROCORE_SELECTORS.newProject.cancelButton);
        if (cancelButton) {
          await cancelButton.click();
          result.steps.push('Clicked Cancel to close form');
        }
      } else {
        result.steps.push('Create New Project button not found');
      }

      await browser.close();

      await storage.createAuditLog({
        action: 'playwright_test_new_project_form',
        entityType: 'playwright',
        source: 'admin',
        status: 'success',
        details: { elementsFound: result.elementsFound },
      });

      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Test Documents extraction - Downloads all documents as ZIP
  app.post("/api/testing/playwright/documents-extract", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId) {
        return res.status(400).json({ error: 'projectId is required' });
      }
      
      const { chromium } = await import('playwright');
      const { loginToProcore } = await import('./playwright/auth');
      const archiver = (await import('archiver')).default;
      const fs = await import('fs/promises');
      const fsSync = await import('fs');
      const path = await import('path');
      
      // Get company ID from config
      const procoreConfig = await storage.getAutomationConfig("procore_config");
      const companyId = (procoreConfig?.value as any)?.companyId;
      if (!companyId) {
        return res.status(400).json({ error: 'Procore company ID not configured' });
      }
      
      const browser = await chromium.launch({ headless: true });
      const tempDir = `.playwright-temp/docs-${projectId}-${Date.now()}`;
      await fs.mkdir(tempDir, { recursive: true });
      
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      
      const loggedIn = await loginToProcore(page);
      if (!loggedIn) {
        await browser.close();
        return res.status(400).json({ error: 'Failed to login to Procore' });
      }
      
      // Navigate to Documents tool
      const documentsUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/documents`;
      console.log(`[documents-extract] Navigating to: ${documentsUrl}`);
      await page.goto(documentsUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      
      const extractedData: Record<string, any> = {
        url: documentsUrl,
        timestamp: new Date().toISOString(),
        folders: [] as { name: string; files: { name: string; downloaded: boolean }[] }[],
        totalFiles: 0,
        downloadedFiles: 0,
      };
      
      try {
        // Scrape folder names from the left sidebar tree
        // Looking for folder items in the tree view
        const folderSelectors = [
          '.tree-item span',
          '[class*="TreeNode"] span',
          '[class*="folder-tree"] li',
          'nav[aria-label] li span',
          '.folder-list li',
          '[data-qa="folder-item"]',
          // Try to get text from visible folder names
          'span:has-text("Commitments"), span:has-text("CompanyCam"), span:has-text("Contracts"), span:has-text("Correspondence"), span:has-text("Documents"), span:has-text("Permits"), span:has-text("RFI"), span:has-text("Schedules"), span:has-text("Submittals")'
        ];
        
        let folderNames: string[] = [];
        
        // Try each selector until we find folders
        for (const selector of folderSelectors) {
          try {
            const elements = await page.$$(selector);
            if (elements.length > 0) {
              for (const el of elements) {
                const text = await el.textContent();
                if (text && text.trim() && !text.includes('\n')) {
                  const name = text.trim();
                  if (name.length > 0 && name.length < 100 && !folderNames.includes(name)) {
                    folderNames.push(name);
                  }
                }
              }
              if (folderNames.length > 0) {
                console.log(`[documents-extract] Found ${folderNames.length} folders using selector: ${selector}`);
                break;
              }
            }
          } catch {
            continue;
          }
        }
        
        // If no folders found via selectors, try scraping from the visible table
        if (folderNames.length === 0) {
          console.log('[documents-extract] Trying to scrape folders from table...');
          const rows = await page.$$('tbody tr');
          for (const row of rows) {
            const nameCell = await row.$('td:first-child');
            if (nameCell) {
              const text = await nameCell.textContent();
              // Check if it looks like a folder (has folder icon or specific styling)
              const rowClass = await row.getAttribute('class') || '';
              const hasIcon = await row.$('svg, [class*="folder"], [class*="icon"]');
              if (text && text.trim() && (hasIcon || rowClass.includes('folder'))) {
                const name = text.trim();
                if (!folderNames.includes(name)) {
                  folderNames.push(name);
                }
              }
            }
          }
        }
        
        // If still no folders found, use the visible content
        if (folderNames.length === 0) {
          console.log('[documents-extract] Extracting folder names from page content...');
          const pageText = await page.textContent('body');
          // Parse visible folder names from the screenshot we saw
          const knownFolders = ['Commitments', 'CompanyCam', 'Contracts-Admin', 'Correspondence', 
                               'Estimating Documents', 'Permits-Inspections', 'Punch-Closeout', 
                               'RFI', 'Schedules', 'Submittals', 'Weekly Construction Report'];
          for (const folder of knownFolders) {
            if (pageText && pageText.includes(folder)) {
              folderNames.push(folder);
            }
          }
        }
        
        console.log(`[documents-extract] Found folders: ${folderNames.join(', ')}`);
        
        // Process each folder
        for (const folderName of folderNames) {
          const folderData = { name: folderName, files: [] as { name: string; downloaded: boolean }[] };
          
          try {
            // Click on the folder in the sidebar or table to navigate into it
            const folderElement = await page.$(`text="${folderName}"`);
            if (folderElement) {
              await folderElement.click();
              await page.waitForTimeout(2000);
              await page.waitForLoadState('networkidle');
              
              // Now scrape files in this folder
              const fileRows = await page.$$('tbody tr');
              for (const row of fileRows) {
                const nameCell = await row.$('td:first-child');
                const text = nameCell ? await nameCell.textContent() : null;
                if (text && text.trim()) {
                  const fileName = text.trim();
                  // Skip if it looks like a folder (check for folder indicators)
                  const isFolder = await row.$('[class*="folder"]');
                  if (!isFolder && fileName !== folderName) {
                    folderData.files.push({ name: fileName, downloaded: false });
                    extractedData.totalFiles++;
                  }
                }
              }
              
              // Try to download files in this folder using bulk download if available
              const selectAll = await page.$('th input[type="checkbox"]');
              if (selectAll && folderData.files.length > 0) {
                await selectAll.click();
                await page.waitForTimeout(500);
                
                // Look for download button
                const downloadBtn = await page.$('button:has-text("Download"), [data-qa="download"]');
                if (downloadBtn) {
                  try {
                    const [download] = await Promise.all([
                      page.waitForEvent('download', { timeout: 30000 }),
                      downloadBtn.click(),
                    ]);
                    
                    const filePath = path.join(tempDir, folderName, download.suggestedFilename());
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await download.saveAs(filePath);
                    
                    extractedData.downloadedFiles++;
                    folderData.files.forEach(f => f.downloaded = true);
                    console.log(`[documents-extract] Downloaded: ${filePath}`);
                  } catch (downloadErr: any) {
                    console.log(`[documents-extract] Bulk download failed: ${downloadErr.message}`);
                  }
                }
              }
            }
          } catch (folderErr: any) {
            console.log(`[documents-extract] Error processing folder ${folderName}: ${folderErr.message}`);
          }
          
          extractedData.folders.push(folderData);
        }
        
      } catch (extractError: any) {
        extractedData.extractionError = extractError.message;
        console.error(`[documents-extract] Extraction error: ${extractError.message}`);
      }
      
      // Take a final screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: false });
      extractedData.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      
      await browser.close();
      
      // Create ZIP file if any files were downloaded
      const zipPath = `${tempDir}/documents.zip`;
      const output = fsSync.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      archive.pipe(output);
      
      // Add downloaded files to ZIP
      const downloadedFolders = await fs.readdir(tempDir);
      for (const folder of downloadedFolders) {
        if (folder === 'documents.zip') continue;
        const folderPath = path.join(tempDir, folder);
        const stat = await fs.stat(folderPath);
        if (stat.isDirectory()) {
          archive.directory(folderPath, folder);
        } else {
          archive.file(folderPath, { name: folder });
        }
      }
      
      await archive.finalize();
      
      // Wait for ZIP to be written
      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
      });
      
      // Check if ZIP has content
      const zipStat = await fs.stat(zipPath);
      if (zipStat.size > 0 && extractedData.downloadedFiles > 0) {
        // Send ZIP file as download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="project-${projectId}-documents.zip"`);
        const zipStream = fsSync.createReadStream(zipPath);
        zipStream.pipe(res);
        
        // Cleanup after sending
        zipStream.on('end', async () => {
          try {
            await fs.rm(tempDir, { recursive: true, force: true });
          } catch {}
        });
      } else {
        // No files downloaded, return extraction results as JSON
        res.json({ 
          success: true, 
          data: extractedData,
          message: 'No files were downloaded. Folders found but download may require manual intervention.',
        });
        
        // Cleanup temp directory
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {}
      }
    } catch (e: any) {
      console.error(`[documents-extract] Error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ==================== PLAYWRIGHT WORKSHOP ====================
  // Interactive Playwright testing area where users can see and control browser automation

  // Store active workshop session
  let workshopSession: {
    browser: any;
    context: any;
    page: any;
    isRecording: boolean;
    recordedActions: string[];
    startTime: Date;
  } | null = null;

  // Get workshop session status
  app.get("/api/testing/playwright/workshop/status", requireAuth, async (req, res) => {
    try {
      if (!workshopSession) {
        return res.json({ 
          active: false,
          isRecording: false,
          message: "No active workshop session"
        });
      }
      
      res.json({
        active: true,
        isRecording: workshopSession.isRecording,
        actionsRecorded: workshopSession.recordedActions.length,
        startTime: workshopSession.startTime.toISOString(),
        uptime: Math.floor((Date.now() - workshopSession.startTime.getTime()) / 1000),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start workshop session with headed browser
  app.post("/api/testing/playwright/workshop/start", requireAuth, async (req, res) => {
    try {
      const { url, loginFirst } = req.body;
      
      // Close existing session if any
      if (workshopSession) {
        try {
          await workshopSession.browser?.close();
        } catch {}
        workshopSession = null;
      }
      
      const { chromium } = await import('playwright');
      
      // Launch headed browser so user can see it
      const browser = await chromium.launch({ 
        headless: false,
        slowMo: 100,
        args: [
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      
      const context = await browser.newContext({
        viewport: null, // Use full window size
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      
      const page = await context.newPage();
      
      workshopSession = {
        browser,
        context,
        page,
        isRecording: false,
        recordedActions: [],
        startTime: new Date(),
      };
      
      // If login requested, login to Procore first
      if (loginFirst) {
        const { loginToProcore } = await import('./playwright/auth');
        const loggedIn = await loginToProcore(page);
        if (!loggedIn) {
          await browser.close();
          workshopSession = null;
          return res.status(400).json({ error: 'Failed to login to Procore' });
        }
      }
      
      // Navigate to URL if provided
      if (url) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      }
      
      // Take initial screenshot
      const screenshot = await page.screenshot({ fullPage: false });
      
      res.json({ 
        success: true,
        message: 'Workshop session started. Browser window should be visible.',
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
        currentUrl: page.url(),
      });
    } catch (e: any) {
      console.error('[workshop/start] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Stop workshop session
  app.post("/api/testing/playwright/workshop/stop", requireAuth, async (req, res) => {
    try {
      if (!workshopSession) {
        return res.json({ success: true, message: 'No active session to stop' });
      }
      
      const recordedActions = [...workshopSession.recordedActions];
      
      try {
        await workshopSession.browser?.close();
      } catch {}
      
      workshopSession = null;
      
      res.json({ 
        success: true,
        message: 'Workshop session stopped',
        recordedActions,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get current screenshot from workshop session
  app.get("/api/testing/playwright/workshop/screenshot", requireAuth, async (req, res) => {
    try {
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      const screenshot = await workshopSession.page.screenshot({ fullPage: false });
      
      res.json({
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
        currentUrl: workshopSession.page.url(),
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Navigate to URL in workshop session
  app.post("/api/testing/playwright/workshop/navigate", requireAuth, async (req, res) => {
    try {
      const { url } = req.body;
      
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }
      
      await workshopSession.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      
      const screenshot = await workshopSession.page.screenshot({ fullPage: false });
      
      // Record the action
      workshopSession.recordedActions.push(`await page.goto('${url}', { waitUntil: 'networkidle' });`);
      
      res.json({
        success: true,
        currentUrl: workshopSession.page.url(),
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Click element in workshop session
  app.post("/api/testing/playwright/workshop/click", requireAuth, async (req, res) => {
    try {
      const { selector } = req.body;
      
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      if (!selector) {
        return res.status(400).json({ error: 'Selector is required' });
      }
      
      await workshopSession.page.click(selector, { timeout: 10000 });
      await workshopSession.page.waitForTimeout(1000);
      
      const screenshot = await workshopSession.page.screenshot({ fullPage: false });
      
      // Record the action
      workshopSession.recordedActions.push(`await page.click('${selector}');`);
      
      res.json({
        success: true,
        currentUrl: workshopSession.page.url(),
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Type text in workshop session
  app.post("/api/testing/playwright/workshop/type", requireAuth, async (req, res) => {
    try {
      const { selector, text } = req.body;
      
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      if (!selector || text === undefined) {
        return res.status(400).json({ error: 'Selector and text are required' });
      }
      
      await workshopSession.page.fill(selector, text, { timeout: 10000 });
      
      const screenshot = await workshopSession.page.screenshot({ fullPage: false });
      
      // Record the action
      workshopSession.recordedActions.push(`await page.fill('${selector}', '${text}');`);
      
      res.json({
        success: true,
        currentUrl: workshopSession.page.url(),
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Run custom script in workshop session
  app.post("/api/testing/playwright/workshop/run-script", requireAuth, async (req, res) => {
    try {
      const { script } = req.body;
      
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      if (!script) {
        return res.status(400).json({ error: 'Script is required' });
      }
      
      const page = workshopSession.page;
      
      // Security: Block dangerous patterns that could enable arbitrary code execution
      const dangerousPatterns = [
        /\brequire\s*\(/i,
        /\bimport\s*\(/i,
        /\bprocess\s*\./i,
        /\bchild_process/i,
        /\bexecSync/i,
        /\bexec\s*\(/i,
        /\bspawn\s*\(/i,
        /\beval\s*\(/i,
        /\bFunction\s*\(/i,
        /\bglobal\s*\./i,
        /\bglobalThis\s*\./i,
        /\b__dirname/i,
        /\b__filename/i,
        /\bfs\s*\./i,
        /\bpath\s*\./i,
        /\bnet\s*\./i,
        /\bhttp\s*\./i,
        /\bhttps\s*\./i,
        /\bBuffer\s*\./i,
        /\bnew\s+Buffer\b/i,
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(script)) {
          return res.status(400).json({ 
            error: `Script contains disallowed pattern: ${pattern.toString()}. Only Playwright page operations are allowed.` 
          });
        }
      }
      
      // Only allow scripts that operate on the page object
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('page', script);
      
      const result = await fn(page);
      
      // Take screenshot after execution
      const screenshot = await page.screenshot({ fullPage: false });
      
      // Record the script
      workshopSession.recordedActions.push(`// Custom script:\n${script}`);
      
      res.json({
        success: true,
        result: result ?? null,
        currentUrl: page.url(),
        screenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get recorded actions as Playwright script
  app.get("/api/testing/playwright/workshop/recorded-script", requireAuth, async (req, res) => {
    try {
      if (!workshopSession) {
        return res.json({ 
          script: '// No active session\n// Start a workshop session to record actions',
          actions: [],
        });
      }
      
      const actions = workshopSession.recordedActions;
      const script = `import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  try {
    ${actions.join('\n    ')}
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
`;
      
      res.json({
        script,
        actions,
        actionsCount: actions.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Inspect element - get selectors for element at coordinates
  app.post("/api/testing/playwright/workshop/inspect", requireAuth, async (req, res) => {
    try {
      const { x, y } = req.body;
      
      if (!workshopSession || !workshopSession.page) {
        return res.status(400).json({ error: 'No active workshop session' });
      }
      
      // Get element info at coordinates
      const elementInfo = await workshopSession.page.evaluate(({ x, y }: { x: number, y: number }) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        
        const getSelector = (el: Element): string => {
          if (el.id) return `#${el.id}`;
          if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(' ').filter(c => c.trim()).slice(0, 3);
            if (classes.length) return `.${classes.join('.')}`;
          }
          return el.tagName.toLowerCase();
        };
        
        const getFullSelector = (el: Element): string => {
          const parts: string[] = [];
          let current: Element | null = el;
          while (current && current !== document.body) {
            parts.unshift(getSelector(current));
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        
        return {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          className: element.className || null,
          textContent: element.textContent?.slice(0, 100) || null,
          selector: getSelector(element),
          fullSelector: getFullSelector(element),
          attributes: Array.from(element.attributes).reduce((acc, attr) => {
            acc[attr.name] = attr.value;
            return acc;
          }, {} as Record<string, string>),
        };
      }, { x, y });
      
      res.json({
        success: true,
        element: elementInfo,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Initialize BidBoard polling on startup
  (async () => {
    try {
      const config = await storage.getAutomationConfig("bidboard_automation");
      const val = (config?.value as any);
      if (val?.enabled) {
        startBidboardPolling(val.pollingIntervalMinutes || 60);
      }
    } catch (e) {
      console.log('[BidBoardPolling] No saved config, BidBoard polling disabled by default');
    }
  })();

  return httpServer;
}
