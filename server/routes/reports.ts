import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import {
  getRfpReportList,
  getRfpApprovalChain,
  exportRfpsToCsv,
  exportRfpsToPdfHtml,
  sendTestRfpReportEmail,
  computeNextRun,
} from "../rfp-reports";

export function registerReportsRoutes(app: Express, requireAuth: RequestHandler) {
  // ==================== RFP REPORTS ====================
  app.get("/api/reports/rfps", requireAuth, asyncHandler(async (req, res) => {
    const filters = {
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
      projectNumber: req.query.projectNumber as string,
      status: req.query.status as string,
      recipient: req.query.recipient as string,
      page: parseInt(req.query.page as string) || 1,
      limit: parseInt(req.query.limit as string) || 50,
    };
    const result = await getRfpReportList(filters);
    res.json(result);
  }));

  app.get("/api/reports/rfps/:id/changes", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid RFP ID" });
    const logs = await storage.getRfpChangeLog(id);
    res.json(logs);
  }));

  app.get("/api/reports/rfps/:id/approvals", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid RFP ID" });
    const chain = await getRfpApprovalChain(id);
    res.json(chain);
  }));

  app.get("/api/reports/export", requireAuth, asyncHandler(async (req, res) => {
    const filters = {
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
      projectNumber: req.query.projectNumber as string,
      status: req.query.status as string,
      recipient: req.query.recipient as string,
      limit: 1000,
      page: 1,
    };
    const { data } = await getRfpReportList(filters);
    const format = (req.query.format as string) || "csv";

    if (format === "csv") {
      const csv = exportRfpsToCsv(data);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="rfp-report-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } else if (format === "pdf") {
      const html = exportRfpsToPdfHtml(data);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Disposition", `attachment; filename="rfp-report-${new Date().toISOString().slice(0, 10)}.html"`);
      res.send(html);
    } else {
      res.status(400).json({ message: "Invalid format. Use format=csv or format=pdf" });
    }
  }));

  app.get("/api/reports/schedule", requireAuth, asyncHandler(async (_req, res) => {
    const config = await storage.getReportScheduleConfig();
    const nextRun = config ? computeNextRun(config) : "Not scheduled";
    res.json(config ? { ...config, nextRun } : null);
  }));

  app.get("/api/reports/schedule/next-run", requireAuth, asyncHandler(async (req, res) => {
    const enabled = req.query.enabled !== "false";
    const config = {
      enabled,
      frequency: (req.query.frequency as string) || "weekly",
      dayOfWeek: req.query.dayOfWeek != null ? parseInt(String(req.query.dayOfWeek), 10) : 1,
      timeOfDay: (req.query.timeOfDay as string) || "08:00",
      timezone: (req.query.timezone as string) || "America/Chicago",
      recipients: (req.query.recipients as string)?.split(",").filter(Boolean) ?? [],
    };
    const nextRun = computeNextRun(config);
    res.json({ nextRun });
  }));

  app.put("/api/reports/schedule", requireAuth, asyncHandler(async (req, res) => {
    const body = req.body;
    const timeOfDay = body.timeOfDay ?? body.time_of_day ?? "08:00";
    const timeStr = typeof timeOfDay === "string" ? timeOfDay : `${String(timeOfDay).padStart(2, "0")}:00`;
    const config = await storage.upsertReportScheduleConfig({
      enabled: body.enabled,
      frequency: body.frequency || "weekly",
      dayOfWeek: body.dayOfWeek ?? body.day_of_week,
      timeOfDay: timeStr as any,
      timezone: body.timezone || "America/Chicago",
      recipients: Array.isArray(body.recipients) ? body.recipients : [],
      includeRfpLog: body.includeRfpLog ?? body.include_rfp_log ?? true,
      includeChangeHistory: body.includeChangeHistory ?? body.include_change_history ?? true,
      includeApprovalSummary: body.includeApprovalSummary ?? body.include_approval_summary ?? true,
    });
    res.json(config);
  }));

  app.post("/api/reports/schedule/test", requireAuth, asyncHandler(async (req, res) => {
    let userEmail = req.body?.email;
    if (!userEmail && (req.session as any)?.userId) {
      const user = await storage.getUser((req.session as any).userId);
      if (user?.username && user.username.includes("@")) userEmail = user.username;
    }
    if (!userEmail || typeof userEmail !== "string") {
      return res.status(400).json({ message: "Pass { email: \"your@email.com\" } in the request body to receive the test email." });
    }
    const result = await sendTestRfpReportEmail(userEmail);
    if (result.success) {
      res.json({ success: true, message: "Test email sent to your address" });
    } else {
      res.status(500).json({ message: result.error || "Failed to send test email" });
    }
  }));

  // ============================================
  // Reporting Dashboard Endpoints
  // ============================================

  app.get("/api/reports/dashboard", requireAuth, asyncHandler(async (_req, res) => {
    const { getDashboardMetrics } = await import('../reporting');
    const metrics = await getDashboardMetrics();
    res.json(metrics);
  }));

  app.get("/api/reports/deals/stages", requireAuth, asyncHandler(async (_req, res) => {
    const { getDealStageDistribution } = await import('../reporting');
    const distribution = await getDealStageDistribution();
    res.json(distribution);
  }));

  app.get("/api/reports/projects/stages", requireAuth, asyncHandler(async (_req, res) => {
    const { getProjectStageDistribution } = await import('../reporting');
    const distribution = await getProjectStageDistribution();
    res.json(distribution);
  }));

  app.get("/api/reports/pipeline", requireAuth, asyncHandler(async (_req, res) => {
    const { getPipelineReport } = await import('../reporting');
    const report = await getPipelineReport();
    res.json(report);
  }));

  app.get("/api/reports/health", requireAuth, asyncHandler(async (_req, res) => {
    const { getSyncHealthReport } = await import('../reporting');
    const health = await getSyncHealthReport();
    res.json(health);
  }));

  app.get("/api/reports/activity", requireAuth, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const { getRecentActivity } = await import('../reporting');
    const activity = await getRecentActivity(limit);
    res.json(activity);
  }));

  // ============================================
  // Change Order Sync Endpoints
  // ============================================

  app.get("/api/change-orders/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const { calculateTotalContractValue } = await import('../change-order-sync');
    const contractValue = await calculateTotalContractValue(req.params.projectId);
    res.json(contractValue);
  }));

  app.post("/api/change-orders/sync/:projectId", requireAuth, asyncHandler(async (req, res) => {
    const { syncChangeOrdersToHubSpot } = await import('../change-order-sync');
    const result = await syncChangeOrdersToHubSpot(req.params.projectId);
    res.json(result);
  }));

  app.post("/api/change-orders/sync-all", requireAuth, asyncHandler(async (_req, res) => {
    const { syncAllProjectChangeOrders } = await import('../change-order-sync');
    const result = await syncAllProjectChangeOrders();
    res.json(result);
  }));
}
