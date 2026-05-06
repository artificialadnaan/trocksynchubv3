-- Allow hubspot_deal_id to be NULL so CRM-sourced RFP approvals can be inserted
-- without a HubSpot reference. Source identity is now carried by
-- (source_system, source_deal_id) — see migration 0014.

ALTER TABLE rfp_approval_requests
  ALTER COLUMN hubspot_deal_id DROP NOT NULL;
