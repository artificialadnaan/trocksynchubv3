/**
 * Procore Webhook Handler
 * ========================
 *
 * Receives Procore webhook events for Projects create/update.
 * When a project is created (from "Add to Portfolio"), this triggers
 * Phase 2 of the portfolio automation.
 *
 * Webhook payload format (v4.0):
 * {
 *   "id": "01KKEZ6PX3AZJ38KKBX6RYEJSW",
 *   "reason": "create" | "update",
 *   "user_id": "15004487",
 *   "timestamp": "2026-03-11T17:30:38.082829Z",
 *   "company_id": "598134325683880",
 *   "project_id": "",  // empty on create, populated on update
 *   "resource_id": "598134326517540",
 *   "resource_type": "Projects",
 *   "payload_version": "v4.0"
 * }
 *
 * The "create" event has empty project_id but the "update" event has it populated.
 * We use the update event to trigger Phase 2 since it has the project_id.
 *
 * @module webhooks/procore-webhook
 */

import { Request, Response } from "express";
import { runPhase2WithRetry } from "../portfolio-automation-runner";
import { storage } from "../storage";
import { log } from "../index";
import {
  registerPendingPhase2,
  takeNextPendingPhase2,
} from "../orchestrator/portfolio-orchestrator";

export { registerPendingPhase2 };

// Track processed webhook IDs to avoid duplicate processing
const processedWebhooks = new Set<string>();
const MAX_PROCESSED_CACHE = 1000;

/**
 * Express route handler for Procore Projects webhook events.
 * Mount this at POST /webhooks/procore/project-events
 */
export async function handleProcoreProjectWebhook(
  req: Request,
  res: Response
): Promise<void> {
  res.status(200).json({ received: true });

  if (process.env.DISABLE_ALL_AUTOMATIONS === 'true') {
    console.log('[webhook] All automations disabled via DISABLE_ALL_AUTOMATIONS — ignoring Procore project webhook');
    return;
  }

  try {
    const payload = req.body;

    if (!payload || !payload.resource_type || !payload.resource_id) {
      log("[webhook] Invalid payload received", "webhook");
      return;
    }

    if (payload.resource_type !== "Projects") {
      return;
    }

    const webhookId =
      String(payload.id || "") ||
      `${payload.resource_id || ""}_${payload.timestamp || Date.now()}` ||
      "unknown";
    if (processedWebhooks.has(webhookId)) {
      log(`[webhook] Duplicate webhook ${webhookId}, skipping`, "webhook");
      return;
    }
    processedWebhooks.add(webhookId);
    if (processedWebhooks.size > MAX_PROCESSED_CACHE) {
      const first = processedWebhooks.values().next().value;
      if (first) processedWebhooks.delete(first);
    }

    await storage.createAuditLog({
      action: "procore_webhook_received",
      entityType: "webhook",
      entityId: webhookId || "unknown",
      source: "procore",
      status: "success",
      details: payload,
    });

    // Per-automation gate: if procore_project_webhook_processing is not enabled, log only
    const projProcessingConfig = await storage.getAutomationConfig('procore_project_webhook_processing');
    if (!(projProcessingConfig?.value as any)?.enabled) {
      log(`[webhook] Procore Projects ${payload.reason} event: resource_id=${payload.resource_id} — logged, processing disabled`, "webhook");
      return;
    }

    const resourceId = String(payload.resource_id);
    const companyId = String(payload.company_id);
    const reason = payload.reason;

    log(
      `[webhook] Projects ${reason} event: resource_id=${resourceId}, company_id=${companyId}`,
      "webhook"
    );

    if (reason === "update" && payload.project_id) {
      const portfolioProjectId = String(payload.project_id);

      const pending = takeNextPendingPhase2();
      if (pending) {
        log(
          `[webhook] Triggering Phase 2 for portfolio project ${portfolioProjectId} (bidboard: ${pending.bidboardProjectId})`,
          "webhook"
        );

        const webhookPayload = payload;
        setTimeout(async () => {
          try {
            const phase2Input =
              pending.bidboardProjectUrl || pending.proposalPdfPath != null
                ? {
                    bidboardProjectUrl: pending.bidboardProjectUrl || undefined,
                    proposalPdfPath: pending.proposalPdfPath ?? undefined,
                    customerName: pending.customerName,
                  }
                : undefined;

            const result = await runPhase2WithRetry(
              companyId,
              portfolioProjectId,
              pending.bidboardProjectId,
              phase2Input,
              { triggerSource: "webhook" }
            );

            await storage.createAuditLog({
              action: "webhook_triggered_phase2",
              entityType: "webhook",
              entityId: String(webhookPayload.id || "unknown"),
              source: "procore",
              status: result.success ? "success" : "failed",
              details: {
                webhookEventId: webhookPayload.id,
                webhookReason: webhookPayload.reason,
                portfolioProjectId,
                bidboardProjectId: pending.bidboardProjectId,
                automationSteps: result.steps.map((s) => ({ step: s.step, status: s.status })),
              },
            });

            log(
              `[webhook] Phase 2 completed: ${result.success ? "success" : "failed"} (${result.steps.length} steps)`,
              "webhook"
            );
          } catch (err: unknown) {
            log(
              `[webhook] Phase 2 failed: ${err instanceof Error ? err.message : String(err)}`,
              "webhook"
            );
          }
        }, 15000);
      } else {
        const autoConfig = await storage.getAutomationConfig("portfolio_auto_trigger");
        const autoEnabled = (autoConfig?.value as { enabled?: boolean })?.enabled === true;

        if (autoEnabled) {
          log(
            `[webhook] Auto-triggering Phase 2 for project ${portfolioProjectId} (no pending Phase 1)`,
            "webhook"
          );
          setTimeout(async () => {
            try {
              const result = await runPhase2WithRetry(
                companyId,
                portfolioProjectId,
                undefined,
                undefined,
                { triggerSource: "webhook" }
              );
              log(
                `[webhook] Auto Phase 2 completed: ${result.success ? "success" : "failed"}`,
                "webhook"
              );
            } catch (err: unknown) {
              log(
                `[webhook] Auto Phase 2 failed: ${err instanceof Error ? err.message : String(err)}`,
                "webhook"
              );
            }
          }, 15000);
        } else {
          log(
            `[webhook] No pending Phase 1 and auto-trigger disabled for project ${portfolioProjectId}`,
            "webhook"
          );
        }
      }
    }
  } catch (err: unknown) {
    log(
      `[webhook] Error processing webhook: ${err instanceof Error ? err.message : String(err)}`,
      "webhook"
    );
  }
}
