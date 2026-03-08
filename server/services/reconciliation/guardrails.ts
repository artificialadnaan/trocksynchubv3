/**
 * Reconciliation Guard Rails — Validation, Duplicate Check, Drift Detection
 */

import { db } from "../../db";
import { eq, or, and, sql } from "drizzle-orm";
import {
  reconciliationProjects,
  reconciliationConflicts,
  legacyNumberMappings,
} from "@shared/reconciliation-schema";
import { parseProjectNumber, computeFieldConflicts, type FieldConflict } from "./matcher";
import {
  normalizeProjectNumber,
  normalizeLocation,
  type NormalizedProject,
} from "./fetcher";
import { storage } from "../../storage";
import type {
  ProcoreProjectSnapshot,
  HubSpotDealSnapshot,
} from "@shared/reconciliation-schema";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  era: "legacy" | "zapier" | "synchub";
  warnings: string[];
  errors: string[];
}

export function validateProjectNumber(projectNumber: string): ValidationResult {
  const trimmed = (projectNumber || "").trim();
  if (!trimmed) {
    return {
      valid: false,
      era: "legacy",
      warnings: [],
      errors: ["Project number is empty"],
    };
  }

  const parsed = parseProjectNumber(trimmed.toUpperCase());

  if (!parsed) {
    return {
      valid: true,
      era: "legacy",
      warnings: [
        "Non-standard format — consider assigning a canonical DFW number",
      ],
      errors: [],
    };
  }

  const typeDigit = parseInt(parsed.type, 10);
  if (typeDigit < 1 || typeDigit > 9) {
    return {
      valid: true,
      era: "zapier",
      warnings: ["Unusual type digit"],
      errors: [],
    };
  }

  return {
    valid: true,
    era: "synchub",
    warnings: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Duplicate Check
// ---------------------------------------------------------------------------

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingProjects: { id: number; name: string; system: string }[];
}

export async function checkForDuplicateNumber(
  projectNumber: string,
  excludeReconciliationId?: number
): Promise<DuplicateCheckResult> {
  const normalized = (projectNumber || "").trim().toUpperCase();
  if (!normalized) {
    return { isDuplicate: false, existingProjects: [] };
  }

  const conditions = [
    eq(reconciliationProjects.canonicalProjectNumber, normalized),
    sql`(${reconciliationProjects.procoreData}->>'projectNumber')::text = ${normalized}`,
    sql`(${reconciliationProjects.hubspotData}->>'projectNumber')::text = ${normalized}`,
  ];

  let query = db
    .select({
      id: reconciliationProjects.id,
      name: reconciliationProjects.canonicalName,
      procoreId: reconciliationProjects.procoreProjectId,
      hubspotId: reconciliationProjects.hubspotDealId,
    })
    .from(reconciliationProjects)
    .where(or(...conditions));

  const rows = await query;

  const existingProjects: { id: number; name: string; system: string }[] = [];
  for (const r of rows) {
    if (excludeReconciliationId != null && r.id === excludeReconciliationId)
      continue;
    existingProjects.push({
      id: r.id,
      name: r.name || "Unknown",
      system: r.procoreId ? "procore" : r.hubspotId ? "hubspot" : "unknown",
    });
  }

  // Also check legacy_number_mappings
  const [legacyMatch] = await db
    .select()
    .from(legacyNumberMappings)
    .where(
      or(
        eq(legacyNumberMappings.legacyNumber, normalized),
        eq(legacyNumberMappings.canonicalNumber, normalized)
      )
    )
    .limit(1);

  if (legacyMatch) {
    // Legacy mapping exists — could indicate duplicate intent
    existingProjects.push({
      id: legacyMatch.id,
      name: legacyMatch.projectName || "Legacy mapping",
      system: "legacy",
    });
  }

  return {
    isDuplicate: existingProjects.length > 0,
    existingProjects,
  };
}

// ---------------------------------------------------------------------------
// Drift Detection
// ---------------------------------------------------------------------------

function parseAmount(val: string | number | null): number | null {
  if (val == null) return null;
  if (typeof val === "number" && !isNaN(val)) return val;
  const n = parseFloat(String(val).replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
}

function buildNormalizedFromProcore(p: {
  procoreId: string;
  name: string | null;
  projectNumber: string | null;
  address?: string | null;
  city?: string | null;
  stateCode?: string | null;
  zip?: string | null;
  estimatedValue?: string | number | null;
  totalValue?: string | number | null;
  stage?: string | null;
  projectStageName?: string | null;
}): NormalizedProject {
  const address = p.address || null;
  const city = p.city || null;
  const state = p.stateCode || null;
  const zip = p.zip || null;
  const estimatedValue = parseAmount(p.estimatedValue ?? null);
  const totalValue = parseAmount(p.totalValue ?? null);
  const amount = estimatedValue ?? totalValue;
  const stage = p.stage || p.projectStageName || null;

  const snapshot: ProcoreProjectSnapshot = {
    id: p.procoreId,
    name: p.name || "",
    projectNumber: p.projectNumber || null,
    stage,
    status: "Active",
    address,
    city,
    state,
    zip,
    estimatedValue,
    actualValue: totalValue,
    startDate: null,
    completionDate: null,
    projectManager: null,
    superintendent: null,
    fetchedAt: new Date().toISOString(),
  };

  const location = normalizeLocation(address, city, state, zip);

  return {
    source: "procore",
    sourceId: p.procoreId,
    name: p.name || "",
    projectNumber: p.projectNumber || null,
    normalizedNumber: normalizeProjectNumber(p.projectNumber),
    location,
    amount,
    stage,
    rawData: snapshot,
  };
}

function buildNormalizedFromHubspot(d: {
  hubspotId: string;
  dealName: string | null;
  amount?: string | number | null;
  properties?: Record<string, unknown> | null;
  dealStage?: string | null;
}): NormalizedProject {
  const p = (d.properties || {}) as Record<string, unknown>;
  const address =
    (p.address as string) ||
    [p.project_location, p.city, p.state, p.zip].filter(Boolean).join(", ") ||
    null;
  const city = (p.city as string) ?? null;
  const state = (p.state as string) ?? null;
  const zip = (p.zip as string) ?? null;
  const amount = parseAmount((p.amount as string) ?? d.amount ?? null);
  const projectNumber = (p.project_number as string) ?? null;

  const snapshot: HubSpotDealSnapshot = {
    id: d.hubspotId,
    dealName: d.dealName || "",
    projectNumber: projectNumber || null,
    dealStage: d.dealStage || null,
    pipelineId: (p.pipeline as string) ?? null,
    amount,
    address: address || null,
    city,
    state,
    zip,
    closeDate: (p.closedate as string) ?? null,
    ownerName: (p.hubspot_owner_id as string) ?? null,
    fetchedAt: new Date().toISOString(),
  };

  const location = normalizeLocation(address, city, state, zip);

  return {
    source: "hubspot",
    sourceId: d.hubspotId,
    name: d.dealName || "",
    projectNumber: projectNumber || null,
    normalizedNumber: normalizeProjectNumber(projectNumber || null),
    location,
    amount,
    stage: d.dealStage || null,
    rawData: snapshot,
  };
}

export interface DriftResult {
  drifted: boolean;
  newConflicts: FieldConflict[];
}

export async function detectFieldDrift(
  reconciliationProjectId: number
): Promise<DriftResult> {
  const [recon] = await db
    .select()
    .from(reconciliationProjects)
    .where(eq(reconciliationProjects.id, reconciliationProjectId))
    .limit(1);

  if (!recon || !recon.isResolved) {
    return { drifted: false, newConflicts: [] };
  }

  const procoreId = recon.procoreProjectId;
  const hubspotId = recon.hubspotDealId;

  if (!procoreId || !hubspotId) {
    return { drifted: false, newConflicts: [] };
  }

  const [procoreRow, hubspotRow] = await Promise.all([
    storage.getProcoreProjectByProcoreId(procoreId),
    storage.getHubspotDealByHubspotId(hubspotId),
  ]);

  if (!procoreRow || !hubspotRow) {
    return { drifted: false, newConflicts: [] };
  }

  const procore: NormalizedProject = buildNormalizedFromProcore({
    procoreId: procoreRow.procoreId,
    name: procoreRow.name || procoreRow.displayName,
    projectNumber: procoreRow.projectNumber,
    address: procoreRow.address,
    city: procoreRow.city,
    stateCode: procoreRow.stateCode,
    zip: procoreRow.zip,
    estimatedValue: procoreRow.estimatedValue,
    totalValue: procoreRow.totalValue,
    stage: procoreRow.stage || procoreRow.projectStageName,
    projectStageName: procoreRow.projectStageName,
  });

  const hubspot: NormalizedProject = buildNormalizedFromHubspot({
    hubspotId: hubspotRow.hubspotId,
    dealName: hubspotRow.dealName,
    amount: hubspotRow.amount,
    properties: hubspotRow.properties as Record<string, unknown>,
    dealStage: hubspotRow.dealStage,
  });

  const freshConflicts = computeFieldConflicts(procore, hubspot);

  if (freshConflicts.length === 0) {
    return { drifted: false, newConflicts: [] };
  }

  const newConflicts = freshConflicts;

  // Insert new conflict records
  await db.delete(reconciliationConflicts).where(
    and(
      eq(reconciliationConflicts.reconciliationProjectId, reconciliationProjectId),
      eq(reconciliationConflicts.isResolved, false)
    )
  );

  await db.insert(reconciliationConflicts).values(
    newConflicts.map((c) => ({
      reconciliationProjectId,
      fieldName: c.fieldName,
      procoreValue: c.procoreValue,
      hubspotValue: c.hubspotValue,
      bidboardValue: c.bidboardValue,
      severity: c.severity,
    }))
  );

  await db
    .update(reconciliationProjects)
    .set({
      bucket: "conflict",
      isResolved: false,
      updatedAt: new Date(),
    })
    .where(eq(reconciliationProjects.id, reconciliationProjectId));

  for (const c of newConflicts) {
    console.log(
      `[reconciliation] Drift detected on project ${reconciliationProjectId}: ${c.fieldName} changed`
    );
  }

  return { drifted: true, newConflicts };
}
