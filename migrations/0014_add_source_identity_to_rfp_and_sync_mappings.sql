-- Add source identity to RFP approvals and sync mappings for HubSpot + T Rock CRM parallel operation.
-- This migration is additive and backfills existing rows as HubSpot-owned before enforcing NOT NULL.

ALTER TABLE rfp_approval_requests
  ADD COLUMN IF NOT EXISTS source_system text NOT NULL DEFAULT 'hubspot',
  ADD COLUMN IF NOT EXISTS source_deal_id text,
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS project_number text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamp;

UPDATE rfp_approval_requests
SET
  source_system = COALESCE(NULLIF(source_system, ''), 'hubspot'),
  source_deal_id = COALESCE(NULLIF(source_deal_id, ''), hubspot_deal_id),
  project_number = COALESCE(NULLIF(project_number, ''), deal_data->>'project_number')
WHERE source_deal_id IS NULL
   OR source_deal_id = ''
   OR source_system IS NULL
   OR source_system = ''
   OR project_number IS NULL
   OR project_number = '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rfp_approval_requests
    WHERE source_deal_id IS NULL OR source_deal_id = ''
  ) THEN
    RAISE EXCEPTION 'Cannot enforce rfp_approval_requests.source_deal_id NOT NULL: rows remain without hubspot_deal_id/source_deal_id';
  END IF;
END $$;

ALTER TABLE rfp_approval_requests
  ALTER COLUMN source_system SET DEFAULT 'hubspot',
  ALTER COLUMN source_system SET NOT NULL,
  ALTER COLUMN source_deal_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rfp_approval_requests
    WHERE status = 'pending'
    GROUP BY source_system, source_deal_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create pending RFP source uniqueness index: duplicate pending source_system/source_deal_id rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approval_pending_source_deal
  ON rfp_approval_requests(source_system, source_deal_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_rfp_approval_project_number
  ON rfp_approval_requests(project_number);

ALTER TABLE sync_mappings
  ADD COLUMN IF NOT EXISTS source_system text NOT NULL DEFAULT 'hubspot',
  ADD COLUMN IF NOT EXISTS source_deal_id text;

UPDATE sync_mappings
SET
  source_system = COALESCE(NULLIF(source_system, ''), 'hubspot'),
  source_deal_id = COALESCE(
    NULLIF(source_deal_id, ''),
    hubspot_deal_id,
    bidboard_project_id,
    portfolio_project_id,
    procore_project_id,
    'legacy-sync-mapping-' || id::text
  )
WHERE source_deal_id IS NULL
   OR source_deal_id = ''
   OR source_system IS NULL
   OR source_system = '';

ALTER TABLE sync_mappings
  ALTER COLUMN source_system SET DEFAULT 'hubspot',
  ALTER COLUMN source_system SET NOT NULL,
  ALTER COLUMN source_deal_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sync_mappings
    GROUP BY source_system, source_deal_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create sync_mappings source uniqueness index: duplicate source_system/source_deal_id rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_mappings_source_deal
  ON sync_mappings(source_system, source_deal_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_mappings_bidboard_project_id
  ON sync_mappings(bidboard_project_id)
  WHERE bidboard_project_id IS NOT NULL;
