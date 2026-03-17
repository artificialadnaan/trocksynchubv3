/**
 * Bid Board → HubSpot Stage Mapping
 * ==================================
 *
 * Maps Procore Bid Board status values (from Excel export) to HubSpot deal stage labels.
 * The actual HubSpot stage IDs are resolved at runtime via resolveHubspotStageId()
 * from procore-hubspot-sync. Keys are normalized (Unicode dashes → hyphen) for lookup.
 *
 * @module sync/stage-mapping
 */

/** Normalize Unicode dashes to ASCII hyphen for consistent stage lookup */
export function normalizeStageLabel(s: string): string {
  return s.replace(/[\u2013\u2014\u2212\uFE58\uFE63\uFF0D]/g, "-").trim();
}

/** Bid Board Status (Excel column) → HubSpot stage label (use hyphen in keys) */
export const BIDBOARD_TO_HUBSPOT_STAGE: Record<string, string> = {
  "Service - Estimating": "Service – Estimating",
  "Estimate in Progress": "Estimating",
  "Estimate Under Review": "Internal Review",
  "Estimate Sent to Client": "Proposal Sent",
  "Service - Sent to Production": "Service – Won",
  "Sent to Production": "Closed Won",
  "Service - Lost": "Service – Lost",
  "Production Lost": "Closed Lost",
};
