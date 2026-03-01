/**
 * T-Rock Sync Hub - Main Server Entry Point
 * ==========================================
 * 
 * This is the main entry point for the T-Rock Sync Hub application server.
 * The application synchronizes data between HubSpot CRM, Procore project management,
 * and CompanyCam photo documentation systems.
 * 
 * Key Responsibilities:
 * - Initialize Express server with middleware
 * - Register API routes and webhook handlers
 * - Serve static files in production or Vite dev server in development
 * - Provide centralized logging utility
 * - Seed default data (email templates) on startup
 * 
 * Architecture:
 * - Express.js for HTTP handling
 * - PostgreSQL for data persistence (via Drizzle ORM)
 * - Playwright for browser automation (Procore BidBoard/Portfolio)
 * - Real-time webhooks from HubSpot and Procore
 * 
 * Environment Variables:
 * - PORT: Server port (default: 5000)
 * - NODE_ENV: 'production' or 'development'
 * - DATABASE_URL: PostgreSQL connection string
 * - HUBSPOT_ACCESS_TOKEN: HubSpot API key
 * - PROCORE_CLIENT_ID/SECRET: Procore OAuth credentials
 * - COMPANYCAM_API_KEY: CompanyCam API key
 * 
 * @author T-Rock Construction
 * @version 1.0.0
 */

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { storage } from "./storage";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

/**
 * Centralized logging utility for the application.
 * Formats log messages with timestamp and source identifier.
 * Used throughout the codebase for consistent logging format.
 * 
 * @param message - The message to log
 * @param source - The source module (e.g., 'express', 'playwright', 'hubspot', 'procore')
 * 
 * @example
 * log("Successfully synced 10 projects", "procore");
 * // Output: "5:30:45 PM [procore] Successfully synced 10 projects"
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

let appReady = false;

app.get("/_health", (_req, res) => {
  res.status(200).send("ok");
});

app.use((req, res, next) => {
  if (!appReady && req.path.startsWith("/api")) {
    return res.status(503).json({ message: "Starting up..." });
  }
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

const port = parseInt(process.env.PORT || "5000", 10);
httpServer.listen(
  {
    port,
    host: "0.0.0.0",
    reusePort: true,
  },
  () => {
    log(`serving on port ${port}`);
  },
);

(async () => {
  await registerRoutes(httpServer, app);

  // Seed default email templates if they don't exist
  try {
    await storage.seedEmailTemplates();
  } catch (e) {
    console.log("[seed] Email templates seeding skipped or failed:", e);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  appReady = true;
  log("App fully initialized and ready");
})();
