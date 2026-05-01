/**
 * Bid Board Stage Sync Module
 * ============================
 *
 * Stage 2 + 3 of the Bid Board → HubSpot sync pipeline:
 * - diffBidBoardStages: Parse Excel export, compare with SyncHub data, return changes
 * - syncStagesToHubSpot: Push stage updates to HubSpot and update local state
 *
 * Join strategy:
 * - Primary: Project # when non-empty
 * - Fallback: Name + Customer Name composite match
 *
 * @module sync/bidboard-stage-sync
 */

import * as fs from "fs";
import * as XLSX from "xlsx";
import { storage } from "../storage";
import { updateHubSpotDeal, updateHubSpotDealStage } from "../hubspot";
import { resolveHubspotStageId, getTerminalStageGuard } from "../procore-hubspot-sync";
import { normalizeStageLabel, resolveBidBoardHubSpotStage, type StageMappingSource } from "./stage-mapping";
import { triggerPortfolioAutomationFromStageChange } from "../playwright/portfolio-automation";
import { log } from "../index";

// Excel columns from Bid Board export
const SHEET_ACTIVE = "Active Projects";
const SHEET_ARCHIVED = "Archived Projects";

export interface StageChange {
  projectName: string;
  projectNumber: string | null;
  customerName: string;
  previousStage: string;
  newStage: string;
  totalSales: number;
  synchubRecordId: string;
  hubspotDealId: string;
}

export interface BidBoardStageSyncModeConfig {
  mode?: "live" | "dry_run" | "migration" | string;
  suppressHubSpotWrites?: boolean;
  suppressPortfolioTriggers?: boolean;
  suppressStageNotifications?: boolean;
  logSuppressedActions?: boolean;
  cycleId?: string;
}

export interface StageSyncResult {
  success: number;
  failed: number;
  suppressed: number;
  errors: string[];
}

export interface BidBoardExcelRow {
  Name: string;
  Status: string;
  "Project #"?: string;
  "Total Sales"?: number;
  "Customer Name"?: string;
  "Customer Contact"?: string;
  "Created Date"?: string;
  [key: string]: unknown;
}

function normalizeKey(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).toLowerCase().trim().replace(/\s+/g, " ");
}

function compositeKey(name: string, customer: string): string {
  return `${normalizeKey(name)}|||${normalizeKey(customer)}`;
}

function getProjectIdFromChange(change: Pick<StageChange, "projectNumber" | "projectName" | "customerName">): string {
  return change.projectNumber || compositeKey(change.projectName, change.customerName);
}

async function getBidBoardStageSyncModeConfig(): Promise<Required<BidBoardStageSyncModeConfig>> {
  const config = await storage.getAutomationConfig("bidboard_stage_sync");
  const value = ((config?.value || {}) as Record<string, unknown>);
  const mode = String(value.mode || "live");
  return {
    mode,
    suppressHubSpotWrites: value.suppressHubSpotWrites === true,
    suppressPortfolioTriggers: value.suppressPortfolioTriggers === true,
    suppressStageNotifications: value.suppressStageNotifications === true,
    logSuppressedActions: value.logSuppressedActions !== false,
    cycleId: typeof value.cycleId === "string" && value.cycleId
      ? value.cycleId
      : `bidboard-stage-sync-${Date.now()}`,
  };
}

interface SuppressedActionLogInput {
  action: "bidboard_stage_sync:suppressed_hubspot_write" | "bidboard_stage_sync:suppressed_portfolio_trigger" | "bidboard_stage_sync:suppressed_stage_notification";
  change: StageChange | (Omit<StageChange, "hubspotDealId"> & { hubspotDealId: string | null });
  wouldHaveAction: string;
  targetValue: string;
  mappingSource: StageMappingSource;
  modeConfig: Required<BidBoardStageSyncModeConfig>;
}

async function logSuppressedAction(input: SuppressedActionLogInput): Promise<void> {
  if (!input.modeConfig.logSuppressedActions) return;

  const projectId = getProjectIdFromChange(input.change);
  const details = {
    cycleId: input.modeConfig.cycleId,
    previousStage: input.change.previousStage,
    newStage: input.change.newStage,
    wouldHaveAction: input.wouldHaveAction,
    targetValue: input.targetValue,
    hubspotDealId: input.change.hubspotDealId ?? null,
    mappingSource: input.mappingSource,
    mode: input.modeConfig.mode,
  };

  log(`[BidBoardStageSync] suppressed action ${JSON.stringify({
    projectNumber: input.change.projectNumber,
    projectName: input.change.projectName,
    action: input.action,
    status: "suppressed",
    ...details,
  })}`, "sync");

  try {
    await storage.createBidboardAutomationLog({
      projectId,
      projectName: input.change.projectName,
      action: input.action,
      status: "suppressed",
      details,
    });
  } catch (err) {
    log(
      `[BidBoardStageSync] failed to persist suppressed-action log: ${err instanceof Error ? err.message : String(err)}`,
      "sync"
    );
  }
}

/**
 * Parse the exported Excel file and return project rows from Active Projects sheet.
 */
export function parseActiveProjectsSheet(filePath: string): BidBoardExcelRow[] {
  const buffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(buffer, { type: "buffer" });

  const sheetName =
    workbook.SheetNames.find((n) => n.toLowerCase().includes("active")) ||
    workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<BidBoardExcelRow>(sheet);

  const required = ["Name", "Status"];
  for (const row of rows) {
    if (!row.Name || !row.Status) continue;
    const missing = required.filter((c) => row[c as keyof BidBoardExcelRow] == null);
    if (missing.length > 0) {
      log(`Row missing columns ${missing.join(", ")}: ${row.Name}`, "sync");
    }
  }

  return rows.filter((r) => r.Name && r.Status);
}

/** Minimal mapping shape needed for stage sync (hubspotDealId required) */
type MappingForSync = { hubspotDealId: string };

/**
 * Find SyncHub mapping for a Bid Board project from Excel row.
 * 1. By Project # (when non-empty)
 * 2. By Name + Customer Name composite
 */
async function findSyncMappingForRow(row: BidBoardExcelRow): Promise<{
  mapping: MappingForSync;
  synchubRecordId: string;
} | null> {
  const projectNumber = row["Project #"]?.toString()?.trim() || null;
  const name = row.Name?.toString()?.trim() || "";
  const customerName = row["Customer Name"]?.toString()?.trim() || "";

  if (projectNumber) {
    const mapping = await storage.getSyncMappingByProcoreProjectNumber(projectNumber);
    if (mapping?.hubspotDealId) {
      return {
        mapping: { hubspotDealId: mapping.hubspotDealId },
        synchubRecordId: String(mapping.id),
      };
    }
    const deal = await storage.getHubspotDealByProjectNumber(projectNumber);
    if (deal?.hubspotId) {
      const m = await storage.getSyncMappingByHubspotDealId(deal.hubspotId);
      return {
        mapping: { hubspotDealId: deal.hubspotId },
        synchubRecordId: m ? String(m.id) : `deal:${deal.hubspotId}`,
      };
    }
  }

  // Fallback: Name + Customer Name — search sync_mappings first
  const key = compositeKey(name, customerName);
  if (key && key !== "|||") {
    const all = await storage.getSyncMappings();
    const match = all.find((m) => {
      const n = normalizeKey(m.procoreProjectName || m.bidboardProjectName || m.hubspotDealName);
      const mk = compositeKey(n || (m.hubspotDealName || ""), "");
      return (n && normalizeKey(name) === n) || mk === key;
    });
    if (match?.hubspotDealId) {
      return { mapping: { hubspotDealId: match.hubspotDealId }, synchubRecordId: String(match.id) };
    }
  }

  // Fallback: search HubSpot deals by name, then filter by company
  const { data: deals } = await storage.getHubspotDeals({ search: name, limit: 5 });
  const customerNorm = normalizeKey(customerName);
  const dealMatch = deals.find((d) => {
    const dn = normalizeKey(d.dealName);
    if (dn !== normalizeKey(name)) return false;
    if (!customerNorm) return true;
    const cn = normalizeKey(d.associatedCompanyName);
    return cn && customerNorm && (cn.includes(customerNorm) || customerNorm.includes(cn));
  });
  if (dealMatch?.hubspotId) {
    const m = await storage.getSyncMappingByHubspotDealId(dealMatch.hubspotId);
    return {
      mapping: { hubspotDealId: dealMatch.hubspotId },
      synchubRecordId: m ? String(m.id) : `deal:${dealMatch.hubspotId}`,
    };
  }

  return null;
}

/**
 * Get stable project ID for bidboard_sync_state.
 * Uses Project # when available, else composite key.
 */
function getProjectId(row: BidBoardExcelRow): string {
  const pn = row["Project #"]?.toString()?.trim();
  if (pn) return pn;
  return compositeKey(row.Name ?? "", row["Customer Name"] ?? "");
}

/**
 * Stage 2: Parse Excel and diff against SyncHub to detect stage changes.
 */
export async function diffBidBoardStages(
  exportFilePath: string,
  options?: { initializeOnly?: boolean }
): Promise<StageChange[]> {
  const rows = parseActiveProjectsSheet(exportFilePath);
  const changes: StageChange[] = [];
  const prevStates = await storage.getBidboardSyncStates();
  const prevMap = new Map(prevStates.map((s) => [s.projectId, s]));

  for (const row of rows) {
    const projectId = getProjectId(row);
    const newStatus = row.Status?.toString()?.trim() || "";
    const prev = prevMap.get(projectId);
    const previousStage = prev?.currentStage ?? "";

    if (options?.initializeOnly) {
      await storage.upsertBidboardSyncState({
        projectId,
        projectName: row.Name?.toString()?.trim(),
        currentStage: newStatus,
        metadata: {
          projectNumber: row["Project #"],
          customerName: row["Customer Name"],
        },
      });
      continue;
    }

    if (previousStage && previousStage === newStatus) continue;
    if (!newStatus) continue;

    const match = await findSyncMappingForRow(row);
    const hubspotDealId = match?.mapping?.hubspotDealId;

    if (!hubspotDealId) {
      // No HubSpot deal found — can't sync stage to HubSpot.
      // BUT: still trigger portfolio automation if stage is "Sent to Production"
      const normalizedNewStage = normalizeStageLabel(newStatus);
      if (
        normalizedNewStage === "Sent to Production" ||
        normalizedNewStage === "Service - Sent to Production"
      ) {
        const projectName = row.Name?.toString()?.trim() || "";
        const projectNumber = row["Project #"]?.toString()?.trim() || null;
        const customerName = row["Customer Name"]?.toString()?.trim() || "";

        log(
          `[sync] No HubSpot deal for "${projectName}" but stage changed to "${newStatus}" — triggering portfolio automation directly`,
          "sync"
        );

        // Update sync state so we don't re-trigger on next cycle
        await storage.upsertBidboardSyncState({
          projectId,
          projectName,
          currentStage: newStatus,
          metadata: {
            projectNumber: row["Project #"],
            customerName: row["Customer Name"],
          },
        });

        const modeConfig = await getBidBoardStageSyncModeConfig();
        if (modeConfig.mode === "migration" && modeConfig.suppressPortfolioTriggers) {
          await logSuppressedAction({
            action: "bidboard_stage_sync:suppressed_portfolio_trigger",
            change: {
              projectName,
              projectNumber,
              customerName,
              previousStage: previousStage || "(new)",
              newStage: newStatus,
              totalSales: parseFloat(String(row["Total Sales"] || 0)) || 0,
              synchubRecordId: projectId,
              hubspotDealId: null,
            },
            wouldHaveAction: "portfolio_create_phase1",
            targetValue: newStatus,
            mappingSource: "hardcoded_fallback",
            modeConfig,
          });
        } else {
          // Log the event
          await storage.createBidboardAutomationLog({
            projectId,
            projectName,
            action: "bidboard_stage_sync",
            status: "success",
            details: {
              previousStage: previousStage || "(new)",
              newStage: newStatus,
              note: "No HubSpot deal mapping — portfolio automation triggered without HubSpot sync",
            },
          });

          // Trigger portfolio automation (fire and forget — don't block the sync loop)
          try {
            await triggerPortfolioAutomationFromStageChange(
              projectName,
              projectNumber,
              customerName
            );
          } catch (err) {
            log(
              `[sync] Portfolio automation trigger failed for ${projectName} (no HubSpot deal): ${err instanceof Error ? err.message : String(err)}`,
              "sync"
            );
          }
        }
      } else {
        // Not a production stage and no HubSpot deal — just update sync state and move on
        await storage.upsertBidboardSyncState({
          projectId,
          projectName: row.Name?.toString()?.trim(),
          currentStage: newStatus,
          metadata: {
            projectNumber: row["Project #"],
            customerName: row["Customer Name"],
          },
        });

        log(
          `[sync] Stage change detected for "${row.Name}" (${previousStage || "(new)"} → ${newStatus}) but no HubSpot deal found — skipping HubSpot sync`,
          "sync"
        );
      }

      continue;
    }

    // HubSpot deal found — proceed as before (add to changes for HubSpot sync)
    const totalSales = parseFloat(String(row["Total Sales"] || 0)) || 0;
    changes.push({
      projectName: row.Name?.toString()?.trim() || "",
      projectNumber: row["Project #"]?.toString()?.trim() || null,
      customerName: row["Customer Name"]?.toString()?.trim() || "",
      previousStage: previousStage || "(new)",
      newStage: newStatus,
      totalSales,
      synchubRecordId: match.synchubRecordId,
      hubspotDealId,
    });
  }

  return changes;
}

/**
 * Stage 3: Push stage updates to HubSpot and update SyncHub state.
 */
export async function syncStagesToHubSpot(
  changes: StageChange[],
  options?: { dryRun?: boolean }
): Promise<StageSyncResult> {
  const result = { success: 0, failed: 0, suppressed: 0, errors: [] as string[] };
  const modeConfig = await getBidBoardStageSyncModeConfig();
  const migrationMode = modeConfig.mode === "migration";

  for (const change of changes) {
    const resolvedMapping = await resolveBidBoardHubSpotStage(change.newStage, {
      projectName: change.projectName,
      projectNumber: change.projectNumber,
      previousStage: change.previousStage,
      cycleId: modeConfig.cycleId,
    });
    const normalizedStage = resolvedMapping?.normalizedStage ?? normalizeStageLabel(change.newStage);
    if (!resolvedMapping) {
      result.failed++;
      result.errors.push(
        `No BidBoard stage mapping for "${change.newStage}" (${change.projectName})`
      );
      log(`Stage sync skip: no BidBoard mapping for "${change.newStage}"`, "sync");
      continue;
    }
    const label = resolvedMapping.stageLabel;
    const mappingSource = resolvedMapping.mappingSource;
    const shouldTriggerPortfolio = resolvedMapping.triggerPortfolio;

    const resolved = await resolveHubspotStageId(label);
    if (!resolved) {
      result.failed++;
      result.errors.push(
        `No HubSpot stage for "${change.newStage}" (${change.projectName})`
      );
      log(`Stage sync skip: no mapping for "${change.newStage}"`, "sync");
      continue;
    }

    if (options?.dryRun) {
      log(
        `[DRY RUN] Would update Deal ${change.hubspotDealId}: ${change.previousStage} → ${change.newStage}`,
        "sync"
      );
      result.success++;
      continue;
    }

    // Trigger portfolio automation BEFORE terminal guard — production stages always fire regardless of HubSpot block
    let portfolioTriggerSucceeded = true;
    if (shouldTriggerPortfolio) {
      if (migrationMode && modeConfig.suppressPortfolioTriggers) {
        result.suppressed++;
        await logSuppressedAction({
          action: "bidboard_stage_sync:suppressed_portfolio_trigger",
          change,
          wouldHaveAction: "portfolio_create_phase1",
          targetValue: change.newStage,
          mappingSource,
          modeConfig,
        });
      } else {
        try {
          await triggerPortfolioAutomationFromStageChange(
            change.projectName,
            change.projectNumber,
            change.customerName,
            change.hubspotDealId
          );
        } catch (err) {
          portfolioTriggerSucceeded = false;
          log(
            `[sync] Portfolio automation trigger failed for ${change.projectName}: ${err instanceof Error ? err.message : String(err)}`,
            "sync"
          );
        }
      }
    }

    // Guard: don't overwrite terminal stages (Closed Won, Closed Lost, etc.)
    const terminalStage = await getTerminalStageGuard(change.hubspotDealId, label);
    if (terminalStage) {
      log(
        `BLOCKED: Deal ${change.hubspotDealId} is "${terminalStage}" — refusing to overwrite with "${label}" from Bid Board stage "${change.newStage}" (${change.projectName})`,
        "sync"
      );
      result.errors.push(
        `${change.projectName}: deal is "${terminalStage}", refusing stage regression to "${label}"`
      );
      const projectId =
        change.projectNumber ||
        compositeKey(change.projectName, change.customerName);

      if (!portfolioTriggerSucceeded) {
        // Phase 1 failed — check retry counter before updating sync state
        const prevState = (await storage.getBidboardSyncStates()).find(s => s.projectId === projectId);
        const attempts = ((prevState?.metadata as any)?.portfolioTriggerAttempts ?? 0) + 1;
        const MAX_CROSS_CYCLE_RETRIES = 3;
        if (attempts >= MAX_CROSS_CYCLE_RETRIES) {
          log(`[sync] Portfolio automation failed ${attempts} cycles for ${change.projectName} — giving up, updating sync state`, "sync");
          await storage.upsertBidboardSyncState({
            projectId,
            projectName: change.projectName,
            currentStage: change.newStage,
            metadata: { portfolioTriggerAttempts: attempts, gaveUp: true },
          });
        } else {
          log(`[sync] Portfolio automation failed for ${change.projectName} (attempt ${attempts}/${MAX_CROSS_CYCLE_RETRIES}) — will retry next cycle`, "sync");
          await storage.upsertBidboardSyncState({
            projectId,
            projectName: change.projectName,
            currentStage: change.previousStage || undefined, // Keep old stage so it re-triggers
            metadata: { portfolioTriggerAttempts: attempts },
          });
        }
      } else {
        // Phase 1 succeeded or wasn't a production stage — update sync state normally
        await storage.upsertBidboardSyncState({
          projectId,
          projectName: change.projectName,
          currentStage: change.newStage,
        });
      }
      continue;
    }

    if (migrationMode && modeConfig.suppressHubSpotWrites) {
      result.success++;
      result.suppressed++;
      const projectId = getProjectIdFromChange(change);
      await logSuppressedAction({
        action: "bidboard_stage_sync:suppressed_hubspot_write",
        change,
        wouldHaveAction: "hubspot_stage_update",
        targetValue: resolved.stageName,
        mappingSource,
        modeConfig,
      });
      await storage.upsertBidboardSyncState({
        projectId,
        projectName: change.projectName,
        currentStage: change.newStage,
      });
      await storage.createBidboardAutomationLog({
        projectId,
        projectName: change.projectName,
        action: "bidboard_stage_sync",
        status: "success",
        details: {
          hubspotDealId: change.hubspotDealId,
          previousStage: change.previousStage,
          newStage: change.newStage,
          hubspotStage: resolved.stageName,
          totalSales: change.totalSales,
          mode: modeConfig.mode,
          suppressed: true,
        },
      });
      if (
        modeConfig.suppressStageNotifications &&
        change.previousStage &&
        change.previousStage !== "(new)"
      ) {
        result.suppressed++;
        await logSuppressedAction({
          action: "bidboard_stage_sync:suppressed_stage_notification",
          change,
          wouldHaveAction: "send_stage_notification",
          targetValue: change.newStage,
          mappingSource,
          modeConfig,
        });
      }
      continue;
    }

    const updateResult = await updateHubSpotDealStage(
      change.hubspotDealId,
      resolved.stageId
    );

    if (updateResult.success) {
      const amountResult = await updateHubSpotDeal(change.hubspotDealId, {
        amount: String(change.totalSales),
      });
      if (!amountResult.success) {
        result.failed++;
        result.errors.push(
          `${change.projectName}: stage synced but amount update failed (${amountResult.message})`
        );
        log(
          `Amount sync failed after stage update for ${change.projectName}: ${amountResult.message}`,
          "sync"
        );
        continue;
      }

      result.success++;
      const projectId =
        change.projectNumber ||
        compositeKey(change.projectName, change.customerName);

      // If Phase 1 failed for a production stage, use cross-cycle retry instead of advancing state
      if (!portfolioTriggerSucceeded && shouldTriggerPortfolio) {
        const prevState = (await storage.getBidboardSyncStates()).find(s => s.projectId === projectId);
        const attempts = ((prevState?.metadata as any)?.portfolioTriggerAttempts ?? 0) + 1;
        const MAX_CROSS_CYCLE_RETRIES = 3;
        if (attempts >= MAX_CROSS_CYCLE_RETRIES) {
          log(`[sync] Portfolio automation failed ${attempts} cycles for ${change.projectName} — giving up`, "sync");
          await storage.upsertBidboardSyncState({
            projectId,
            projectName: change.projectName,
            currentStage: change.newStage,
            metadata: { portfolioTriggerAttempts: attempts, gaveUp: true },
          });
        } else {
          log(`[sync] Portfolio automation failed for ${change.projectName} (attempt ${attempts}/${MAX_CROSS_CYCLE_RETRIES}) — will retry next cycle`, "sync");
          await storage.upsertBidboardSyncState({
            projectId,
            projectName: change.projectName,
            currentStage: change.previousStage || undefined,
            metadata: { portfolioTriggerAttempts: attempts },
          });
        }
      } else {
        await storage.upsertBidboardSyncState({
          projectId,
          projectName: change.projectName,
          currentStage: change.newStage,
        });
      }
      log(
        `Stage synced: ${change.projectName} → ${change.newStage} (HubSpot: ${resolved.stageName})`,
        "sync"
      );

      await storage.createBidboardAutomationLog({
        projectName: change.projectName,
        action: "bidboard_stage_sync",
        status: "success",
        details: {
          hubspotDealId: change.hubspotDealId,
          previousStage: change.previousStage,
          newStage: change.newStage,
          hubspotStage: resolved.stageName,
          totalSales: change.totalSales,
        },
      });

      // Send stage-specific notifications (BidBoard) — only on real transitions, not first-time baseline
      if (change.previousStage && change.previousStage !== '(new)') {
        try {
          if (migrationMode && modeConfig.suppressStageNotifications) {
            result.suppressed++;
            await logSuppressedAction({
              action: "bidboard_stage_sync:suppressed_stage_notification",
              change,
              wouldHaveAction: "send_stage_notification",
              targetValue: change.newStage,
              mappingSource,
              modeConfig,
            });
          } else {
            const { processStageNotification } = await import('../stage-notifications');
            const mapping = await storage.getSyncMappingByHubspotDealId(change.hubspotDealId);
            await processStageNotification({
              stage: change.newStage,
              source: 'bidboard',
              projectName: change.projectName,
              oldStage: change.previousStage,
              procoreProjectId: mapping?.procoreProjectId || null,
              bidboardProjectId: mapping?.bidboardProjectId || null,
              bidboardProjectNumber: change.projectNumber,
              hubspotDealId: change.hubspotDealId,
            });
          }
        } catch (notifyErr: any) {
          log(`[sync] Stage notification failed for ${change.projectName}: ${notifyErr.message}`, "sync");
        }
      }

    } else {
      result.failed++;
      result.errors.push(
        `${change.projectName}: ${updateResult.message}`
      );
      await storage.createBidboardAutomationLog({
        projectName: change.projectName,
        action: "bidboard_stage_sync",
        status: "failed",
        details: { hubspotDealId: change.hubspotDealId },
        errorMessage: updateResult.message,
      });
    }

    // Rate limit: HubSpot allows 100 req/10s for private apps
    await new Promise((r) => setTimeout(r, 150));
  }

  return result;
}
