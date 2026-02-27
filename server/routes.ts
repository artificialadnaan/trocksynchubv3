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
import { syncProcoreToHubspot, getSyncOverview, unlinkMapping, createManualMapping, getUnmatchedProjects, mapProcoreStageToHubspot } from "./procore-hubspot-sync";
import { runBidBoardPolling, getAutomationStatus, enableBidBoardAutomation, manualSyncProject } from "./bidboard-automation";
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
        }
        if (m.hubspotDealId) {
          lookup[`hubspot:${m.hubspotDealId}`] = entry;
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
    const clientId = (config?.value as any)?.clientId;
    const env = (config?.value as any)?.environment || "production";
    const host = process.env.APP_URL || (process.env.REPLIT_DEV_DOMAIN ? 'https://' + process.env.REPLIT_DEV_DOMAIN : `http://localhost:${process.env.PORT || 5000}`);
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
            console.log(`[webhook] Project update detected for ${projectId}, checking for stage change...`);

            const project = await storage.getProcoreProjectByProcoreId(projectId);
            if (!project) {
              console.log(`[webhook] Project ${projectId} not found locally, skipping stage change check`);
            } else {
              const { fetchProcoreProjectDetail } = await import('./procore');
              const freshProject = await fetchProcoreProjectDetail(projectId);
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
                  const hubspotStageId = mapProcoreStageToHubspot(newStage);

                  const hubspotPipelines = await storage.getHubspotPipelines();
                  let hubspotStageName = hubspotStageId;
                  for (const pipeline of hubspotPipelines) {
                    const stages = (pipeline.stages as any[]) || [];
                    const found = stages.find((s: any) => s.stageId === hubspotStageId);
                    if (found) { hubspotStageName = found.label || found.stageName || hubspotStageId; break; }
                  }

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
        const hubspotStageId = mapProcoreStageToHubspot(newStage);
        const hubspotPipelines = await storage.getHubspotPipelines();
        let hubspotStageName = hubspotStageId;
        for (const pipeline of hubspotPipelines) {
          const stages = (pipeline.stages as any[]) || [];
          const found = stages.find((s: any) => s.stageId === hubspotStageId);
          if (found) { hubspotStageName = found.label || found.stageName || hubspotStageId; break; }
        }

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

  app.get("/api/archive/onedrive/status", requireAuth, async (_req, res) => {
    try {
      const { isMicrosoftConnected } = await import("./microsoft");
      const status = await isMicrosoftConnected();
      res.json(status);
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

  // Send project to Portfolio
  app.post("/api/bidboard/send-to-portfolio/:projectId", requireAuth, async (req, res) => {
    try {
      const { projectId } = req.params;
      const { importToBudget, createPrimeContract } = req.body;
      
      if (importToBudget || createPrimeContract) {
        const result = await runFullPortfolioWorkflow(projectId, {
          importToBudget,
          createPrimeContract,
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
