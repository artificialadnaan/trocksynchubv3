/**
 * API Routes Orchestrator
 * =======================
 *
 * Registers all domain-specific route modules and shared middleware.
 * Split from the original monolithic routes.ts (~7,000 lines) into
 * 17 domain-specific route files for maintainability.
 *
 * @module routes
 */

import type { Express } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../db";
import { errorHandler } from "../lib/error-middleware";

// Domain route registrations
import { registerAuthRoutes } from "./auth";
import { registerDashboardRoutes } from "./dashboard";
import { registerSyncRoutes } from "./sync";
import { registerDebugRoutes } from "./debug";
import { registerOAuthRoutes } from "./oauth";
import { registerWebhookRoutes } from "./webhooks";
import { registerHubspotRoutes } from "./hubspot";
import { registerProcoreRoutes } from "./procore";
import { registerCompanycamRoutes } from "./companycam";
import { registerBidboardRoutes } from "./bidboard";
import { registerPortfolioRoutes } from "./portfolio";
import { registerEmailRoutes } from "./email";
import { registerReportsRoutes } from "./reports";
import { registerTestingRoutes } from "./testing";
import { registerRfpApprovalRoutes } from "./rfp-approval";
import { registerSettingsRoutes, initPolling } from "./settings";
import { registerCloseoutRoutes } from "./closeout";

// Existing extracted routers
import reconciliationRouter from "./reconciliation";
import { registerArchiveRoutes } from "../archive-routes";

// Schedulers
import { startRfpReportScheduler } from "../cron/reportScheduler";
import { startReconciliationScheduler } from "../cron/reconciliationScheduler";

const PgSession = connectPgSimple(session);

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.set("trust proxy", 1);

  app.use(
    session({
      store: new PgSession({ pool, createTableIfMissing: false }),
      secret: (() => {
        const s = process.env.SESSION_SECRET;
        if (!s) throw new Error("SESSION_SECRET environment variable is required");
        return s;
      })(),
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

  // Pre-existing extracted routers
  app.use("/api/reconciliation", requireAuth, reconciliationRouter);
  registerArchiveRoutes(app as any);

  // Register all domain routes
  registerAuthRoutes(app, requireAuth);
  registerDashboardRoutes(app, requireAuth);
  registerSyncRoutes(app, requireAuth);
  registerDebugRoutes(app, requireAuth);
  registerOAuthRoutes(app, requireAuth);
  registerWebhookRoutes(app, requireAuth);
  registerHubspotRoutes(app, requireAuth);
  registerProcoreRoutes(app, requireAuth);
  registerCompanycamRoutes(app, requireAuth);
  registerBidboardRoutes(app, requireAuth);
  registerPortfolioRoutes(app, requireAuth);
  registerEmailRoutes(app, requireAuth);
  registerReportsRoutes(app, requireAuth);
  registerTestingRoutes(app, requireAuth);
  registerRfpApprovalRoutes(app, requireAuth);
  registerSettingsRoutes(app, requireAuth);
  registerCloseoutRoutes(app, requireAuth);

  // Global error handler (must be registered AFTER all routes)
  app.use(errorHandler);

  // Start schedulers
  startRfpReportScheduler();
  startReconciliationScheduler();

  // Initialize polling systems from saved config
  initPolling().catch((err: any) => {
    console.error("[polling] Failed to initialize polling:", err.message);
  });

  return httpServer;
}
