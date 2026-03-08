/**
 * Reconciliation Persister — Upsert match results to database
 */

import { db } from "../../db";
import { eq, and } from "drizzle-orm";
import {
  reconciliationProjects,
  reconciliationConflicts,
} from "@shared/reconciliation-schema";
import type { MatchCandidate } from "./matcher";

type ReconciliationBucket =
  | "exact_match"
  | "fuzzy_match"
  | "orphan_procore"
  | "orphan_hubspot"
  | "orphan_bidboard"
  | "conflict"
  | "resolved"
  | "ignored";

async function findExistingReconciliationProject(
  procoreId: string | null,
  hubspotId: string | null
) {
  if (procoreId) {
    const [r] = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.procoreProjectId, procoreId))
      .limit(1);
    return r;
  }
  if (hubspotId) {
    const [r] = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.hubspotDealId, hubspotId))
      .limit(1);
    return r;
  }
  return null;
}

export async function persistReconciliationResults(
  candidates: MatchCandidate[],
  scanRunId: number
): Promise<void> {
  for (const candidate of candidates) {
    let bucket: ReconciliationBucket;
    if (candidate.matchMethod === "none") {
      bucket = candidate.procoreProject ? "orphan_procore" : "orphan_hubspot";
    } else if (candidate.conflicts.length > 0) {
      bucket = "conflict";
    } else if (candidate.matchMethod === "name_fuzzy") {
      bucket = "fuzzy_match";
    } else {
      bucket = "exact_match";
    }

    const procoreId = candidate.procoreProject?.sourceId ?? null;
    const hubspotId = candidate.hubspotDeal?.sourceId ?? null;
    const bidboardId = candidate.bidboardItem?.sourceId ?? null;

    const existing = await findExistingReconciliationProject(procoreId, hubspotId);

    if (existing) {
      if (!existing.isResolved) {
        await db
          .update(reconciliationProjects)
          .set({
            bucket,
            matchConfidence: candidate.confidence,
            matchMethod: candidate.matchMethod,
            procoreData:
              (candidate.procoreProject?.rawData ?? existing.procoreData) as any,
            hubspotData:
              (candidate.hubspotDeal?.rawData ?? existing.hubspotData) as any,
            bidboardData:
              (candidate.bidboardItem?.rawData ?? existing.bidboardData) as any,
            lastScannedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reconciliationProjects.id, existing.id));

        // Sync conflicts: delete existing unresolved, insert new
        await db
          .delete(reconciliationConflicts)
          .where(
            and(
              eq(reconciliationConflicts.reconciliationProjectId, existing.id),
              eq(reconciliationConflicts.isResolved, false)
            )
          );

        if (candidate.conflicts.length > 0) {
          await db.insert(reconciliationConflicts).values(
            candidate.conflicts.map((c) => ({
              reconciliationProjectId: existing.id,
              fieldName: c.fieldName,
              procoreValue: c.procoreValue,
              hubspotValue: c.hubspotValue,
              bidboardValue: c.bidboardValue,
              severity: c.severity,
            }))
          );
        }

        // Drift detection: if resolved project has new conflicts, re-flag
        const hasNewConflicts = candidate.conflicts.length > 0;
        if (hasNewConflicts && existing.bucket === "resolved") {
          await db
            .update(reconciliationProjects)
            .set({ bucket: "conflict", isResolved: false, updatedAt: new Date() })
            .where(eq(reconciliationProjects.id, existing.id));
        }
      } else {
        // Update snapshots for monitoring, preserve resolution
        await db
          .update(reconciliationProjects)
          .set({
        procoreData:
          (candidate.procoreProject?.rawData ?? existing.procoreData) as any,
        hubspotData: (candidate.hubspotDeal?.rawData ?? existing.hubspotData) as any,
            lastScannedAt: new Date(),
          })
          .where(eq(reconciliationProjects.id, existing.id));
      }
    } else {
      const [inserted] = await db
        .insert(reconciliationProjects)
        .values({
          procoreProjectId: procoreId as any,
          hubspotDealId: hubspotId as any,
          bidboardItemId: bidboardId as any,
          procoreData: (candidate.procoreProject?.rawData ?? null) as any,
          hubspotData: (candidate.hubspotDeal?.rawData ?? null) as any,
          bidboardData: (candidate.bidboardItem?.rawData ?? null) as any,
          bucket,
          matchConfidence: candidate.confidence,
          matchMethod: candidate.matchMethod,
        })
        .returning();

      if (inserted && candidate.conflicts.length > 0) {
        await db.insert(reconciliationConflicts).values(
          candidate.conflicts.map((c) => ({
            reconciliationProjectId: inserted.id,
            fieldName: c.fieldName,
            procoreValue: c.procoreValue,
            hubspotValue: c.hubspotValue,
            bidboardValue: c.bidboardValue,
            severity: c.severity,
          }))
        );
      }
    }
  }
}
