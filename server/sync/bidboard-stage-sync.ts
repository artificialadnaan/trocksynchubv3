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
import { BIDBOARD_TO_HUBSPOT_STAGE, normalizeStageLabel } from "./stage-mapping";
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

/**
 * Parse the exported Excel file and return project rows from Active Projects sheet.
 */
function parseActiveProjectsSheet(filePath: string): BidBoardExcelRow[] {
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

        // Log the event
        await storage.createBidboardAutomationLog({
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
): Promise<{ success: number; failed: number; errors: string[] }> {
  const result = { success: 0, failed: 0, errors: [] as string[] };

  for (const change of changes) {
    const normalizedStage = normalizeStageLabel(change.newStage);
    const hubspotLabel = BIDBOARD_TO_HUBSPOT_STAGE[normalizedStage];
    const label = hubspotLabel || normalizedStage;

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
    const normalizedNewStageEarly = normalizeStageLabel(change.newStage);
    let portfolioTriggerSucceeded = true;
    if (
      normalizedNewStageEarly === "Sent to Production" ||
      normalizedNewStageEarly === "Service - Sent to Production"
    ) {
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
      if (!portfolioTriggerSucceeded && (
        normalizedNewStageEarly === "Sent to Production" ||
        normalizedNewStageEarly === "Service - Sent to Production"
      )) {
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
