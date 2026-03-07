/**
 * Bid Board → HubSpot Stage Mapping
 * ==================================
 *
 * Maps Procore Bid Board status values (from Excel export) to HubSpot deal stage labels.
 * The actual HubSpot stage IDs are resolved at runtime via resolveHubspotStageId()
 * from procore-hubspot-sync. Edit this config to match your pipeline.
 *
 * TODO: Fill in actual HubSpot stage IDs if you prefer direct ID mapping instead of labels.
 *
 * @module sync/stage-mapping
 */

/** Bid Board Status (Excel column) → HubSpot stage label */
export const BIDBOARD_TO_HUBSPOT_STAGE: Record<string, string> = {
  "Service - Estimating": "Service – Estimating",
  "Estimate in Progress": "Estimating",
  "Estimate Under Review": "Internal Review",
  "Estimate Sent to Client": "Proposal Sent",
  "Service - Sent to Production": "Service – Won",
  "Sent to Production": "Closed Won",
  "Service - Lost": "Service – Lost",
  "Production Lost": "Closed Lost",
  // Variants with different dash/character encoding
  "Service – Estimating": "Service – Estimating",
  "Service – Sent to Production": "Service – Won",
  "Service – Lost": "Service – Lost",
  "Production – Lost": "Closed Lost",
};
