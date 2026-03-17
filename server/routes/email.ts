import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { sendEmail } from "../email-service";

export function registerEmailRoutes(app: Express, requireAuth: RequestHandler) {
  app.get("/api/email/templates", requireAuth, asyncHandler(async (_req, res) => {
    const templates = await storage.getEmailTemplates();
    res.json(templates);
  }));

  app.patch("/api/email/templates/:id", requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id as string);
    const result = await storage.updateEmailTemplate(id, req.body);
    if (!result) return res.status(404).json({ message: "Template not found" });
    res.json(result);
  }));

  app.get("/api/email/send-log", requireAuth, asyncHandler(async (req, res) => {
    const { templateKey, limit, offset } = req.query;
    const result = await storage.getEmailSendLogs({
      templateKey: templateKey as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  }));

  app.get("/api/email/stats", requireAuth, asyncHandler(async (_req, res) => {
    const { getEmailStats } = await import("../email-service");
    const stats = await getEmailStats();
    res.json(stats);
  }));

  app.get("/api/email/config", requireAuth, asyncHandler(async (_req, res) => {
    const { getEmailConfig } = await import("../email-service");
    const config = await getEmailConfig();
    res.json(config);
  }));

  app.post("/api/email/config", requireAuth, asyncHandler(async (req, res) => {
    const { setEmailConfig } = await import("../email-service");
    await setEmailConfig(req.body);
    res.json({ success: true });
  }));

  app.post("/api/email/test", requireAuth, asyncHandler(async (req, res) => {
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
  }));
}
