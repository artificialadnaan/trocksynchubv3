import type { Express, RequestHandler } from "express";
import { storage } from "../storage";
import { syncProcoreRoleAssignments } from "../procore";
import { updateHubSpotDealStage } from "../hubspot";
import { sendStageChangeEmail } from "../email-notifications";
import { processNewDealWebhook } from "../deal-project-number";
import { processHubspotWebhookForProcore } from "../hubspot-procore-sync";
import { mapProcoreStageToHubspot, resolveHubspotStageId, findOrCreateMappingByProjectNumber, getTerminalStageGuard } from "../procore-hubspot-sync";
import { handleProcoreProjectWebhook } from "../webhooks/procore-webhook";
import { recordWebhookRoleEvent } from "./settings";
import { markProjectWebhookUpdated } from "../procore-rate-limiter";
import { asyncHandler } from "../lib/async-handler";
import { db } from "../db";
import { webhookLogs } from "@shared/schema";
import { eq, and, lt, desc } from "drizzle-orm";

export function registerWebhookRoutes(app: Express, requireAuth?: RequestHandler) {
  // ── HubSpot webhook ─────────────────────────────────────────────────────────
  app.post("/webhooks/hubspot", async (req, res) => {
    try {
      // C-1: HubSpot signature verification (optional — skipped if secret not configured)
      const hubspotSecret = process.env.HUBSPOT_CLIENT_SECRET;
      if (hubspotSecret) {
        const signature = req.headers['x-hubspot-signature-v3'] || req.headers['x-hubspot-signature'];
        if (signature) {
          const crypto = await import('crypto');
          const requestBody = JSON.stringify(req.body);
          const hash = crypto.createHmac('sha256', hubspotSecret)
            .update(requestBody)
            .digest('hex');
          if (hash !== signature) {
            console.warn('[webhook] HubSpot signature verification FAILED');
            return res.status(401).json({ error: 'Invalid signature' });
          }
        }
      } else {
        console.warn('[webhook] HUBSPOT_CLIENT_SECRET not set — skipping signature verification');
      }

      // H-4: HubSpot payload validation
      if (!req.body || (typeof req.body !== 'object')) {
        return res.status(400).json({ error: 'Invalid payload: expected object or array' });
      }
      const rawEvents = Array.isArray(req.body) ? req.body : [req.body];
      for (const evt of rawEvents) {
        if (!evt.subscriptionType && !evt.eventType) {
          return res.status(400).json({ error: 'Invalid payload: each event must have subscriptionType' });
        }
        if (evt.objectId == null) {
          return res.status(400).json({ error: 'Invalid payload: each event must have objectId' });
        }
      }

      const events = Array.isArray(req.body) ? req.body : [req.body];
      for (const event of events) {
        const idempotencyKey = `hs_${event.eventId || event.objectId}_${Date.now()}`;
        const existing = await storage.checkIdempotencyKey(idempotencyKey);
        if (existing) continue;

        const webhookLog = await storage.createWebhookLog({
          source: "hubspot",
          eventType: event.subscriptionType || event.eventType || "unknown",
          resourceId: String(event.objectId || ""),
          resourceType: event.objectType || "unknown",
          status: "received",
          payload: event,
          idempotencyKey,
        });

        await storage.createIdempotencyKey({
          key: idempotencyKey,
          source: "hubspot",
          eventType: event.subscriptionType || "unknown",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });

        await storage.createAuditLog({
          action: "webhook_received",
          entityType: event.objectType || "unknown",
          entityId: String(event.objectId || ""),
          source: "hubspot",
          status: "received",
          details: event,
          idempotencyKey,
        });

        await storage.updateWebhookLog(webhookLog.id, { status: "processing" });

        // Per-automation gate: if hubspot_webhook_processing is not enabled, log only
        const hsProcessingConfig = await storage.getAutomationConfig('hubspot_webhook_processing');
        if (!(hsProcessingConfig?.value as any)?.enabled) {
          const evtType = event.subscriptionType || event.eventType || "unknown";
          const objType = event.objectType || "unknown";
          console.log(`[webhook] HubSpot ${evtType} for ${objType} ${event.objectId} — logged, processing disabled`);
          await storage.updateWebhookLog(webhookLog.id, { status: "dry_run", processedAt: new Date() });
          continue;
        }

        let hubspotProcessingError: string | null = null;
        const eventType = event.subscriptionType || event.eventType || "";
        const objectType = event.objectType || (eventType.startsWith("deal.") ? "deal" : eventType.startsWith("contact.") ? "contact" : eventType.startsWith("company.") ? "company" : "");
        const objectId = String(event.objectId || "");

        // Capture previous stage BEFORE deal sync overwrites it (HubSpot has already updated the deal; our DB still has old stage)
        let previousStageForEmail: string | null = null;
        if (objectType === "deal" && eventType.includes("propertyChange") && (event.propertyName || "") === "dealstage") {
          const dealBeforeSync = await storage.getHubspotDealByHubspotId(objectId);
          if (dealBeforeSync?.dealStageName) {
            previousStageForEmail = dealBeforeSync.dealStageName;
          } else if (dealBeforeSync?.dealStage) {
            const resolved = await resolveHubspotStageId(dealBeforeSync.dealStage);
            previousStageForEmail = resolved?.stageName || dealBeforeSync.dealStage;
          }
        }

        try {
          await processHubspotWebhookForProcore(eventType, objectType, objectId);
        } catch (autoErr: any) {
          console.error(`HubSpot→Procore auto-sync error for ${objectType} ${objectId}:`, autoErr.message);
        }

        // Sync deal to local cache on any deal webhook event
        if (objectType === "deal") {
          try {
            const { syncSingleHubSpotDeal } = await import("../hubspot");
            await syncSingleHubSpotDeal(objectId);
          } catch (dealSyncErr: any) {
            console.error(`[hubspot] Deal cache sync error for ${objectId}:`, dealSyncErr.message);
          }
        }

        if (objectType === "deal" && (eventType.includes("creation") || eventType.includes("create"))) {
          try {
            await processNewDealWebhook(objectId);
          } catch (pnErr: any) {
            console.error(`[project-number] Webhook error for deal ${objectId}:`, pnErr.message);
          }
        }

        // Handle deal stage changes - trigger BidBoard project creation + stage change email
        if (objectType === "deal" && eventType.includes("propertyChange")) {
          const changedProperty = event.propertyName || "";
          const newValue = event.propertyValue || "";

          if (changedProperty === "dealstage") {
            // Skip stage change email when change was triggered by SyncHub itself (e.g. RFP approval handler)
            const changeSource = (event as any).changeSource;
            const skipStageChangeEmail = changeSource === "INTEGRATION";
            const resolvedNewStage = await resolveHubspotStageId(newValue);
            const stageName = (resolvedNewStage?.stageName || newValue).toLowerCase();
            const stageId = newValue.toLowerCase();
            console.log(`[hubspot-webhook] Deal ${objectId} stage change: stageId="${stageId}", resolved="${stageName}", changeSource="${changeSource || 'unknown'}"`);
            const isRfpStage = stageName.includes('rfp') || stageId.includes('rfp');
            if (isRfpStage) {
              try {
                const { createRfpApprovalRequest } = await import("../rfp-approval");
                const result = await createRfpApprovalRequest(objectId);
                console.log(`[hubspot-webhook] RFP approval request for deal ${objectId}: ${result.success ? 'created' : result.error}`);
              } catch (rfpErr: any) {
                console.error(`[hubspot-webhook] RFP approval error for deal ${objectId}:`, rfpErr.message);
              }
            } else {
              try {
                const { processDealStageChange } = await import("../hubspot-bidboard-trigger");
                await processDealStageChange(objectId, newValue);
              } catch (stageErr: any) {
                console.error(`[hubspot-bidboard] Stage change error for deal ${objectId}:`, stageErr.message);
              }
            }
            // Send deal stage change email to assigned deal members (deal owner)
            // Skip when changeSource is INTEGRATION — SyncHub triggered the change (e.g. RFP approval), so we already know about it
            if (!skipStageChangeEmail) {
              try {
                const mapping = await storage.getSyncMappingByHubspotDealId(objectId);
                const deal = await storage.getHubspotDealByHubspotId(objectId);
                const resolvedStage = await resolveHubspotStageId(newValue);
                const newStageName = resolvedStage?.stageName || newValue;
                const oldStageName = previousStageForEmail ?? "Previous stage";

                // Skip email if stage didn't actually change (HubSpot sends propertyChange events even for same-value updates)
                if (oldStageName.toLowerCase().trim() === newStageName.toLowerCase().trim()) {
                  console.log(`[hubspot-webhook] Skipping stage change email for deal ${objectId} — stage unchanged: "${oldStageName}"`);
                } else {
                  await sendStageChangeEmail({
                    hubspotDealId: objectId,
                    dealName: deal?.dealName || mapping?.hubspotDealName || "Unknown Deal",
                    procoreProjectId: mapping?.procoreProjectId || "",
                    procoreProjectName: mapping?.procoreProjectName || "Not yet linked to Procore",
                    oldStage: oldStageName,
                    newStage: newStageName,
                    hubspotStageName: newStageName,
                  });
                }
              } catch (emailErr: any) {
                console.error(`[hubspot-webhook] Stage change email error for deal ${objectId}:`, emailErr.message);
              }
            }
            // Closeout survey is only triggered by Procore project stage → Closed, not by HubSpot deal stage changes
          }
        }

        // Handle contact events - sync contact data in real-time via webhook
        if (objectType === "contact") {
          try {
            const { syncSingleHubSpotContact, deleteHubSpotContact } = await import("../hubspot");
            if (eventType.includes("deletion") || eventType.includes("delete")) {
              await deleteHubSpotContact(objectId);
            } else {
              // creation, propertyChange, or any other contact event - fetch and sync
              await syncSingleHubSpotContact(objectId);
            }
          } catch (contactErr: any) {
            console.error(`[hubspot] Contact sync error for ${objectId}:`, contactErr.message);
          }
        }

        // Handle company events - sync company data in real-time via webhook
        if (objectType === "company") {
          try {
            const { syncSingleHubSpotCompany } = await import("../hubspot");
            if (!eventType.includes("deletion") && !eventType.includes("delete")) {
              await syncSingleHubSpotCompany(objectId);
            }
            // Note: Company deletion would require implementing deleteHubspotCompany handler
          } catch (companyErr: any) {
            console.error(`[hubspot] Company sync error for ${objectId}:`, companyErr.message);
          }
        }

        // Non-blocking drift detection for deals — don't fail the webhook if this errors
        if (objectType === "deal" && objectId) {
          const dealId = objectId;
          setImmediate(async () => {
            try {
              const { detectFieldDrift } = await import("../services/reconciliation/guardrails");
              const { reconciliationProjects } = await import("@shared/reconciliation-schema");
              const { db } = await import("../db");
              const { eq } = await import("drizzle-orm");

              const [recon] = await db
                .select()
                .from(reconciliationProjects)
                .where(eq(reconciliationProjects.hubspotDealId, String(dealId)))
                .limit(1);
              if (recon) {
                await detectFieldDrift(recon.id);
              }
            } catch (e) {
              console.error("[reconciliation] Drift detection on HubSpot webhook failed:", e);
            }
          });
        }

        // Mark webhook as processed (or failed if any critical error was caught)
        await storage.updateWebhookLog(webhookLog.id, {
          status: hubspotProcessingError ? "failed" : "processed",
          processedAt: new Date(),
          errorMessage: hubspotProcessingError,
        });
      }
      res.status(200).json({ received: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Procore project-events webhook ──────────────────────────────────────────
  // Procore Projects webhook (Add to Portfolio → Phase 2)
  app.post("/webhooks/procore/project-events", handleProcoreProjectWebhook);

  // ── Procore main webhook ────────────────────────────────────────────────────
  app.post("/webhooks/procore", async (req, res) => {
    let webhookLog: any = null;
    try {
      // C-1: Procore signature verification (optional — skipped if secret not configured)
      const procoreSecret = process.env.PROCORE_WEBHOOK_SECRET;
      if (procoreSecret) {
        const signature = req.headers['x-procore-signature'] || req.headers['x-webhook-signature'];
        if (signature) {
          const crypto = await import('crypto');
          const requestBody = JSON.stringify(req.body);
          const hash = crypto.createHmac('sha256', procoreSecret)
            .update(requestBody)
            .digest('hex');
          if (hash !== signature) {
            console.warn('[webhook] Procore signature verification FAILED');
            return res.status(401).json({ error: 'Invalid signature' });
          }
        }
      } else {
        console.warn('[webhook] PROCORE_WEBHOOK_SECRET not set — skipping signature verification');
      }

      // H-4: Procore payload validation
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'Invalid payload: expected object' });
      }
      if (!req.body.resource_name && !req.body.resource_type) {
        return res.status(400).json({ error: 'Invalid payload: missing resource_name' });
      }
      if (!req.body.event_type && !req.body.reason) {
        return res.status(400).json({ error: 'Invalid payload: missing event_type' });
      }

      const event = req.body;
      const idempotencyKey = `pc_${event.id || event.resource_id}_${event.timestamp || Date.now()}`;
      const existing = await storage.checkIdempotencyKey(idempotencyKey);
      if (existing) return res.status(200).json({ received: true });

      webhookLog = await storage.createWebhookLog({
        source: "procore",
        eventType: event.event_type || "unknown",
        resourceId: String(event.resource_id || ""),
        resourceType: event.resource_name || "unknown",
        status: "received",
        payload: event,
        idempotencyKey,
      });

      await storage.createIdempotencyKey({
        key: idempotencyKey,
        source: "procore",
        eventType: event.event_type || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      await storage.createAuditLog({
        action: "webhook_received",
        entityType: event.resource_name || "unknown",
        entityId: String(event.resource_id || ""),
        source: "procore",
        status: "received",
        details: event,
        idempotencyKey,
      });

      res.status(200).json({ received: true });

      await storage.updateWebhookLog(webhookLog.id, { status: "processing" });

      // Per-automation gate: if procore_webhook_processing is not enabled, log only
      const pcProcessingConfig = await storage.getAutomationConfig('procore_webhook_processing');
      if (!(pcProcessingConfig?.value as any)?.enabled) {
        const rn = ((event.resource_name || event.resource_type || "").toString()).toLowerCase();
        const et = ((event.event_type || event.reason || "").toString()).toLowerCase();
        console.log(`[webhook] Procore ${rn} ${et} (resource ${event.resource_id}) — logged, processing disabled`);
        await storage.updateWebhookLog(webhookLog.id, { status: "dry_run", processedAt: new Date() });
        return;
      }

      // Procore may send resource_type/reason (e.g. v4.0) instead of resource_name/event_type
      const resourceName = ((event.resource_name || event.resource_type || "").toString()).toLowerCase().replace(/\s+/g, '_');
      const eventType = ((event.event_type || event.reason || "").toString()).toLowerCase();

      const roleRelatedResources = ["project_role_assignments", "project_roles", "project_users"];
      if (roleRelatedResources.includes(resourceName) && (eventType === "create" || eventType === "update")) {
        if (typeof recordWebhookRoleEvent === 'function') recordWebhookRoleEvent();
        try {
          const projectId = String(event.project_id || "");
          if (projectId) {
            console.log(`[webhook] ${resourceName} ${eventType} for project ${projectId}, syncing role assignments...`);
            const result = await syncProcoreRoleAssignments([projectId]);
            if (result.newAssignments.length > 0) {
              const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('../email-notifications');
              const emailResult = await sendRoleAssignmentEmails(result.newAssignments);
              console.log(`[webhook] Role assignment email result: ${emailResult.sent} sent, ${emailResult.skipped} skipped, ${emailResult.failed} failed`);
              const kickoffResult = await triggerKickoffForNewPmOnPortfolio(result.newAssignments);
              if (kickoffResult.triggered > 0 || kickoffResult.failed > 0) {
                console.log(`[webhook] Kickoff for new PM on Portfolio: ${kickoffResult.triggered} sent, ${kickoffResult.failed} failed`);
              }
            }
            await storage.createAuditLog({
              action: "webhook_role_assignment_processed",
              entityType: "project_role_assignment",
              entityId: String(event.resource_id || ""),
              source: "procore",
              status: "success",
              details: { projectId, synced: result.synced, newAssignments: result.newAssignments.length, eventType },
            });
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing role assignment webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_role_assignment_processed",
            entityType: "project_role_assignment",
            entityId: String(event.resource_id || ""),
            source: "procore",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      if (resourceName === "projects" && eventType === "create") {
        const resourceId = event.resource_id != null ? String(event.resource_id) : "";
        if (resourceId) {
          try {
            const { takeNextPendingPhase2, markPhase2Complete, markPhase2Failed } = await import('../orchestrator/portfolio-orchestrator');
            const pending = await takeNextPendingPhase2();
            if (pending) {
              const companyId = String(event.company_id || "");
              const portfolioProjectId = resourceId;
              const jobId = pending.id;
              console.log(`[webhook] Triggering Phase 2 for portfolio project ${portfolioProjectId} (bidboard: ${pending.bidboardProjectId}, job #${jobId})`);
              const webhookPayload = event;
              setTimeout(async () => {
                try {
                  const { runPhase2WithRetry } = await import('../portfolio-automation-runner');
                  const phase2Input =
                    pending.bidboardProjectUrl || pending.proposalPdfPath != null
                      ? {
                          bidboardProjectUrl: pending.bidboardProjectUrl || undefined,
                          proposalPdfPath: pending.proposalPdfPath ?? undefined,
                          customerName: pending.customerName ?? undefined,
                        }
                      : undefined;
                  const result = await runPhase2WithRetry(
                    companyId,
                    portfolioProjectId,
                    pending.bidboardProjectId,
                    phase2Input,
                    { triggerSource: 'webhook' }
                  );
                  if (result.success) {
                    await markPhase2Complete(jobId);
                  } else {
                    await markPhase2Failed(jobId, result.steps.map((s: any) => `${s.step}: ${s.status}`).join("; "));
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
                      automationSteps: result.steps.map((s: any) => ({ step: s.step, status: s.status })),
                    },
                  });
                  console.log(`[webhook] Phase 2 completed: ${result.success ? "success" : "failed"} (${result.steps.length} steps, job #${jobId})`);
                } catch (err: unknown) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  await markPhase2Failed(jobId, errMsg).catch(() => {});
                  console.error(`[webhook] Phase 2 failed: ${errMsg} (job #${jobId})`);
                }
              }, 15000);
            } else {
              console.log(`[webhook] Project create for ${resourceId}, no pending Phase 2 job`);
            }
          } catch (err: any) {
            console.error(`[webhook] Error in Phase 2 create handler:`, err.message);
          }
        }
      }

      if (resourceName === "projects" && eventType === "update") {
        try {
          const projectId = String(event.project_id || event.resource_id || "");
          if (projectId) {
            console.log(`[webhook] Project update detected for ${projectId}, checking for changes...`);
            // Track this project as webhook-updated so the polling cycle can skip redundant API calls
            markProjectWebhookUpdated(projectId);

            const { takeNextPendingPhase2, markPhase2Complete, markPhase2Failed } = await import('../orchestrator/portfolio-orchestrator');
            const pending = await takeNextPendingPhase2();
            if (pending) {
              const companyId = String(event.company_id || "");
              const portfolioProjectId = projectId;
              const jobId = pending.id;
              console.log(`[webhook] Triggering Phase 2 for portfolio project ${portfolioProjectId} (bidboard: ${pending.bidboardProjectId}, job #${jobId})`);
              const webhookPayload = event;
              setTimeout(async () => {
                try {
                  const { runPhase2WithRetry } = await import('../portfolio-automation-runner');
                  const phase2Input =
                    pending.bidboardProjectUrl || pending.proposalPdfPath != null
                      ? {
                          bidboardProjectUrl: pending.bidboardProjectUrl || undefined,
                          proposalPdfPath: pending.proposalPdfPath ?? undefined,
                          customerName: pending.customerName ?? undefined,
                        }
                      : undefined;
                  const result = await runPhase2WithRetry(
                    companyId,
                    portfolioProjectId,
                    pending.bidboardProjectId,
                    phase2Input,
                    { triggerSource: 'webhook' }
                  );
                  if (result.success) {
                    await markPhase2Complete(jobId);
                  } else {
                    await markPhase2Failed(jobId, result.steps.map((s: any) => `${s.step}: ${s.status}`).join("; "));
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
                      automationSteps: result.steps.map((s: any) => ({ step: s.step, status: s.status })),
                    },
                  });
                  console.log(`[webhook] Phase 2 completed: ${result.success ? "success" : "failed"} (${result.steps.length} steps, job #${jobId})`);
                } catch (err: unknown) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  await markPhase2Failed(jobId, errMsg).catch(() => {});
                  console.error(`[webhook] Phase 2 failed: ${errMsg} (job #${jobId})`);
                }
              }, 15000);
            }

            const project = await storage.getProcoreProjectByProcoreId(projectId);
            if (!project) {
              // Project not in local DB - try auto-link by project number, then sync stage
              let mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
              if (!mapping?.hubspotDealId) {
                try {
                  const { fetchProcoreProjectDetail } = await import('../procore');
                  const freshProject = await fetchProcoreProjectDetail(projectId);
                  const projectNumber = freshProject?.project_number || (freshProject?.properties as any)?.project_number || null;
                  const projectName = freshProject?.name || freshProject?.display_name || null;
                  const companyId = freshProject?.company?.id ? String(freshProject.company.id) : null;
                  if (projectNumber) {
                    mapping = (await findOrCreateMappingByProjectNumber({
                      procoreProjectId: projectId,
                      projectNumber,
                      projectName,
                      companyId,
                    })) ?? undefined;
                  }
                } catch (err: any) {
                  console.error(`[webhook] Error auto-linking project ${projectId} by project number:`, err.message);
                }
              }
              if (mapping?.hubspotDealId) {
                try {
                  const { fetchProcoreProjectDetail } = await import('../procore');
                  const freshProject = await fetchProcoreProjectDetail(projectId);
                  const newStage = freshProject?.project_stage?.name || freshProject?.stage_name || freshProject?.stage || freshProject?.status_name || null;
                  if (newStage) {
                    const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
                  const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;
                    if (stageSyncEnabled) {
                      const hubspotStageLabel = mapProcoreStageToHubspot(newStage);
                      if (!hubspotStageLabel) {
                        console.log(`[webhook] Project ${projectId} has null/empty stage — skipping HubSpot sync`);
                      } else {
                        // Guard: don't overwrite terminal stages (Closed Won, Closed Lost, etc.)
                        const terminalStage = await getTerminalStageGuard(mapping.hubspotDealId);
                        if (terminalStage) {
                          console.log(`[webhook] BLOCKED: Deal ${mapping.hubspotDealId} is "${terminalStage}" — refusing to overwrite with "${hubspotStageLabel}" (project ${projectId})`);
                          await storage.createAuditLog({
                            action: 'webhook_stage_change_blocked',
                            entityType: 'project_stage',
                            entityId: projectId,
                            source: 'procore',
                            status: 'skipped',
                            details: { projectId, newStage, hubspotDealId: mapping.hubspotDealId, currentHubspotStage: terminalStage, blockedStage: hubspotStageLabel, reason: 'terminal_stage_guard' },
                          });
                        } else {
                          const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);
                          if (resolvedStage) {
                            const updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, resolvedStage.stageId);
                            console.log(`[webhook] Project ${projectId} not in local DB - synced stage "${newStage}" to HubSpot deal ${mapping.hubspotDealId}: ${updateResult.message}`);
                            await storage.createAuditLog({
                              action: 'webhook_stage_change_processed',
                              entityType: 'project_stage',
                              entityId: projectId,
                              source: 'procore',
                              status: 'success',
                              details: { projectId, newStage, hubspotDealId: mapping.hubspotDealId, reason: 'project_not_in_local_db' },
                            });
                          }
                        }
                      }
                    }

                    // Auto-archive trigger for projects not in local DB
                    try {
                      const { handleProjectStageChange } = await import('../project-archive');
                      const archiveResult = await handleProjectStageChange(projectId, freshProject?.name || 'Unknown Project', newStage);
                      if (archiveResult.triggered) {
                        console.log(`[webhook] Auto-archive triggered for project ${projectId} (not in local DB) at stage "${newStage}" — archiveId: ${archiveResult.archiveId}`);
                      }
                    } catch (archiveErr: any) {
                      console.error(`[webhook] Auto-archive check failed for project ${projectId}:`, archiveErr.message);
                    }
                  }
                } catch (err: any) {
                  console.error(`[webhook] Error syncing stage for project ${projectId} (not in local DB):`, err.message);
                }
              } else {
                console.log(`[webhook] Project ${projectId} not found locally, skipping change check`);
              }
            } else {
              const { fetchProcoreProjectDetail } = await import('../procore');
              const freshProject = await fetchProcoreProjectDetail(projectId);

              // Check for project deactivation (status changed to inactive)
              const wasActive = project.active ?? true;
              const isNowActive = freshProject?.active ?? true;

              if (wasActive && !isNowActive) {
                console.log(`[webhook] Project ${project.name} (${projectId}) was DEACTIVATED - triggering archive & data extraction...`);

                // Update local project record first
                await storage.upsertProcoreProject({
                  ...project,
                  active: false,
                  lastSyncedAt: new Date(),
                  properties: project.properties as Record<string, unknown> | undefined,
                });

                // Trigger archive and data extraction
                try {
                  const { runProjectCloseout } = await import('../closeout-automation');
                  const closeoutResult = await runProjectCloseout(projectId, {
                    sendSurvey: true,
                    archiveToSharePoint: true,
                    deactivateProject: false, // Already deactivated in Procore
                    updateHubSpotStage: true,
                  });

                  console.log(`[webhook] Closeout automation completed for deactivated project ${projectId}:`, closeoutResult);

                  await storage.createAuditLog({
                    action: 'project_deactivation_closeout',
                    entityType: 'project',
                    entityId: projectId,
                    source: 'procore',
                    status: 'success',
                    details: {
                      projectId,
                      projectName: project.name,
                      closeoutResult,
                      triggeredBy: 'procore_webhook',
                    },
                  });
                } catch (closeoutErr: any) {
                  console.error(`[webhook] Closeout automation failed for project ${projectId}:`, closeoutErr.message);
                  await storage.createAuditLog({
                    action: 'project_deactivation_closeout',
                    entityType: 'project',
                    entityId: projectId,
                    source: 'procore',
                    status: 'error',
                    errorMessage: closeoutErr.message,
                    details: { projectId, projectName: project.name },
                  });
                }
              }

              // Check for stage changes (Procore may use project_stage, stage_name, stage, or status_name)
              const newStage = freshProject?.project_stage?.name || freshProject?.stage_name || freshProject?.stage || freshProject?.status_name || null;
              const oldStage = project.projectStageName || project.stage || null;

              if (newStage && oldStage && newStage.trim() !== oldStage.trim()) {
                console.log(`[webhook] Stage change detected: "${oldStage}" → "${newStage}" for project ${project.name}`);

                await storage.upsertProcoreProject({
                  ...project,
                  stage: newStage,
                  projectStageName: newStage,
                  lastSyncedAt: new Date(),
                  properties: project.properties as Record<string, unknown> | undefined,
                });

                let mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
                // Auto-link by project number if no mapping exists (e.g. DFW-2-06326-ah)
                if (!mapping?.hubspotDealId && project.projectNumber) {
                  mapping = await findOrCreateMappingByProjectNumber({
                    procoreProjectId: projectId,
                    projectNumber: project.projectNumber,
                    projectName: project.name,
                    companyId: project.companyId,
                  }) ?? undefined;
                }
                if (mapping?.hubspotDealId) {
                  // Stage sync enabled by default; set procore_hubspot_stage_sync.enabled = false to disable
                  const stageSyncConfig = await storage.getAutomationConfig("procore_hubspot_stage_sync");
                  const stageSyncEnabled = (stageSyncConfig?.value as any)?.enabled === true;

                  if (!stageSyncEnabled) {
                    console.log(`[webhook] Stage sync disabled - skipping HubSpot update for deal ${mapping.hubspotDealId}`);
                  } else {
                    // Map Procore stage to HubSpot stage label, then resolve to actual stage ID
                    const hubspotStageLabel = mapProcoreStageToHubspot(newStage);

                    if (!hubspotStageLabel) {
                      console.log(`[webhook] Procore stage "${newStage}" mapped to null — skipping HubSpot sync for deal ${mapping.hubspotDealId}`);
                    } else {
                    // Guard: don't overwrite terminal stages (Closed Won, Closed Lost, etc.)
                    const terminalStage = await getTerminalStageGuard(mapping.hubspotDealId);
                    if (terminalStage) {
                      console.log(`[webhook] BLOCKED: Deal ${mapping.hubspotDealId} is "${terminalStage}" — refusing to overwrite with "${hubspotStageLabel}" from Procore stage "${newStage}"`);
                      await storage.createAuditLog({
                        action: 'webhook_stage_change_blocked',
                        entityType: 'project_stage',
                        entityId: projectId,
                        source: 'procore',
                        status: 'skipped',
                        details: { projectId, projectName: project.name, oldStage, newStage, hubspotDealId: mapping.hubspotDealId, currentHubspotStage: terminalStage, blockedStage: hubspotStageLabel, reason: 'terminal_stage_guard' },
                      });
                    } else {
                    const resolvedStage = await resolveHubspotStageId(hubspotStageLabel);

                    if (!resolvedStage) {
                      console.log(`[webhook] Could not resolve HubSpot stage for label: ${hubspotStageLabel}`);
                      await storage.createAuditLog({
                        action: 'webhook_stage_change_processed',
                        entityType: 'project_stage',
                        entityId: projectId,
                        source: 'procore',
                        status: 'error',
                        details: { projectId, projectName: project.name, oldStage, newStage, error: `No HubSpot stage found for label: ${hubspotStageLabel}` },
                      });
                    } else {
                      const hubspotStageId = resolvedStage.stageId;
                      const hubspotStageName = resolvedStage.stageName;

                      const updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
                      console.log(`[webhook] HubSpot deal ${mapping.hubspotDealId} stage updated: ${updateResult.message}`);

                      const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);

                      const emailResult = await sendStageChangeEmail({
                        hubspotDealId: mapping.hubspotDealId,
                        dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
                        procoreProjectId: projectId,
                        procoreProjectName: project.name || 'Unknown Project',
                        oldStage: oldStage,
                        newStage: newStage,
                        hubspotStageName,
                      });

                      await storage.createAuditLog({
                        action: 'webhook_stage_change_processed',
                        entityType: 'project_stage',
                        entityId: projectId,
                        source: 'procore',
                        status: 'success',
                        details: {
                          projectId,
                          projectName: project.name,
                          oldStage,
                          newStage,
                          hubspotDealId: mapping.hubspotDealId,
                          hubspotStageId,
                          hubspotStageName,
                          hubspotUpdateSuccess: updateResult.success,
                          emailSent: emailResult.sent,
                          emailRecipient: emailResult.ownerEmail,
                        },
                      });
                    } // End resolvedStage check
                    } // End terminalStageGuard check
                    } // End hubspotStageLabel null check
                  } // End stageSyncEnabled check
                } else {
                  console.log(`[webhook] No HubSpot mapping found for project ${projectId}, stage change logged but not synced`);
                  await storage.createAuditLog({
                    action: 'webhook_stage_change_processed',
                    entityType: 'project_stage',
                    entityId: projectId,
                    source: 'procore',
                    status: 'success',
                    details: { projectId, projectName: project.name, oldStage, newStage, hubspotDealId: null, reason: 'no_hubspot_mapping' },
                  });
                }
              }

              // Send stage-specific notifications (portfolio stages)
              try {
                const { processStageNotification } = await import('../stage-notifications');
                const stageMapping = await storage.getSyncMappingByProcoreProjectId(projectId);
                await processStageNotification({
                  stage: newStage,
                  source: 'portfolio',
                  projectName: project.name || 'Unknown Project',
                  oldStage,
                  procoreProjectId: projectId,
                  hubspotDealId: stageMapping?.hubspotDealId,
                });
              } catch (notifyErr: any) {
                console.error(`[webhook] Stage notification failed for project ${projectId}:`, notifyErr.message);
              }

              // When Procore stage changes to closed/closeout, trigger closeout survey to deal owner
              const mapping = await storage.getSyncMappingByProcoreProjectId(projectId);
              const { isProcoreClosedStage, triggerCloseoutSurvey } = await import('../closeout-automation');
              if (mapping?.hubspotDealId && isProcoreClosedStage(newStage)) {
                try {
                  const surveyResult = await triggerCloseoutSurvey(projectId, {});
                  console.log(`[webhook] Closeout survey triggered (Procore closed): project ${projectId}`, surveyResult.success ? 'sent' : surveyResult.error);
                } catch (surveyErr: any) {
                  console.error(`[webhook] Closeout survey error for project ${projectId}:`, surveyErr.message);
                }
              }

              // Auto-archive trigger: check if stage change matches configured archive trigger stage
              if (newStage) {
                try {
                  const { handleProjectStageChange } = await import('../project-archive');
                  const archiveResult = await handleProjectStageChange(
                    projectId,
                    project?.name || freshProject?.name || 'Unknown Project',
                    newStage
                  );
                  if (archiveResult.triggered) {
                    console.log(`[webhook] Auto-archive triggered for project ${projectId} at stage "${newStage}" — archiveId: ${archiveResult.archiveId}`);
                  }
                } catch (archiveErr: any) {
                  console.error(`[webhook] Auto-archive check failed for project ${projectId}:`, archiveErr.message);
                }
              }

              // Non-blocking drift detection — don't fail the webhook if this errors
              setImmediate(async () => {
                try {
                  const { detectFieldDrift } = await import("../services/reconciliation/guardrails");
                  const { reconciliationProjects } = await import("@shared/reconciliation-schema");
                  const { db } = await import("../db");
                  const { eq } = await import("drizzle-orm");

                  const [recon] = await db
                    .select()
                    .from(reconciliationProjects)
                    .where(eq(reconciliationProjects.procoreProjectId, String(projectId)))
                    .limit(1);
                  if (recon) {
                    await detectFieldDrift(recon.id);
                  }
                } catch (e) {
                  console.error("[reconciliation] Drift detection on Procore webhook failed:", e);
                }
              });
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing project stage change:`, err.message);
          await storage.createAuditLog({
            action: 'webhook_stage_change_processed',
            entityType: 'project_stage',
            entityId: String(event.resource_id || ""),
            source: 'procore',
            status: 'error',
            errorMessage: err.message,
            details: event,
          });
        }
      }

      const changeOrderResources = ['change_order', 'change_order_package', 'change_orders', 'change_order_packages', 'change_events', 'change_event'];
      if (changeOrderResources.includes(resourceName) && ['create', 'update', 'delete'].includes(eventType)) {
        try {
          const projectId = String(event.project_id || "");
          if (projectId) {
            console.log(`[webhook] Change order ${eventType} detected for project ${projectId}, syncing to HubSpot...`);
            const { handleChangeOrderWebhook } = await import('../change-order-sync');
            const result = await handleChangeOrderWebhook({
              resource_name: event.resource_name,
              event_type: eventType,
              resource_id: String(event.resource_id || ""),
              project_id: projectId,
            });
            if (result.processed) {
              console.log(`[webhook] Change order sync result:`, result.result);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing change order webhook:`, err.message);
          await storage.createAuditLog({
            action: 'webhook_change_order_processed',
            entityType: 'change_order',
            entityId: String(event.resource_id || ""),
            source: 'procore',
            status: 'error',
            errorMessage: err.message,
            details: event,
          });
        }
      }

      // Handle user events - sync user data in real-time via webhook
      if (resourceName === "users" || resourceName === "user") {
        try {
          const userId = String(event.resource_id || "");
          if (userId) {
            const { syncSingleProcoreUser } = await import("../procore");
            if (eventType === "delete") {
              await storage.deleteProcoreUser(userId);
              console.log(`[webhook] Procore user ${userId} deleted via webhook`);
            } else {
              const result = await syncSingleProcoreUser(userId);
              console.log(`[webhook] Procore user ${userId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing user webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_user_sync",
            entityType: "user",
            entityId: String(event.resource_id || ""),
            source: "procore",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });
    } catch (e: any) {
      // Mark webhook as failed if unhandled error occurred during processing
      try {
        if (webhookLog?.id) {
          await storage.updateWebhookLog(webhookLog.id, { status: "failed", errorMessage: e.message, processedAt: new Date() });
        }
      } catch { /* ignore logging errors */ }
      if (!res.headersSent) res.status(200).json({ received: true });
    }
  });

  // ── CompanyCam webhook ──────────────────────────────────────────────────────
  app.post("/webhooks/companycam", async (req, res) => {
    let webhookLog: any = null;
    try {
      const event = req.body;
      const idempotencyKey = `cc_${event.data?.id || Date.now()}`;
      const existing = await storage.checkIdempotencyKey(idempotencyKey);
      if (existing) return res.status(200).json({ received: true });

      webhookLog = await storage.createWebhookLog({
        source: "companycam",
        eventType: event.event_type || "unknown",
        resourceId: String(event.data?.id || ""),
        resourceType: "project",
        status: "received",
        payload: event,
        idempotencyKey,
      });

      await storage.createIdempotencyKey({
        key: idempotencyKey,
        source: "companycam",
        eventType: event.event_type || "unknown",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      await storage.updateWebhookLog(webhookLog.id, { status: "processing" });

      const resourceType = event.resource_type || event.event_type?.split('.')[0] || "unknown";
      const eventType = event.event_type || "unknown";
      const resourceId = String(event.data?.id || "");

      await storage.createAuditLog({
        action: "webhook_received",
        entityType: resourceType,
        entityId: resourceId,
        source: "companycam",
        status: "received",
        details: event,
        idempotencyKey,
      });

      // Handle user events - sync user data in real-time via webhook
      if (resourceType === "user" || eventType.startsWith("user.")) {
        try {
          if (resourceId) {
            const { syncSingleCompanycamUser } = await import("../companycam");
            // CompanyCam doesn't typically send delete events, but handle if they do
            if (eventType.includes("deleted") || eventType.includes("delete")) {
              await storage.deleteCompanycamUser(resourceId);
              console.log(`[webhook] CompanyCam user ${resourceId} deleted via webhook`);
            } else {
              const result = await syncSingleCompanycamUser(resourceId);
              console.log(`[webhook] CompanyCam user ${resourceId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing CompanyCam user webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_user_sync",
            entityType: "user",
            entityId: resourceId,
            source: "companycam",
            status: "error",
            errorMessage: err.message,
            details: event,
          });
        }
      }

      // Handle project events - sync project data in real-time via webhook
      if (resourceType === "project" || eventType.startsWith("project.")) {
        try {
          if (resourceId) {
            if (eventType.includes("deleted") || eventType.includes("delete")) {
              await storage.deleteCompanycamProject(resourceId);
              console.log(`[webhook] CompanyCam project ${resourceId} deleted via webhook`);
            } else {
              const { syncSingleCompanycamProject } = await import("../companycam");
              const result = await syncSingleCompanycamProject(resourceId);
              console.log(`[webhook] CompanyCam project ${resourceId} ${result.action} via webhook`);
            }
          }
        } catch (err: any) {
          console.error(`[webhook] Error processing CompanyCam project webhook:`, err.message);
          await storage.createAuditLog({
            action: "webhook_project_sync",
            entityType: "project",
            entityId: resourceId,
            source: "companycam",
            status: "error",
            errorMessage: err.message,
          });
        }
      }

      await storage.updateWebhookLog(webhookLog.id, { status: "processed", processedAt: new Date() });
      res.status(200).json({ received: true });
    } catch (e: any) {
      try {
        if (webhookLog?.id) {
          await storage.updateWebhookLog(webhookLog.id, { status: "failed", errorMessage: e.message, processedAt: new Date() });
        }
      } catch { /* ignore logging errors */ }
      res.status(500).json({ message: e.message });
    }
  });

  // ── Webhook Admin Endpoints (DLQ) ──────────────────────────────────────────
  const auth = requireAuth || ((_req: any, _res: any, next: any) => next());

  // GET /api/webhooks/failed — list failed webhooks for dashboard/replay
  app.get("/api/webhooks/failed", auth, asyncHandler(async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const result = await storage.getWebhookLogs({ status: "failed", limit, offset });
    res.json(result);
  }));

  // POST /api/webhooks/replay/:id — re-process a failed webhook from stored payload
  app.post("/api/webhooks/replay/:id", auth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid webhook ID" });

    // Get the webhook log by ID
    const [log] = await db.select().from(webhookLogs).where(eq(webhookLogs.id, id)).limit(1);
    if (!log) return res.status(404).json({ error: "Webhook log not found" });
    if (log.status !== "failed") return res.status(400).json({ error: `Webhook is in '${log.status}' status, only 'failed' webhooks can be replayed` });
    if (!log.payload) return res.status(400).json({ error: "No payload stored for this webhook" });
    if (log.retryCount >= log.maxRetries) return res.status(400).json({ error: `Max retries (${log.maxRetries}) exceeded` });

    // Increment retry count and reset to processing
    await storage.updateWebhookLog(id, {
      status: "processing",
      retryCount: log.retryCount + 1,
      errorMessage: null,
    });

    // Re-process based on source
    try {
      if (log.source === "hubspot") {
        const event = log.payload as any;
        const eventType = event.subscriptionType || event.eventType || "";
        const objectType = event.objectType || "";
        const objectId = String(event.objectId || "");

        if (objectType === "deal") {
          try { await processHubspotWebhookForProcore(eventType, objectType, objectId); } catch (e) { console.error('[webhook] processHubspotWebhookForProcore failed during replay:', (e as Error).message); }
          try {
            const { syncSingleHubSpotDeal } = await import("../hubspot");
            await syncSingleHubSpotDeal(objectId);
          } catch (e) { console.error('[webhook] syncSingleHubSpotDeal failed during replay:', (e as Error).message); }
        }
      } else if (log.source === "procore") {
        const event = log.payload as any;
        const resourceName = ((event.resource_name || event.resource_type || "").toString()).toLowerCase().replace(/\s+/g, '_');
        const eventType = ((event.event_type || event.reason || "").toString()).toLowerCase();

        if (resourceName === "projects" && eventType === "update") {
          const projectId = String(event.project_id || event.resource_id || "");
          if (projectId) {
            const { fetchProcoreProjectDetail } = await import("../procore");
            await fetchProcoreProjectDetail(projectId);
          }
        }
        if (["project_role_assignments", "project_roles", "project_users"].includes(resourceName)) {
          const projectId = String(event.project_id || "");
          if (projectId) await syncProcoreRoleAssignments([projectId]);
        }
      }

      await storage.updateWebhookLog(id, { status: "processed", processedAt: new Date(), errorMessage: null });
      res.json({ success: true, message: "Webhook replayed successfully" });
    } catch (replayErr: any) {
      await storage.updateWebhookLog(id, { status: "failed", errorMessage: replayErr.message, processedAt: new Date() });
      res.status(500).json({ success: false, error: replayErr.message });
    }
  }));
}
