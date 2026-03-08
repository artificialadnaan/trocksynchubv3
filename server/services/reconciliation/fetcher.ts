/**
 * Reconciliation Fetcher — Fetch & Normalize project data from Procore, HubSpot, BidBoard
 */

import { storage } from "../../storage";
import type {
  ProcoreProjectSnapshot,
  HubSpotDealSnapshot,
  BidBoardItemSnapshot,
} from "@shared/reconciliation-schema";
import { procoreBidPackages } from "@shared/schema";
import { db } from "../../db";

export interface NormalizedProject {
  source: "procore" | "hubspot" | "bidboard";
  sourceId: string;
  name: string;
  projectNumber: string | null;
  normalizedNumber: string | null;
  location: string | null;
  amount: number | null;
  stage: string | null;
  rawData: ProcoreProjectSnapshot | HubSpotDealSnapshot | BidBoardItemSnapshot;
}

/**
 * Normalize a project number for comparison.
 */
export function normalizeProjectNumber(raw: string | null): string | null {
  if (!raw || raw.trim() === "" || raw.toLowerCase() === "none") return null;
  return raw.trim().toUpperCase().replace(/\s+/g, "-");
}

/**
 * Normalize location for comparison.
 */
export function normalizeLocation(
  address: string | null,
  city: string | null,
  state: string | null,
  zip: string | null
): string | null {
  const parts = [address, city, state, zip].filter(Boolean);
  if (parts.length === 0) return null;
  return parts
    .join(", ")
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .trim();
}

function parseAmount(val: string | number | null): number | null {
  if (val == null) return null;
  if (typeof val === "number" && !isNaN(val)) return val;
  const n = parseFloat(String(val).replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * Fetch all Procore projects from cache and normalize.
 */
export async function fetchProcoreProjects(): Promise<NormalizedProject[]> {
  const { data } = await storage.getProcoreProjects({ limit: 10000, offset: 0 });
  const fetchedAt = new Date().toISOString();

  return data.map((p) => {
    const address = p.address || null;
    const city = p.city || null;
    const state = p.stateCode || null;
    const zip = p.zip || null;
    const estimatedValue = parseAmount(p.estimatedValue);
    const totalValue = parseAmount(p.totalValue);
    const amount = estimatedValue ?? totalValue;

    const snapshot: ProcoreProjectSnapshot = {
      id: p.procoreId,
      name: p.name || p.displayName || "",
      projectNumber: p.projectNumber || null,
      stage: p.stage || p.projectStageName || null,
      status: p.active ? "Active" : "Inactive",
      address,
      city,
      state,
      zip,
      estimatedValue,
      actualValue: totalValue,
      startDate: p.startDate || null,
      completionDate: p.completionDate || null,
      projectManager: null,
      superintendent: null,
      fetchedAt,
    };

    const location = normalizeLocation(address, city, state, zip);

    return {
      source: "procore",
      sourceId: p.procoreId,
      name: p.name || p.displayName || "",
      projectNumber: p.projectNumber || null,
      normalizedNumber: normalizeProjectNumber(p.projectNumber),
      location,
      amount,
      stage: p.stage || p.projectStageName || null,
      rawData: snapshot,
    };
  });
}

/**
 * Fetch all HubSpot deals from cache and normalize.
 */
export async function fetchHubSpotDeals(): Promise<NormalizedProject[]> {
  const { data } = await storage.getHubspotDeals({ limit: 10000, offset: 0 });
  const fetchedAt = new Date().toISOString();

  return data.map((d) => {
    const p = (d.properties as Record<string, unknown>) || {};
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
      pipelineId: d.pipeline || null,
      amount,
      address: address || null,
      city,
      state,
      zip,
      closeDate: d.closeDate || null,
      ownerName: d.ownerName || null,
      fetchedAt,
    };

    const location = normalizeLocation(address, city, state, zip);

    return {
      source: "hubspot" as const,
      sourceId: d.hubspotId,
      name: d.dealName || "",
      projectNumber: projectNumber || null,
      normalizedNumber: normalizeProjectNumber(projectNumber || null),
      location,
      amount,
      stage: d.dealStage || null,
      rawData: snapshot,
    };
  });
}

/**
 * Fetch all BidBoard items (Procore bid packages) and normalize.
 */
export async function fetchBidBoardItems(): Promise<NormalizedProject[]> {
  const bidPackages = await db.select().from(procoreBidPackages);
  const fetchedAt = new Date().toISOString();

  return bidPackages.map((bp) => {
    const title = bp.title || bp.projectName || "";
    const projectNumber =
      (bp.properties as any)?.project_number || null;

    const snapshot: BidBoardItemSnapshot = {
      id: bp.procoreId,
      title,
      projectNumber,
      status: bp.open ? "Open" : "Closed",
      estimatedValue: null,
      bidDueDate: bp.bidDueDate || bp.formattedBidDueDate || null,
      fetchedAt,
    };

    return {
      source: "bidboard",
      sourceId: bp.procoreId,
      name: title,
      projectNumber,
      normalizedNumber: normalizeProjectNumber(projectNumber),
      location: bp.projectLocation || null,
      amount: null,
      stage: bp.open ? "Open" : "Closed",
      rawData: snapshot,
    };
  });
}
