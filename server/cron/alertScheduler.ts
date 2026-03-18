/**
 * Alert Scheduler — Every 15 minutes, check for failures and send digest email
 * Queries audit_logs and webhook_logs for recent errors, sends a single digest.
 */

import cron from "node-cron";
import { storage } from "../storage";
import { db } from "../db";
import { auditLogs, webhookLogs } from "@shared/schema";
import { and, eq, gte, desc } from "drizzle-orm";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startAlertScheduler() {
  stopAlertScheduler();
  // Run every 15 minutes
  cronTask = cron.schedule("*/15 * * * *", async () => {
    try {
      // Check if alerts are enabled
      const config = await storage.getAutomationConfig("system_alert_email");
      const value = config?.value as { enabled?: boolean; recipients?: string[]; minSeverity?: string } | undefined;
      if (!value?.enabled || !value.recipients?.length) return;

      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);

      // Query recent audit log errors
      const recentAuditErrors = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.status, "error"), gte(auditLogs.createdAt, fifteenMinAgo)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(20);

      // Query recent failed webhooks
      const recentWebhookFailures = await db
        .select()
        .from(webhookLogs)
        .where(and(eq(webhookLogs.status, "failed"), gte(webhookLogs.createdAt, fifteenMinAgo)))
        .orderBy(desc(webhookLogs.createdAt))
        .limit(20);

      const totalFailures = recentAuditErrors.length + recentWebhookFailures.length;
      if (totalFailures === 0) return;

      // Dedupe: one alert per 15-minute window
      const now = new Date();
      const dedupeKey = `alert_digest_${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}_${String(now.getUTCHours()).padStart(2, "0")}-${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;
      const alreadySent = await storage.checkEmailDedupeKey(dedupeKey);
      if (alreadySent) return;

      // Build HTML digest
      const auditRows = recentAuditErrors
        .map(
          (log) =>
            `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.action}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.entityType} ${log.entityId || ""}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#dc2626;">${log.errorMessage || "Unknown error"}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.createdAt ? new Date(log.createdAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : ""}</td></tr>`
        )
        .join("");

      const webhookRows = recentWebhookFailures
        .map(
          (log) =>
            `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.source}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.eventType}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#dc2626;">${log.errorMessage || "Unknown error"}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${log.createdAt ? new Date(log.createdAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : ""}</td></tr>`
        )
        .join("");

      const htmlBody = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;max-width:700px;margin:0 auto;padding:20px;">
  <div style="background:linear-gradient(135deg,#dc2626 0%,#991b1b 100%);color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:18px;">T-Rock Sync Hub — Failure Alert</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:0.9;">${totalFailures} failure(s) detected in the last 15 minutes</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px;padding:16px;">
    ${recentAuditErrors.length > 0 ? `
    <h3 style="font-size:14px;color:#374151;margin:0 0 8px;">Audit Log Errors (${recentAuditErrors.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
      <thead><tr style="background:#f9fafb;"><th style="padding:6px 10px;text-align:left;">Action</th><th style="padding:6px 10px;text-align:left;">Entity</th><th style="padding:6px 10px;text-align:left;">Error</th><th style="padding:6px 10px;text-align:left;">Time</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>` : ""}
    ${recentWebhookFailures.length > 0 ? `
    <h3 style="font-size:14px;color:#374151;margin:0 0 8px;">Failed Webhooks (${recentWebhookFailures.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px;">
      <thead><tr style="background:#f9fafb;"><th style="padding:6px 10px;text-align:left;">Source</th><th style="padding:6px 10px;text-align:left;">Event</th><th style="padding:6px 10px;text-align:left;">Error</th><th style="padding:6px 10px;text-align:left;">Time</th></tr></thead>
      <tbody>${webhookRows}</tbody>
    </table>` : ""}
    <p style="font-size:11px;color:#9ca3af;margin:16px 0 0;">
      This is an automated alert from T-Rock Sync Hub. Check the dashboard for details.
    </p>
  </div>
</body></html>`;

      // Send to all recipients
      const { sendEmail } = await import("../email-service");
      for (const recipient of value.recipients) {
        try {
          await sendEmail({
            to: recipient,
            subject: `[Alert] ${totalFailures} failure(s) detected — T-Rock Sync Hub`,
            htmlBody,
            fromName: "T-Rock Sync Hub Alerts",
          });
        } catch (emailErr: any) {
          console.error(`[alert] Failed to send alert to ${recipient}:`, emailErr.message);
        }
      }

      // Log the dedupe key so we don't re-send
      await storage.createEmailSendLog({
        templateKey: "system_alert_digest",
        recipientEmail: value.recipients.join(", "),
        subject: `[Alert] ${totalFailures} failure(s) detected`,
        dedupeKey,
        status: "sent",
        metadata: { auditErrors: recentAuditErrors.length, webhookFailures: recentWebhookFailures.length },
      });

      console.log(`[alert] Sent failure digest: ${totalFailures} failures to ${value.recipients.length} recipients`);
    } catch (e: unknown) {
      console.error("[alert] Alert scheduler error:", e instanceof Error ? e.message : e);
    }
  });
  console.log("[alert] Failure alert scheduler started (every 15 minutes)");
}

export function stopAlertScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
