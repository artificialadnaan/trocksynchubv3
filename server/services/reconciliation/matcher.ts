/**
 * Reconciliation Matcher — Match projects across Procore, HubSpot, BidBoard
 */

import Fuse from "fuse.js";
import type { NormalizedProject } from "./fetcher";
export interface LegacyMapping {
  legacyNumber: string;
  canonicalNumber: string | null;
}

export interface FieldConflict {
  fieldName: string;
  procoreValue: string | null;
  hubspotValue: string | null;
  bidboardValue: string | null;
  severity: "critical" | "warning" | "info";
}

export interface MatchCandidate {
  procoreProject: NormalizedProject | null;
  hubspotDeal: NormalizedProject | null;
  bidboardItem: NormalizedProject | null;
  matchMethod: "exact_number" | "legacy_map" | "name_fuzzy" | "manual" | "partial_number" | "none";
  confidence: number;
  conflicts: FieldConflict[];
}

/**
 * Parse DFW-format project numbers into components.
 */
export function parseProjectNumber(num: string): {
  prefix: string;
  type: string;
  id: string;
  suffix: string;
} | null {
  const match = num.match(/^(DFW)-(\d+)-(\d+)-([a-z]+)$/i);
  if (!match) return null;
  return {
    prefix: match[1],
    type: match[2],
    id: match[3],
    suffix: match[4],
  };
}

/**
 * String similarity using Dice coefficient.
 */
export function computeStringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));

  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Compute field-level conflicts between Procore and HubSpot.
 */
export function computeFieldConflicts(
  procore: NormalizedProject,
  hubspot: NormalizedProject
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  // Project Number — CRITICAL
  if (
    procore.projectNumber &&
    hubspot.projectNumber &&
    procore.normalizedNumber !== hubspot.normalizedNumber
  ) {
    conflicts.push({
      fieldName: "project_number",
      procoreValue: procore.projectNumber,
      hubspotValue: hubspot.projectNumber,
      bidboardValue: null,
      severity: "critical",
    });
  }

  // Amount — CRITICAL if > 10%, WARNING if 1-10%
  if (procore.amount != null && hubspot.amount != null) {
    const diff = Math.abs(procore.amount - hubspot.amount);
    const maxVal = Math.max(procore.amount, hubspot.amount, 1);
    const pctDiff = diff / maxVal;

    if (pctDiff > 0.1) {
      conflicts.push({
        fieldName: "amount",
        procoreValue: String(procore.amount),
        hubspotValue: String(hubspot.amount),
        bidboardValue: null,
        severity: "critical",
      });
    } else if (pctDiff > 0.01) {
      conflicts.push({
        fieldName: "amount",
        procoreValue: String(procore.amount),
        hubspotValue: String(hubspot.amount),
        bidboardValue: null,
        severity: "warning",
      });
    }
  }

  // Location — WARNING
  const pcLoc = procore.location;
  const hsLoc = hubspot.location;
  if (pcLoc && hsLoc && pcLoc !== hsLoc) {
    const similarity = computeStringSimilarity(pcLoc, hsLoc);
    conflicts.push({
      fieldName: "location",
      procoreValue:
        ("address" in procore.rawData ? procore.rawData.address : null) ??
        procore.location ??
        null,
      hubspotValue:
        ("address" in hubspot.rawData ? hubspot.rawData.address : null) ??
        hubspot.location ??
        null,
      bidboardValue: null,
      severity: similarity > 0.7 ? "info" : "warning",
    });
  }

  // Stage — WARNING (basic comparison)
  if (procore.stage && hubspot.stage && procore.stage !== hubspot.stage) {
    conflicts.push({
      fieldName: "stage",
      procoreValue: procore.stage,
      hubspotValue: hubspot.stage,
      bidboardValue: null,
      severity: "warning",
    });
  }

  // Name — INFO/WARNING
  if (procore.name && hubspot.name) {
    const nameA = procore.name.toLowerCase().trim();
    const nameB = hubspot.name.toLowerCase().trim();
    if (nameA !== nameB) {
      const similarity = computeStringSimilarity(nameA, nameB);
      conflicts.push({
        fieldName: "name",
        procoreValue: procore.name,
        hubspotValue: hubspot.name,
        bidboardValue: null,
        severity: similarity > 0.8 ? "info" : "warning",
      });
    }
  }

  return conflicts;
}

function findBidBoardMatch(
  bidboardItems: NormalizedProject[],
  normalizedNumber: string | null,
  matchedIds: Set<string>
): NormalizedProject | null {
  if (!normalizedNumber) return null;
  return (
    bidboardItems.find(
      (bb) =>
        bb.normalizedNumber === normalizedNumber && !matchedIds.has(bb.sourceId)
    ) ?? null
  );
}

/**
 * Classify all projects with 4-pass matching algorithm.
 */
export async function classifyAllProjects(
  procoreProjects: NormalizedProject[],
  hubspotDeals: NormalizedProject[],
  bidboardItems: NormalizedProject[],
  legacyMappings: LegacyMapping[]
): Promise<MatchCandidate[]> {
  const results: MatchCandidate[] = [];
  const matchedHubSpotIds = new Set<string>();
  const matchedBidBoardIds = new Set<string>();

  // ---- PASS 1: Exact project number match ----
  for (const pc of procoreProjects) {
    if (!pc.normalizedNumber) continue;

    const hsMatch = hubspotDeals.find(
      (hs) =>
        hs.normalizedNumber &&
        hs.normalizedNumber === pc.normalizedNumber &&
        !matchedHubSpotIds.has(hs.sourceId)
    );

    if (hsMatch) {
      matchedHubSpotIds.add(hsMatch.sourceId);
      const bbMatch = findBidBoardMatch(
        bidboardItems,
        pc.normalizedNumber,
        matchedBidBoardIds
      );
      if (bbMatch) matchedBidBoardIds.add(bbMatch.sourceId);

      results.push({
        procoreProject: pc,
        hubspotDeal: hsMatch,
        bidboardItem: bbMatch,
        matchMethod: "exact_number",
        confidence: 1.0,
        conflicts: computeFieldConflicts(pc, hsMatch),
      });
    }
  }

  // ---- PASS 2: Legacy number mapping ----
  for (const pc of procoreProjects) {
    if (results.some((r) => r.procoreProject?.sourceId === pc.sourceId))
      continue;

    const mapping = legacyMappings.find(
      (m) =>
        m.legacyNumber === pc.normalizedNumber ||
        m.canonicalNumber === pc.normalizedNumber
    );

    if (mapping) {
      const targetNumber =
        mapping.legacyNumber === pc.normalizedNumber
          ? mapping.canonicalNumber
          : mapping.legacyNumber;

      if (targetNumber) {
        const hsMatch = hubspotDeals.find(
          (hs) =>
            hs.normalizedNumber === targetNumber &&
            !matchedHubSpotIds.has(hs.sourceId)
        );

        if (hsMatch) {
          matchedHubSpotIds.add(hsMatch.sourceId);
          results.push({
            procoreProject: pc,
            hubspotDeal: hsMatch,
            bidboardItem: null,
            matchMethod: "legacy_map",
            confidence: 0.9,
            conflicts: computeFieldConflicts(pc, hsMatch),
          });
        }
      }
    }
  }

  // ---- PASS 3: Fuzzy name matching ----
  const unmatchedProcore = procoreProjects.filter(
    (pc) => !results.some((r) => r.procoreProject?.sourceId === pc.sourceId)
  );
  const unmatchedHubSpot = hubspotDeals.filter(
    (hs) => !matchedHubSpotIds.has(hs.sourceId)
  );

  if (unmatchedProcore.length > 0 && unmatchedHubSpot.length > 0) {
    const fuse = new Fuse(unmatchedHubSpot, {
      keys: ["name"],
      threshold: 0.4,
      includeScore: true,
      ignoreLocation: true,
    });

    for (const pc of unmatchedProcore) {
      const fuzzyResults = fuse.search(pc.name);
      if (fuzzyResults.length > 0 && fuzzyResults[0].score !== undefined) {
        const bestMatch = fuzzyResults[0];
        const confidence = 1 - (bestMatch.score ?? 1);

        if (confidence > 0.6 && !matchedHubSpotIds.has(bestMatch.item.sourceId)) {
          matchedHubSpotIds.add(bestMatch.item.sourceId);
          results.push({
            procoreProject: pc,
            hubspotDeal: bestMatch.item,
            bidboardItem: null,
            matchMethod: "name_fuzzy",
            confidence,
            conflicts: computeFieldConflicts(pc, bestMatch.item),
          });
        }
      }
    }
  }

  // ---- PASS 4: Orphans ----
  for (const pc of procoreProjects) {
    if (!results.some((r) => r.procoreProject?.sourceId === pc.sourceId)) {
      results.push({
        procoreProject: pc,
        hubspotDeal: null,
        bidboardItem: null,
        matchMethod: "none",
        confidence: 0,
        conflicts: [],
      });
    }
  }

  for (const hs of hubspotDeals) {
    if (!matchedHubSpotIds.has(hs.sourceId)) {
      results.push({
        procoreProject: null,
        hubspotDeal: hs,
        bidboardItem: null,
        matchMethod: "none",
        confidence: 0,
        conflicts: [],
      });
    }
  }

  return results;
}
