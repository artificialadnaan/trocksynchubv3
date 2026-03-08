/**
 * Reconciliation Writeback — Push resolved values to external systems
 */

import { db } from "../../db";
import { eq, and, count } from "drizzle-orm";
import {
  reconciliationProjects,
  reconciliationConflicts,
  reconciliationAuditLog,
} from "@shared/reconciliation-schema";
import { updateHubSpotDeal } from "../../hubspot";

const fieldMappings: Record<
  string,
  { procore: string; hubspot: string }
> = {
  project_number: { procore: "project_number", hubspot: "project_number" },
  name: { procore: "name", hubspot: "dealname" },
  location: { procore: "address", hubspot: "address" },
  amount: { procore: "estimated_value", hubspot: "amount" },
  stage: { procore: "stage", hubspot: "dealstage" },
};

export interface WritebackResult {
  success: boolean;
  writebackFailed?: boolean;
  error?: string;
}

export async function writebackResolution(
  reconciliationProjectId: number,
  fieldName: string,
  resolvedValue: string,
  resolvedSource: "procore" | "hubspot" | "manual",
  performedBy: string,
  options: { writeback?: boolean } = {}
): Promise<WritebackResult> {
  const mapping = fieldMappings[fieldName];
  if (!mapping) {
    return { success: false, error: `Unknown field: ${fieldName}` };
  }

  const [project] = await db
    .select()
    .from(reconciliationProjects)
    .where(eq(reconciliationProjects.id, reconciliationProjectId))
    .limit(1);

  if (!project) {
    return { success: false, error: "Reconciliation project not found" };
  }

  let writebackFailed = false;

  if (options.writeback !== false && project.hubspotDealId) {
    if (resolvedSource === "procore" || resolvedSource === "manual") {
      const props: Record<string, string> = { [mapping.hubspot]: resolvedValue };
      const result = await updateHubSpotDeal(project.hubspotDealId, props);
      if (!result.success) {
        writebackFailed = true;
      }
    }
  }

  const previousValue =
    resolvedSource === "procore"
      ? (project.hubspotData as any)?.[mapping.hubspot]
      : (project.procoreData as any)?.[mapping.procore];

  await db.insert(reconciliationAuditLog).values({
    reconciliationProjectId,
    action:
      resolvedSource === "manual"
        ? ("manual_override" as const)
        : resolvedSource === "procore"
          ? ("accept_procore" as const)
          : ("accept_hubspot" as const),
    fieldName,
    previousValue: previousValue != null ? String(previousValue) : null,
    newValue: resolvedValue,
    source: resolvedSource,
    performedBy,
    snapshotBefore: {
      procore: project.procoreData,
      hubspot: project.hubspotData,
    },
  });

  await db
    .update(reconciliationConflicts)
    .set({
      isResolved: true,
      resolvedValue,
      resolvedSource,
      resolvedBy: performedBy,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(reconciliationConflicts.reconciliationProjectId, reconciliationProjectId),
        eq(reconciliationConflicts.fieldName, fieldName)
      )
    );

  const [unresolvedCount] = await db
    .select({ count: count() })
    .from(reconciliationConflicts)
    .where(
      and(
        eq(reconciliationConflicts.reconciliationProjectId, reconciliationProjectId),
        eq(reconciliationConflicts.isResolved, false)
      )
    );

  if (unresolvedCount.count === 0) {
    await db
      .update(reconciliationProjects)
      .set({
        bucket: "resolved",
        isResolved: true,
        resolvedBy: performedBy,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reconciliationProjects.id, reconciliationProjectId));
  }

  return {
    success: true,
    writebackFailed: writebackFailed || undefined,
  };
}
