import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { testHubSpotConnection } from "../hubspot";
import { getRateLimitStates } from "../lib/rate-limit-tracker";
import { db } from "../db";
import { auditLogs, webhookLogs } from "@shared/schema";
import { eq, desc, gte, or, sql } from "drizzle-orm";

export function registerDashboardRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/dashboard/stats", requireAuth, asyncHandler(async (_req, res) => {
    const stats = await storage.getDashboardStats();
    res.json(stats);
  }));

  app.get("/api/dashboard/connections", requireAuth, asyncHandler(async (_req, res) => {
    // Ping each API to verify live connectivity, not just token existence
    const [hubspotResult, procoreResult, companycamResult] = await Promise.allSettled([
      (async () => {
        try {
          const testResult = await testHubSpotConnection();
          return { connected: testResult.success, lastChecked: new Date().toISOString() };
        } catch { return { connected: false, lastChecked: new Date().toISOString() }; }
      })(),
      (async () => {
        try {
          const { getAccessToken } = await import("../procore");
          const token = await getAccessToken();
          const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
          const resp = await fetchWithTimeout("https://api.procore.com/rest/v1.0/me", {
            headers: { Authorization: `Bearer ${token}` },
          });
          return { connected: resp.ok, lastChecked: new Date().toISOString() };
        } catch { return { connected: false, lastChecked: new Date().toISOString() }; }
      })(),
      (async () => {
        const token = await storage.getOAuthToken("companycam");
        const ccToken = token?.accessToken || process.env.COMPANYCAM_API_TOKEN;
        if (!ccToken) return { connected: false, lastChecked: new Date().toISOString() };
        try {
          const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
          const resp = await fetchWithTimeout("https://api.companycam.com/v2/users/current", {
            headers: { Authorization: `Bearer ${ccToken}` },
          });
          return { connected: resp.ok, lastChecked: new Date().toISOString() };
        } catch { return { connected: false, lastChecked: new Date().toISOString() }; }
      })(),
    ]);

    res.json({
      hubspot: hubspotResult.status === "fulfilled" ? hubspotResult.value : { connected: false },
      procore: procoreResult.status === "fulfilled" ? procoreResult.value : { connected: false },
      companycam: companycamResult.status === "fulfilled" ? companycamResult.value : { connected: false },
    });
  }));

  app.get("/api/dashboard/rate-limits", requireAuth, asyncHandler(async (_req, res) => {
    const states = getRateLimitStates();
    res.json(states);
  }));

  // Recent failures — last 10 failed audit logs with action, entity, error, timestamp
  app.get("/api/dashboard/recent-failures", requireAuth, asyncHandler(async (_req, res) => {
    const recentAuditFailures = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        source: auditLogs.source,
        errorMessage: auditLogs.errorMessage,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(eq(auditLogs.status, "error"))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10);

    const recentWebhookFailures = await db
      .select({
        id: webhookLogs.id,
        source: webhookLogs.source,
        eventType: webhookLogs.eventType,
        resourceId: webhookLogs.resourceId,
        errorMessage: webhookLogs.errorMessage,
        retryCount: webhookLogs.retryCount,
        maxRetries: webhookLogs.maxRetries,
        createdAt: webhookLogs.createdAt,
      })
      .from(webhookLogs)
      .where(eq(webhookLogs.status, "failed"))
      .orderBy(desc(webhookLogs.createdAt))
      .limit(10);

    res.json({ auditFailures: recentAuditFailures, webhookFailures: recentWebhookFailures });
  }));

  // Last successful sync timestamp per integration
  app.get("/api/dashboard/last-sync", requireAuth, asyncHandler(async (_req, res) => {
    const sources = ["hubspot", "procore", "companycam"];
    const result: Record<string, string | null> = {};

    for (const source of sources) {
      const [log] = await db
        .select({ createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(
          eq(auditLogs.source, source),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      result[source] = log?.createdAt?.toISOString() || null;
    }

    res.json(result);
  }));

  // Deep health check — verifies DB, HubSpot, and Procore connectivity
  // No auth required so it can be called by external monitors / smoke tests
  app.get("/api/health/deep", asyncHandler(async (_req, res) => {
    const checks: Record<string, { status: "ok" | "error"; latencyMs?: number; error?: string }> = {};

    // Database check
    const dbStart = Date.now();
    try {
      await db.select({ one: sql`1` }).from(auditLogs).limit(1);
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (e: any) {
      checks.database = { status: "error", latencyMs: Date.now() - dbStart, error: e.message };
    }

    // HubSpot check
    const hsStart = Date.now();
    try {
      const hsResult = await testHubSpotConnection();
      checks.hubspot = { status: hsResult.success ? "ok" : "error", latencyMs: Date.now() - hsStart };
    } catch (e: any) {
      checks.hubspot = { status: "error", latencyMs: Date.now() - hsStart, error: e.message };
    }

    // Procore check
    const pcStart = Date.now();
    try {
      const { getAccessToken } = await import("../procore");
      const token = await getAccessToken();
      const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
      const resp = await fetchWithTimeout("https://api.procore.com/rest/v1.0/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      checks.procore = { status: resp.ok ? "ok" : "error", latencyMs: Date.now() - pcStart };
    } catch (e: any) {
      checks.procore = { status: "error", latencyMs: Date.now() - pcStart, error: e.message };
    }

    const allOk = Object.values(checks).every((c) => c.status === "ok");
    res.status(allOk ? 200 : 503).json({ status: allOk ? "healthy" : "degraded", checks });
  }));
}
