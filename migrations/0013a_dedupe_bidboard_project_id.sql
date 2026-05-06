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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sync_mappings 
    WHERE id = 754 
      AND hubspot_deal_id = '318186066630'
      AND bidboard_project_id = '562949955676785'
  ) THEN
    RAISE EXCEPTION 'Expected sync_mappings row id=754 with hubspot_deal_id=318186066630, bidboard_project_id=562949955676785 not found. Aborting dedup.';
  END IF;
END $$;

DELETE FROM sync_mappings 
WHERE id = 754 
  AND hubspot_deal_id = '318186066630'
  AND bidboard_project_id = '562949955676785';
