/**
 * Webhook Retry Scheduler — Daily retry of failed webhooks
 * Retries webhooks stuck in "failed" status with retryCount < maxRetries.
 */

import cron from "node-cron";
import { storage } from "../storage";
import { db } from "../db";
import { webhookLogs } from "@shared/schema";
import { eq, and, lt, sql } from "drizzle-orm";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

export function startWebhookRetryScheduler() {
  stopWebhookRetryScheduler();
  // Run daily at 4:00 AM CST
  cronTask = cron.schedule(
    "0 4 * * *",
    async () => {
      try {
        console.log("[webhook-retry] Starting daily failed webhook retry...");

        // Find failed webhooks that haven't exceeded max retries
        const failedWebhooks = await db
          .select()
          .from(webhookLogs)
          .where(
            and(
              eq(webhookLogs.status, "failed"),
              sql`${webhookLogs.retryCount} < ${webhookLogs.maxRetries}`
            )
          )
          .limit(50);

        if (failedWebhooks.length === 0) {
          console.log("[webhook-retry] No failed webhooks to retry");
          return;
        }

        console.log(`[webhook-retry] Found ${failedWebhooks.length} failed webhooks to retry`);

        let retried = 0;
        let succeeded = 0;
        let failed = 0;

        for (const wh of failedWebhooks) {
          try {
            // Increment retry count and mark as processing
            await storage.updateWebhookLog(wh.id, {
              status: "processing",
              retryCount: wh.retryCount + 1,
              errorMessage: null,
            });

            // Re-process based on source
            if (wh.source === "hubspot" && wh.payload) {
              const event = wh.payload as any;
              const objectType = event.objectType || "";
              const objectId = String(event.objectId || "");
              if (objectType === "deal" && objectId) {
                const { syncSingleHubSpotDeal } = await import("../hubspot");
                await syncSingleHubSpotDeal(objectId);
              }
            } else if (wh.source === "procore" && wh.payload) {
              const event = wh.payload as any;
              const projectId = String(event.project_id || event.resource_id || "");
              if (projectId) {
                const { fetchProcoreProjectDetail } = await import("../procore");
                await fetchProcoreProjectDetail(projectId);
              }
            }

            await storage.updateWebhookLog(wh.id, { status: "processed", processedAt: new Date(), errorMessage: null });
            succeeded++;
          } catch (err: any) {
            await storage.updateWebhookLog(wh.id, { status: "failed", errorMessage: err.message, processedAt: new Date() });
            failed++;
          }
          retried++;
        }

        console.log(`[webhook-retry] Retry complete: ${retried} attempted, ${succeeded} succeeded, ${failed} failed`);

        await storage.createAuditLog({
          action: "webhook_retry_batch",
          entityType: "system",
          source: "cron",
          status: failed === retried ? "error" : "success",
          details: { retried, succeeded, failed },
        });
      } catch (e: unknown) {
        console.error(
          "[webhook-retry] Scheduled retry failed:",
          e instanceof Error ? e.message : e
        );
      }
    },
    {
      timezone: "America/Chicago",
    }
  );
  console.log("[webhook-retry] Daily failed webhook retry scheduler started (4:00 AM CST)");
}

export function stopWebhookRetryScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
