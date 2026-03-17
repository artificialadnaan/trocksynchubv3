-- Add category column to audit_logs for sync vs system event classification
-- sync = meaningful end-to-end sync (data created/updated in target)
-- system = polling, webhook acks, health checks, token refresh, etc.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'system';

-- Backfill: mark existing entries as sync where action indicates end-to-end data sync
UPDATE audit_logs
SET category = 'sync'
WHERE
  action ILIKE '%vendor_created%' OR action ILIKE '%vendor_updated%'
  OR action ILIKE '%project_created%' OR action ILIKE '%deal_created%' OR action ILIKE '%deal_updated%'
  OR action ILIKE '%stage_change_processed%' OR action ILIKE '%role_assignment_processed%'
  OR action ILIKE '%deactivation_closeout%' OR action ILIKE '%document%'
  OR action ILIKE '%rfp_%' OR action ILIKE '%change_order%'
  OR action ILIKE '%closeout%' OR action ILIKE '%mapping_created%' OR action ILIKE '%mapping_updated%'
  OR action ILIKE '%companycam%' OR action ILIKE '%bidboard%'
  OR action IN (
    'webhook_deal_project_created', 'webhook_deal_project_linked',
    'webhook_stage_change_processed', 'webhook_role_assignment_processed',
    'procore_hubspot_deal_created', 'procore_hubspot_deal_updated',
    'deal_project_number_assigned', 'stage_sync_processed'
  );
