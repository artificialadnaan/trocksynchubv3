/**
 * Reconciliation Engine — Orchestrates fetch → classify → persist
 */

import { db } from "../../db";
import { eq, desc } from "drizzle-orm";
import {
  reconciliationScanRuns,
  legacyNumberMappings,
} from "@shared/reconciliation-schema";
import { fetchProcoreProjects, fetchHubSpotDeals, fetchBidBoardItems } from "./fetcher";
import { classifyAllProjects } from "./matcher";
import { persistReconciliationResults } from "./persister";

export interface ScanResult {
  scanRunId: number;
  totalProjects: number;
  exactMatches: number;
  fuzzyMatches: number;
  orphansProcore: number;
  orphansHubspot: number;
  conflicts: number;
  resolved: number;
  error?: string;
}

export async function runReconciliationScan(
  triggeredBy: string
): Promise<ScanResult> {
  const [scanRun] = await db
    .insert(reconciliationScanRuns)
    .values({
      startedAt: new Date(),
      triggeredBy,
    })
    .returning();

  const scanRunId = scanRun!.id;

  try {
    // Phase 1: Fetch
    const [procoreProjects, hubspotDeals, bidboardItems] = await Promise.all([
      fetchProcoreProjects(),
      fetchHubSpotDeals(),
      fetchBidBoardItems(),
    ]);

    // Load legacy mappings
    const mappings = await db.select().from(legacyNumberMappings);
    const legacyMappings = mappings.map((m) => ({
      legacyNumber: m.legacyNumber,
      canonicalNumber: m.canonicalNumber,
    }));

    // Phase 2: Classify
    const candidates = await classifyAllProjects(
      procoreProjects,
      hubspotDeals,
      bidboardItems,
      legacyMappings
    );

    // Phase 3: Persist
    await persistReconciliationResults(candidates, scanRunId);

    // Compute metrics
    const metrics = {
      totalProjects: candidates.length,
      exactMatches: candidates.filter((c) => c.matchMethod === "exact_number").length,
      fuzzyMatches: candidates.filter((c) => c.matchMethod === "name_fuzzy").length,
      orphansProcore: candidates.filter(
        (c) => c.matchMethod === "none" && c.procoreProject
      ).length,
      orphansHubspot: candidates.filter(
        (c) => c.matchMethod === "none" && c.hubspotDeal
      ).length,
      conflicts: candidates.filter((c) => c.conflicts.length > 0 && c.matchMethod !== "none").length,
      resolved: 0, // Would need to count from DB
    };

    // Update scan run
    await db
      .update(reconciliationScanRuns)
      .set({
        completedAt: new Date(),
        totalProjects: metrics.totalProjects,
        exactMatches: metrics.exactMatches,
        fuzzyMatches: metrics.fuzzyMatches,
        orphansProcore: metrics.orphansProcore,
        orphansHubspot: metrics.orphansHubspot,
        conflicts: metrics.conflicts,
        resolved: metrics.resolved,
      })
      .where(eq(reconciliationScanRuns.id, scanRunId));

    return {
      scanRunId,
      ...metrics,
    };
  } catch (err: any) {
    await db
      .update(reconciliationScanRuns)
      .set({
        completedAt: new Date(),
        error: err.message,
      })
      .where(eq(reconciliationScanRuns.id, scanRunId));

    return {
      scanRunId,
      totalProjects: 0,
      exactMatches: 0,
      fuzzyMatches: 0,
      orphansProcore: 0,
      orphansHubspot: 0,
      conflicts: 0,
      resolved: 0,
      error: err.message,
    };
  }
}

export async function getLastScanStatus(): Promise<{
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  totalProjects: number | null;
  conflicts: number | null;
  error: string | null;
  triggeredBy: string | null;
} | null> {
  const [run] = await db
    .select()
    .from(reconciliationScanRuns)
    .orderBy(desc(reconciliationScanRuns.startedAt))
    .limit(1);
  return run ?? null;
}
