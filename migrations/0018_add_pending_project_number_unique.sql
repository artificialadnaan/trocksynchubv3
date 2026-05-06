-- Cross-source guard: only one pending RFP per project_number across all sources.
-- Without this, the SELECT-then-INSERT idempotency path in /api/rfp-requests
-- races and can create duplicate pending RFPs from different sources.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rfp_approval_requests
    WHERE status = 'pending'
      AND project_number IS NOT NULL
      AND project_number != ''
    GROUP BY project_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create pending project_number uniqueness index: duplicate pending project_number rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approval_pending_project_number
  ON rfp_approval_requests(project_number)
  WHERE status = 'pending'
    AND project_number IS NOT NULL
    AND project_number != '';
