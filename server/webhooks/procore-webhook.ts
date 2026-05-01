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
  markPhase2Complete,
  markPhase2Failed,
  markPhase2Skipped,
} from "../orchestrator/portfolio-orchestrator";
import { evaluateWebhookPortfolioPhase2Gate, getWebhookMigrationModeConfig, isMigrationMode, logWebhookSuppressedAction } from "./migration-mode";

export { registerPendingPhase2 };

// Debounce: skip webhook-triggered role check if same project was checked within last 60s
const recentRoleCheckTimestamps = new Map<string, number>();
const ROLE_CHECK_DEBOUNCE_MS = 60_000;

// Track processed webhook IDs to avoid duplicate processing
const processedWebhooks = new Set<string>();
const MAX_PROCESSED_CACHE = 1000;

/** Evict dedup cache when it grows too large to prevent memory leaks */
function evictDedupCache(): void {
  if (processedWebhooks.size > MAX_PROCESSED_CACHE) {
    processedWebhooks.clear();
  }
}

/**
 * Express route handler for Procore Projects webhook events.
 * Mount this at POST /webhooks/procore/project-events
 */
export async function handleProcoreProjectWebhook(
  req: Request,
  res: Response
): Promise<void> {
  res.status(200).json({ received: true });

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
    evictDedupCache();
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
    const webhookMigrationConfig = await getWebhookMigrationModeConfig();

    log(
      `[webhook] Projects ${reason} event: resource_id=${resourceId}, company_id=${companyId}`,
      "webhook"
    );

    if (reason === "update" && payload.project_id) {
      const portfolioProjectId = String(payload.project_id);

      const pending = await takeNextPendingPhase2();
      if (pending) {
        const phase2GateConfig = await getWebhookMigrationModeConfig();
        const phase2Gate = await evaluateWebhookPortfolioPhase2Gate({
          bidboardProjectId: pending.bidboardProjectId,
          portfolioProjectId,
          modeConfig: phase2GateConfig,
        });
        if (!phase2Gate.allowed) {
          await markPhase2Skipped(pending.id, "portfolio_trigger_disabled_not_allowlisted");
          await logWebhookSuppressedAction(phase2GateConfig, {
            action: "procore_webhook:suppressed_portfolio_phase2",
            projectId: portfolioProjectId,
            projectNumber: phase2Gate.projectNumber,
            previousStage: null,
            newStage: null,
            wouldHaveAction: "portfolio_phase2_webhook",
            targetValue: "phase2",
            mappingSource: phase2Gate.mappingSource,
            webhookEventId: webhookId,
            webhookResourceName: payload.resource_type,
            webhookEventType: reason,
            details: {
              bidboardProjectId: pending.bidboardProjectId,
              jobId: pending.id,
              portfolioTriggerEnabled: phase2Gate.enabled,
              allowlist: phase2Gate.allowlist,
            },
          });
        } else {
          log(
            `[webhook] Triggering Phase 2 for portfolio project ${portfolioProjectId} (bidboard: ${pending.bidboardProjectId}, job #${pending.id})`,
            "webhook"
          );

          const webhookPayload = payload;
          const jobId = pending.id;
          setTimeout(async () => {
          try {
            const phase2Input =
              pending.bidboardProjectUrl || pending.proposalPdfPath != null || pending.customerName
                ? {
                    bidboardProjectUrl: pending.bidboardProjectUrl || undefined,
                    proposalPdfPath: pending.proposalPdfPath ?? null,
                    customerName: pending.customerName ?? undefined,
                  }
                : undefined;

            const result = await runPhase2WithRetry(
              companyId,
              portfolioProjectId,
              pending.bidboardProjectId,
              phase2Input,
              { triggerSource: "webhook" }
            );

            if (result.success) {
              await markPhase2Complete(jobId);
            } else {
              await markPhase2Failed(jobId, result.steps.map((s) => `${s.step}: ${s.status}`).join("; "));
            }

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
                jobId,
                automationSteps: result.steps.map((s) => ({ step: s.step, status: s.status })),
              },
            });

            log(
              `[webhook] Phase 2 completed: ${result.success ? "success" : "failed"} (${result.steps.length} steps, job #${jobId})`,
              "webhook"
            );
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await markPhase2Failed(jobId, errMsg).catch(() => {});
            log(
              `[webhook] Phase 2 failed: ${errMsg} (job #${jobId})`,
              "webhook"
            );
          }
          }, 15000);
        }
      } else {
        const autoConfig = await storage.getAutomationConfig("portfolio_auto_trigger");
        const autoEnabled = (autoConfig?.value as { enabled?: boolean })?.enabled === true;

        if (autoEnabled) {
          const phase2GateConfig = await getWebhookMigrationModeConfig();
          const phase2Gate = await evaluateWebhookPortfolioPhase2Gate({
            portfolioProjectId,
            modeConfig: phase2GateConfig,
          });
          if (!phase2Gate.allowed) {
            await logWebhookSuppressedAction(phase2GateConfig, {
              action: "procore_webhook:suppressed_portfolio_phase2",
              projectId: portfolioProjectId,
              projectNumber: phase2Gate.projectNumber,
              previousStage: null,
              newStage: null,
              wouldHaveAction: "portfolio_phase2_webhook_auto_trigger",
              targetValue: "phase2",
              mappingSource: phase2Gate.mappingSource,
              webhookEventId: webhookId,
              webhookResourceName: payload.resource_type,
              webhookEventType: reason,
              details: {
                portfolioTriggerEnabled: phase2Gate.enabled,
                allowlist: phase2Gate.allowlist,
              },
            });
            log(
              `[webhook] Auto Phase 2 suppressed for project ${portfolioProjectId}: portfolio trigger disabled and project not allowlisted`,
              "webhook"
            );
          } else {
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
          }
        } else {
          log(
            `[webhook] No pending Phase 1 and auto-trigger disabled for project ${portfolioProjectId}`,
            "webhook"
          );
        }
      }

      // Webhook-triggered role check: fire for both create and update events
      // Debounce to avoid hammering if multiple webhooks arrive for the same project
      const now = Date.now();
      const lastChecked = recentRoleCheckTimestamps.get(resourceId) ?? 0;
      if (now - lastChecked < ROLE_CHECK_DEBOUNCE_MS) {
        log(`[webhook] Role check debounced for project ${resourceId} (checked ${Math.round((now - lastChecked) / 1000)}s ago)`, "webhook");
      } else {
        recentRoleCheckTimestamps.set(resourceId, now);
        setTimeout(async () => {
          try {
            const { syncProcoreRoleAssignments } = await import("../procore");
            const result = await syncProcoreRoleAssignments([resourceId]);
            if (result.newAssignments.length > 0) {
              log(`[webhook] Role check found ${result.newAssignments.length} new assignment(s) for project ${resourceId}, sending notifications`, "webhook");
              const delayedWebhookMigrationConfig = await getWebhookMigrationModeConfig();
              if (isMigrationMode(delayedWebhookMigrationConfig) && delayedWebhookMigrationConfig.suppressStageNotifications) {
                await logWebhookSuppressedAction(delayedWebhookMigrationConfig, {
                  action: "procore_webhook:suppressed_stage_notification",
                  projectId: resourceId,
                  previousStage: null,
                  newStage: null,
                  wouldHaveAction: "send_role_assignment_emails",
                  targetValue: "role_assignment_notifications",
                  mappingSource: "procore_role_assignments",
                  webhookEventId: webhookId,
                  webhookResourceName: payload.resource_type,
                  webhookEventType: reason,
                  details: { assignmentCount: result.newAssignments.length },
                });
              } else {
                const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import("../email-notifications");
                await sendRoleAssignmentEmails(result.newAssignments);
                await triggerKickoffForNewPmOnPortfolio(result.newAssignments);
              }
            } else {
              log(`[webhook] Role check complete for project ${resourceId}: no new assignments`, "webhook");
            }
          } catch (roleErr: unknown) {
            log(`[webhook] Role check failed for project ${resourceId}: ${roleErr instanceof Error ? roleErr.message : String(roleErr)}`, "webhook");
          }
        }, 5000);
      }
    }
  } catch (err: unknown) {
    log(
      `[webhook] Error processing webhook: ${err instanceof Error ? err.message : String(err)}`,
      "webhook"
    );
  }
}
