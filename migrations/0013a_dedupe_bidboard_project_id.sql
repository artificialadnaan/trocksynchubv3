-- Delete the one stale sync_mappings row that points at a BidBoard 
-- project owned by a different HubSpot deal. This is the result of 
-- a March 30, 2026 stale-write bug: row id=754 was created at 
-- 21:21 attributing BidBoard project 562949955676785 to deal 
-- 318186066630, but that BidBoard project was actually created for 
-- deal 318226200296 at 19:36 (row id=749, which is canonical and 
-- matches the corresponding rfp_approval_request).
--
-- See post-cutover backlog: deal 318186066630 has a stuck pending 
-- RFP request (id=137) that needs human review.
-- This migration is idempotent and safe to re-run after the first successful application.

DO $$
DECLARE
  row_count INTEGER;
BEGIN
  -- Check if row 754 still exists at all (regardless of identity).
  SELECT COUNT(*) INTO row_count FROM sync_mappings WHERE id = 754;

  IF row_count = 0 THEN
    -- Row already deleted on a previous run. No-op.
    RAISE NOTICE 'sync_mappings row id=754 already deleted; 0013a is a no-op.';
    RETURN;
  END IF;

  -- Row exists. Verify it matches the stale-row identity before deleting.
  IF NOT EXISTS (
    SELECT 1 FROM sync_mappings
    WHERE id = 754 
      AND hubspot_deal_id = '318186066630'
      AND bidboard_project_id = '562949955676785'
  ) THEN
    RAISE EXCEPTION 'sync_mappings row id=754 exists but does not match expected identity (hubspot_deal_id=318186066630, bidboard_project_id=562949955676785). Aborting dedup — production state is not what 0013a expects.';
  END IF;
END $$;

-- The DELETE itself is naturally idempotent. If row 754 is gone, this 
-- affects 0 rows. If it's there with the expected identity, this 
-- removes it.
DELETE FROM sync_mappings 
WHERE id = 754 
  AND hubspot_deal_id = '318186066630'
  AND bidboard_project_id = '562949955676785';
