import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { testHubSpotConnection } from "../hubspot";

export function registerDashboardRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/dashboard/stats", requireAuth, asyncHandler(async (_req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  }));

  app.get("/api/dashboard/connections", requireAuth, asyncHandler(async (_req, res) => {
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
  }));
}
