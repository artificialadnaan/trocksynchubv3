import type { Express, RequestHandler } from "express";
import { storage } from "../storage";
import { syncProcoreRoleAssignments } from "../procore";
import { updateHubSpotDealStage } from "../hubspot";
import { sendStageChangeEmail } from "../email-notifications";
import { processNewDealWebhook } from "../deal-project-number";
import { processHubspotWebhookForProcore } from "../hubspot-procore-sync";
import { mapProcoreStageToHubspot, resolveHubspotStageId, findOrCreateMappingByProjectNumber, getTerminalStageGuard } from "../procore-hubspot-sync";
import { handleProcoreProjectWebhook } from "../webhooks/procore-webhook";
import { evaluateWebhookPortfolioPhase2Gate, getWebhookMigrationModeConfig, isMigrationMode, logWebhookSuppressedAction } from "../webhooks/migration-mode";
import { recordWebhookRoleEvent } from "./settings";
import { markProjectWebhookUpdated } from "../procore-rate-limiter";
import { asyncHandler } from "../lib/async-handler";
import { requireWebhookAuth, verifyProcoreToken } from "../webhooks/signature";
import { db } from "../db";
import { webhookLogs } from "@shared/schema";
import { eq, and, lt, desc } from "drizzle-orm";

// Debounce: skip webhook-triggered role check if same project was checked within last 60s
const recentRoleCheckTimestamps = new Map<string, number>();
const ROLE_CHECK_DEBOUNCE_MS = 60_000;

export function registerWebhookRoutes(app: Express, requireAuth?: RequestHandler) {
  // Fail closed (server/webhooks/signature.ts): with the secret unset the webhook answers 503, never "unverified OK".
  if (!process.env.PROCORE_WEBHOOK_SECRET) {
    console.warn('[webhook] PROCORE_WEBHOOK_SECRET not set — /webhooks/procore* refuse every request (503)');
  }
  // The secret is read per request, so a rotation takes effect without re-registering routes.
  const procoreAuth = requireWebhookAuth("procore", (req) => verifyProcoreToken(req, process.env.PROCORE_WEBHOOK_SECRET));

  // ── HubSpot webhook: RETIRED ────────────────────────────────────────────────
  // T-Rock no longer uses HubSpot (owner, 2026-10-04). Hard-disabled: the handler reads nothing from the request,
  // processes nothing, writes no log and needs no secret. 410 Gone tells a HubSpot app still pointed here to stop.
  app.post("/webhooks/hubspot", (_req, res) => {
    res.status(410).json({ error: "gone", message: "HubSpot webhooks are retired" });
  });

  // ── Procore project-events webhook ──────────────────────────────────────────
  // Procore Projects webhook (Add to Portfolio → Phase 2)
  app.post("/webhooks/procore/project-events", procoreAuth, handleProcoreProjectWebhook);

  // ── Procore main webhook ────────────────────────────────────────────────────
  app.post("/webhooks/procore", procoreAuth, async (req, res) => {
    let webhookLog: any = null;
    try {

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
      const webhookMigrationConfig = await getWebhookMigrationModeConfig();

      const roleRelatedResources = ["project_role_assignments", "project_roles", "project_users"];
      if (roleRelatedResources.includes(resourceName) && (eventType === "create" || eventType === "update")) {
        if (typeof recordWebhookRoleEvent === 'function') recordWebhookRoleEvent();
        try {
          const projectId = String(event.project_id || "");
          if (projectId) {
            console.log(`[webhook] ${resourceName} ${eventType} for project ${projectId}, syncing role assignments...`);
            const result = await syncProcoreRoleAssignments([projectId]);
            if (result.newAssignments.length > 0) {
              if (isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressStageNotifications) {
                await logWebhookSuppressedAction(webhookMigrationConfig, {
                  action: "procore_webhook:suppressed_stage_notification",
                  projectId,
                  previousStage: null,
                  newStage: null,
                  wouldHaveAction: "send_role_assignment_emails",
                  targetValue: "role_assignment_notifications",
                  mappingSource: "procore_role_assignments",
                  webhookEventId: String(event.id || ""),
                  webhookResourceName: resourceName,
                  webhookEventType: eventType,
                  details: { assignmentCount: result.newAssignments.length },
                });
              } else {
                const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('../email-notifications');
                const emailResult = await sendRoleAssignmentEmails(result.newAssignments);
                console.log(`[webhook] Role assignment email result: ${emailResult.sent} sent, ${emailResult.skipped} skipped, ${emailResult.failed} failed`);
                const kickoffResult = await triggerKickoffForNewPmOnPortfolio(result.newAssignments);
                if (kickoffResult.triggered > 0 || kickoffResult.failed > 0) {
                  console.log(`[webhook] Kickoff for new PM on Portfolio: ${kickoffResult.triggered} sent, ${kickoffResult.failed} failed`);
                }
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
            const { takeNextPendingPhase2, markPhase2Complete, markPhase2Failed, markPhase2Skipped } = await import('../orchestrator/portfolio-orchestrator');
            const pending = await takeNextPendingPhase2();
            if (pending) {
              const companyId = String(event.company_id || "");
              const portfolioProjectId = resourceId;
              const jobId = pending.id;
              const phase2GateConfig = await getWebhookMigrationModeConfig();
              const phase2Gate = await evaluateWebhookPortfolioPhase2Gate({
                bidboardProjectId: pending.bidboardProjectId,
                portfolioProjectId,
                modeConfig: phase2GateConfig,
              });
              if (!phase2Gate.allowed) {
                await markPhase2Skipped(jobId, "portfolio_trigger_disabled_not_allowlisted");
                await logWebhookSuppressedAction(phase2GateConfig, {
                  action: "procore_webhook:suppressed_portfolio_phase2",
                  projectId: portfolioProjectId,
                  projectNumber: phase2Gate.projectNumber,
                  previousStage: null,
                  newStage: null,
                  wouldHaveAction: "portfolio_phase2_webhook",
                  targetValue: "phase2",
                  mappingSource: phase2Gate.mappingSource,
                  webhookEventId: String(event.id || ""),
                  webhookResourceName: resourceName,
                  webhookEventType: eventType,
                  details: {
                    bidboardProjectId: pending.bidboardProjectId,
                    jobId,
                    portfolioTriggerEnabled: phase2Gate.enabled,
                    allowlist: phase2Gate.allowlist,
                  },
                });
              } else {
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
                    {
                      triggerSource: 'webhook',
                      // Pass the originating webhook so the Phase-2-success photo-link relay carries
                      // real trace metadata. The relay is enqueued inside runPhase2WithRetry (not in
                      // this branch), so it now fires for this if-pending path that previously skipped it.
                      webhookLog: webhookLog
                        ? { id: webhookLog.id, createdAt: webhookLog.createdAt, payload: webhookPayload }
                        : null,
                    }
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
            } else {
              console.log(`[webhook] Project create for ${resourceId}, no pending Phase 2 job`);
              // Store portfolio project ID in sync mapping so Phase 1 retries can find it
              // Delay slightly — Procore may not have project details ready immediately
              setTimeout(async () => {
                try {
                  const { fetchProcoreProjectDetail } = await import('../procore');
                  const project = await fetchProcoreProjectDetail(resourceId);
                  const projectNumber = project?.project_number;
                  const projectName = project?.name || project?.display_name;
                  console.log(`[webhook] Portfolio project ${resourceId} details: number=${projectNumber || 'none'}, name=${projectName || 'none'}`);
                  if (projectNumber) {
                    // The bidboard-specific getter: this self-heal stamps the portfolio id onto the
                    // BIDBOARD row, so it must not be shadowed by a portfolio-bearing row that shares the
                    // number (getSyncMappingByProcoreProjectNumber now prefers portfolio-bearing rows).
                    const mapping = await storage.getBidboardMappingByProcoreProjectNumber(projectNumber);
                    if (mapping?.bidboardProjectId && !mapping.portfolioProjectId) {
                      await storage.updateSyncMapping(mapping.id, { portfolioProjectId: resourceId });
                      console.log(`[webhook] Stored portfolio project ${resourceId} in sync mapping for bidboard ${mapping.bidboardProjectId}`);
                      try {
                        const { buildTrockCrmProjectCreatedPayload, enqueueTrockCrmRelayOutbox } = await import("../trockcrm-relay");
                        const payload = buildTrockCrmProjectCreatedPayload({
                          webhookLog: {
                            id: webhookLog.id,
                            createdAt: webhookLog.createdAt ?? new Date(),
                            payload: event,
                          },
                          syncMapping: mapping,
                          procoreProject: {
                            ...project,
                            id: resourceId,
                          },
                          enrichedAt: new Date(),
                        });
                        await enqueueTrockCrmRelayOutbox({
                          webhookLogId: webhookLog.id,
                          syncMappingId: mapping.id,
                          procorePortfolioProjectId: resourceId,
                          projectNumber,
                          payload,
                        });
                      } catch (relayErr: any) {
                        console.warn(`[webhook] TrockCRM relay enqueue failed for portfolio project ${resourceId}: ${relayErr.message}`);
                      }
                    } else if (!mapping) {
                      console.log(`[webhook] No sync mapping found for project number ${projectNumber}`);
                    }
                  }
                } catch (linkErr: any) {
                  console.log(`[webhook] Could not link portfolio project ${resourceId} to bidboard: ${linkErr.message}`);
                }
              }, 5000);
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

            // Webhook-triggered role check (debounced to 60s per project)
            const _roleCheckNow = Date.now();
            const _roleLastChecked = recentRoleCheckTimestamps.get(projectId) ?? 0;
            if (_roleCheckNow - _roleLastChecked < ROLE_CHECK_DEBOUNCE_MS) {
              console.log(`[webhook] Role check debounced for project ${projectId} (checked ${Math.round((_roleCheckNow - _roleLastChecked) / 1000)}s ago)`);
            } else {
              recentRoleCheckTimestamps.set(projectId, _roleCheckNow);
              setTimeout(async () => {
                try {
                  const roleResult = await syncProcoreRoleAssignments([projectId]);
                  if (roleResult.newAssignments.length > 0) {
                    console.log(`[webhook] Role check found ${roleResult.newAssignments.length} new assignment(s) for project ${projectId}, sending notifications`);
                    const delayedWebhookMigrationConfig = await getWebhookMigrationModeConfig();
                    if (isMigrationMode(delayedWebhookMigrationConfig) && delayedWebhookMigrationConfig.suppressStageNotifications) {
                      await logWebhookSuppressedAction(delayedWebhookMigrationConfig, {
                        action: "procore_webhook:suppressed_stage_notification",
                        projectId,
                        previousStage: null,
                        newStage: null,
                        wouldHaveAction: "send_role_assignment_emails",
                        targetValue: "role_assignment_notifications",
                        mappingSource: "procore_role_assignments",
                        webhookEventId: String(event.id || ""),
                        webhookResourceName: resourceName,
                        webhookEventType: eventType,
                        details: { assignmentCount: roleResult.newAssignments.length },
                      });
                    } else {
                      const { sendRoleAssignmentEmails, triggerKickoffForNewPmOnPortfolio } = await import('../email-notifications');
                      await sendRoleAssignmentEmails(roleResult.newAssignments);
                      await triggerKickoffForNewPmOnPortfolio(roleResult.newAssignments);
                    }
                  } else {
                    console.log(`[webhook] Role check complete for project ${projectId}: no new assignments`);
                  }
                } catch (roleErr: any) {
                  console.error(`[webhook] Role check failed for project ${projectId}:`, roleErr.message);
                }
              }, 5000);
            }

            const { takeNextPendingPhase2, markPhase2Complete, markPhase2Failed, markPhase2Skipped } = await import('../orchestrator/portfolio-orchestrator');
            const pending = await takeNextPendingPhase2();
            if (pending) {
              const companyId = String(event.company_id || "");
              const portfolioProjectId = projectId;
              const jobId = pending.id;
              const phase2GateConfig = await getWebhookMigrationModeConfig();
              const phase2Gate = await evaluateWebhookPortfolioPhase2Gate({
                bidboardProjectId: pending.bidboardProjectId,
                portfolioProjectId,
                modeConfig: phase2GateConfig,
              });
              if (!phase2Gate.allowed) {
                await markPhase2Skipped(jobId, "portfolio_trigger_disabled_not_allowlisted");
                await logWebhookSuppressedAction(phase2GateConfig, {
                  action: "procore_webhook:suppressed_portfolio_phase2",
                  projectId: portfolioProjectId,
                  projectNumber: phase2Gate.projectNumber,
                  previousStage: null,
                  newStage: null,
                  wouldHaveAction: "portfolio_phase2_webhook",
                  targetValue: "phase2",
                  mappingSource: phase2Gate.mappingSource,
                  webhookEventId: String(event.id || ""),
                  webhookResourceName: resourceName,
                  webhookEventType: eventType,
                  details: {
                    bidboardProjectId: pending.bidboardProjectId,
                    jobId,
                    portfolioTriggerEnabled: phase2Gate.enabled,
                    allowlist: phase2Gate.allowlist,
                  },
                });
              } else {
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
                    {
                      triggerSource: 'webhook',
                      // Pass the originating webhook so the Phase-2-success photo-link relay carries
                      // real trace metadata. The relay is enqueued inside runPhase2WithRetry (not in
                      // this branch), so it now fires for this if-pending path that previously skipped it.
                      webhookLog: webhookLog
                        ? { id: webhookLog.id, createdAt: webhookLog.createdAt, payload: webhookPayload }
                        : null,
                    }
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
                        const terminalStage = await getTerminalStageGuard(mapping.hubspotDealId, hubspotStageLabel);
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
                            let updateResult: { success: boolean | null; message: string };
                            if (isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressHubSpotWrites) {
                              await logWebhookSuppressedAction(webhookMigrationConfig, {
                                action: "procore_webhook:suppressed_hubspot_write",
                                projectId,
                                projectName: freshProject?.name || "Unknown Project",
                                projectNumber: freshProject?.project_number || (freshProject?.properties as any)?.project_number || null,
                                previousStage: null,
                                newStage,
                                wouldHaveAction: "hubspot_stage_update",
                                targetValue: resolvedStage.stageName,
                                hubspotDealId: mapping.hubspotDealId,
                                mappingSource: "sync_mappings",
                                webhookEventId: String(event.id || ""),
                                webhookResourceName: resourceName,
                                webhookEventType: eventType,
                              });
                              updateResult = { success: null, message: "suppressed by bidboard_stage_sync migration mode" };
                            } else {
                              updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, resolvedStage.stageId);
                            }
                            console.log(`[webhook] Project ${projectId} not in local DB - ${updateResult.success === null ? "suppressed stage sync" : "synced stage"} "${newStage}" to HubSpot deal ${mapping.hubspotDealId}: ${updateResult.message}`);
                            await storage.createAuditLog({
                              action: 'webhook_stage_change_processed',
                              entityType: 'project_stage',
                              entityId: projectId,
                              source: 'procore',
                              status: 'success',
                              details: {
                                projectId,
                                newStage,
                                hubspotDealId: mapping.hubspotDealId,
                                reason: 'project_not_in_local_db',
                                hubspotUpdateSuccess: updateResult.success,
                                hubspotUpdateSuppressed: updateResult.success === null,
                              },
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
                    sendSurvey: false,
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

                setImmediate(() => {
                  import("../trockcrm-relay")
                    .then(({ enqueueTrockCrmProjectStageChangedRelay }) => enqueueTrockCrmProjectStageChangedRelay({
                      webhookLog: {
                        id: webhookLog.id,
                        createdAt: webhookLog.createdAt ?? new Date(),
                        payload: event,
                      },
                      syncMapping: mapping ?? null,
                      procoreProject: project,
                      previousStage: oldStage,
                      newStage,
                      detectedAt: new Date(),
                    }))
                    .catch((relayErr: unknown) => {
                      console.warn(`[webhook] TrockCRM stage-change relay enqueue failed for project ${projectId}: ${relayErr instanceof Error ? relayErr.message : String(relayErr)}`);
                    });
                });

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
                    const terminalStage = await getTerminalStageGuard(mapping.hubspotDealId, hubspotStageLabel);
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

                      let updateResult: { success: boolean | null; message: string };
                      if (isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressHubSpotWrites) {
                        await logWebhookSuppressedAction(webhookMigrationConfig, {
                          action: "procore_webhook:suppressed_hubspot_write",
                          projectId,
                          projectName: project.name,
                          projectNumber: project.projectNumber ?? null,
                          previousStage: oldStage,
                          newStage,
                          wouldHaveAction: "hubspot_stage_update",
                          targetValue: hubspotStageName,
                          hubspotDealId: mapping.hubspotDealId,
                          mappingSource: "sync_mappings",
                          webhookEventId: String(event.id || ""),
                          webhookResourceName: resourceName,
                          webhookEventType: eventType,
                        });
                        updateResult = { success: null, message: "suppressed by bidboard_stage_sync migration mode" };
                      } else {
                        updateResult = await updateHubSpotDealStage(mapping.hubspotDealId, hubspotStageId);
                      }
                      console.log(`[webhook] HubSpot deal ${mapping.hubspotDealId} stage ${updateResult.success === null ? "suppressed" : "updated"}: ${updateResult.message}`);

                      const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);

                      let emailResult: { sent: boolean; ownerEmail?: string | null };
                      if (isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressStageNotifications) {
                        await logWebhookSuppressedAction(webhookMigrationConfig, {
                          action: "procore_webhook:suppressed_stage_notification",
                          projectId,
                          projectName: project.name,
                          projectNumber: project.projectNumber ?? null,
                          previousStage: oldStage,
                          newStage,
                          wouldHaveAction: "send_stage_change_email",
                          targetValue: hubspotStageName,
                          hubspotDealId: mapping.hubspotDealId,
                          mappingSource: "sync_mappings",
                          webhookEventId: String(event.id || ""),
                          webhookResourceName: resourceName,
                          webhookEventType: eventType,
                        });
                        emailResult = { sent: false, ownerEmail: null };
                      } else {
                        emailResult = await sendStageChangeEmail({
                          hubspotDealId: mapping.hubspotDealId,
                          dealName: deal?.dealName || mapping.hubspotDealName || 'Unknown Deal',
                          procoreProjectId: projectId,
                          procoreProjectName: project.name || 'Unknown Project',
                          oldStage: oldStage,
                          newStage: newStage,
                          hubspotStageName,
                        });
                      }

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
                          hubspotUpdateSuppressed: updateResult.success === null,
                          emailSent: emailResult.sent,
                          emailSuppressed: isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressStageNotifications,
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
                const stageMapping = await storage.getSyncMappingByProcoreProjectId(projectId);
                if (isMigrationMode(webhookMigrationConfig) && webhookMigrationConfig.suppressStageNotifications) {
                  await logWebhookSuppressedAction(webhookMigrationConfig, {
                    action: "procore_webhook:suppressed_stage_notification",
                    projectId,
                    projectName: project.name,
                    projectNumber: project.projectNumber ?? null,
                    previousStage: oldStage,
                    newStage,
                    wouldHaveAction: "send_stage_notification",
                    targetValue: newStage,
                    hubspotDealId: stageMapping?.hubspotDealId ?? null,
                    mappingSource: stageMapping ? "sync_mappings" : "none",
                    webhookEventId: String(event.id || ""),
                    webhookResourceName: resourceName,
                    webhookEventType: eventType,
                  });
                } else {
                  const { processStageNotification } = await import('../stage-notifications');
                  await processStageNotification({
                    stage: newStage,
                    source: 'portfolio',
                    projectName: project.name || 'Unknown Project',
                    oldStage,
                    procoreProjectId: projectId,
                    hubspotDealId: stageMapping?.hubspotDealId,
                  });
                }
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
