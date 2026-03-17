import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";

export function registerOAuthRoutes(app: Express, requireAuth: RequestHandler) {
  // ============= Procore OAuth =============
  app.get("/api/oauth/procore/authorize", asyncHandler(async (_req, res) => {
    const config = await storage.getAutomationConfig("procore_config");
    const clientId = (config?.value as any)?.clientId || process.env.PROCORE_CLIENT_ID;
    const env = (config?.value as any)?.environment || "production";
    const host = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;
    const redirectUri = `${host}/api/oauth/procore/callback`;
    const baseUrl = env === "sandbox" ? "https://login-sandbox.procore.com" : "https://login.procore.com";
    if (!clientId) return res.status(400).json({ message: "Procore Client ID not configured. Set PROCORE_CLIENT_ID environment variable or save credentials in settings." });
    const url = `${baseUrl}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ url });
  }));

  app.get("/api/oauth/procore/callback", asyncHandler(async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ message: "Missing authorization code" });
    const config = await storage.getAutomationConfig("procore_config");
    const clientId = (config?.value as any)?.clientId || process.env.PROCORE_CLIENT_ID;
    const clientSecret = (config?.value as any)?.clientSecret || process.env.PROCORE_CLIENT_SECRET;
    const env = (config?.value as any)?.environment || "production";
    const host = process.env.APP_URL || `http://localhost:${process.env.PORT || 5000}`;
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
  }));

  // ============= HubSpot OAuth =============
  app.get("/api/oauth/hubspot/authorize", asyncHandler(async (_req, res) => {
    const { getHubSpotAuthUrl, getHubSpotOAuthConfig } = await import("../hubspot");
    const config = getHubSpotOAuthConfig();

    if (!config.clientId) {
      return res.status(400).json({
        message: "HubSpot Client ID not configured. Set HUBSPOT_CLIENT_ID environment variable."
      });
    }

    const url = getHubSpotAuthUrl();
    console.log('[hubspot-oauth] Generated auth URL, redirecting to HubSpot...');
    res.json({ url });
  }));

  app.get("/api/oauth/hubspot/callback", asyncHandler(async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
      console.error('[hubspot-oauth] OAuth error:', error, error_description);
      return res.redirect(`/#/settings?hubspot=error&message=${encodeURIComponent(error_description as string || error as string)}`);
    }

    if (!code) {
      return res.redirect("/#/settings?hubspot=error&message=Missing%20authorization%20code");
    }

    console.log('[hubspot-oauth] Received authorization code, exchanging for tokens...');

    const { exchangeHubSpotCode } = await import("../hubspot");
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
  }));

  // ============= Microsoft OAuth (OneDrive + Outlook) =============
  app.get("/api/oauth/microsoft/authorize", asyncHandler(async (_req, res) => {
    const { getMicrosoftAuthUrl } = await import("../microsoft");
    const url = getMicrosoftAuthUrl();
    res.json({ url });
  }));

  app.get("/api/oauth/microsoft/callback", asyncHandler(async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.redirect(`/#/settings?microsoft=error&message=${encodeURIComponent(error_description as string || error as string)}`);
    }
    if (!code) {
      return res.redirect("/#/settings?microsoft=error&message=Missing%20authorization%20code");
    }

    const { exchangeMicrosoftCode } = await import("../microsoft");
    await exchangeMicrosoftCode(code as string);

    await storage.createAuditLog({
      action: "oauth_connect",
      entityType: "microsoft",
      source: "oauth",
      status: "success",
      details: { message: "Microsoft OAuth connected (OneDrive + Outlook)" },
    });

    res.redirect("/#/settings?microsoft=connected");
  }));

  app.get("/api/integrations/microsoft/status", requireAuth, asyncHandler(async (_req, res) => {
    const { isMicrosoftConnected } = await import("../microsoft");
    const status = await isMicrosoftConnected();
    res.json(status);
  }));

  app.post("/api/integrations/microsoft/disconnect", requireAuth, asyncHandler(async (_req, res) => {
    const { disconnectMicrosoft } = await import("../microsoft");
    await disconnectMicrosoft();
    res.json({ success: true });
  }));

  app.post("/api/integrations/microsoft/test", requireAuth, asyncHandler(async (_req, res) => {
    const { getMicrosoftTokens, listOneDriveFolder } = await import("../microsoft");
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
  }));

  // ============= SharePoint Configuration =============
  app.get("/api/integrations/sharepoint/config", requireAuth, asyncHandler(async (_req, res) => {
    const { getSharePointConfig, isSharePointConnected } = await import("../microsoft");
    const config = await getSharePointConfig();
    const connected = await isSharePointConnected();
    res.json({ config, connected });
  }));

  app.post("/api/integrations/sharepoint/config", requireAuth, asyncHandler(async (req, res) => {
    const { siteUrl, siteName, documentLibrary } = req.body;

    if (!siteUrl || !siteName) {
      return res.status(400).json({ message: "Site URL and Site Name are required" });
    }

    const { setSharePointConfig } = await import("../microsoft");
    await setSharePointConfig({
      siteUrl: siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      siteName,
      documentLibrary: documentLibrary || 'Documents',
    });

    res.json({ success: true });
  }));

  app.get("/api/integrations/sharepoint/sites", requireAuth, asyncHandler(async (_req, res) => {
    const { listSharePointSites, isMicrosoftConnected } = await import("../microsoft");
    const msStatus = await isMicrosoftConnected();
    if (!msStatus.connected) {
      return res.status(400).json({ message: "Microsoft not connected. Please connect Microsoft 365 first." });
    }
    const sites = await listSharePointSites();
    res.json(sites);
  }));

  app.get("/api/integrations/sharepoint/drives", requireAuth, asyncHandler(async (req, res) => {
    const { listSharePointDrives, isMicrosoftConnected, getSharePointSiteId } = await import("../microsoft");
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
  }));

  app.post("/api/integrations/sharepoint/test", requireAuth, asyncHandler(async (_req, res) => {
    const { isSharePointConnected, getSharePointConfig, listSharePointFolder } = await import("../microsoft");

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
  }));

  // ============= Google OAuth (Gmail) =============
  app.get("/api/oauth/google/authorize", asyncHandler(async (_req, res) => {
    const { getGmailAuthUrl } = await import("../gmail");
    const url = getGmailAuthUrl();
    res.json({ url });
  }));

  app.get("/api/oauth/google/callback", asyncHandler(async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) {
      return res.redirect(`/#/settings?gmail=error&message=${encodeURIComponent(error_description as string || error as string)}`);
    }
    if (!code) {
      return res.redirect("/#/settings?gmail=error&message=Missing%20authorization%20code");
    }

    const { exchangeGoogleCode } = await import("../gmail");
    await exchangeGoogleCode(code as string);

    await storage.createAuditLog({
      action: "oauth_connect",
      entityType: "gmail",
      source: "oauth",
      status: "success",
      details: { message: "Gmail OAuth connected" },
    });

    res.redirect("/#/settings?gmail=connected");
  }));

  app.get("/api/integrations/gmail/status", requireAuth, asyncHandler(async (_req, res) => {
    const { getGmailConnectionStatus } = await import("../gmail");
    const status = await getGmailConnectionStatus();
    res.json(status);
  }));

  app.post("/api/integrations/gmail/disconnect", requireAuth, asyncHandler(async (_req, res) => {
    const { disconnectGmail } = await import("../gmail");
    await disconnectGmail();
    res.json({ success: true });
  }));

  app.post("/api/integrations/gmail/test", requireAuth, asyncHandler(async (_req, res) => {
    const { getGmailConnectionStatus } = await import("../gmail");
    const status = await getGmailConnectionStatus();
    if (!status.connected) {
      return res.json({ success: false, message: "Gmail not connected" });
    }
    res.json({ success: true, message: `Connected${status.email ? ` as ${status.email}` : ''} via ${status.method}` });
  }));
}
