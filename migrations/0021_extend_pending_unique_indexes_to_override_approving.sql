-- Extend the RFP "pending"-uniqueness partial indexes to ALSO cover the transient
-- 'override_approving' status used by the override-approve claim.
--
-- An override-approve atomically claims a declined request into 'override_approving' while it
-- creates the BidBoard project in the background. Without covering that status, a concurrent
-- re-bid webhook (a NEW 'pending' row for the same source deal / project number) can be inserted
-- alongside the in-flight override under PostgreSQL read-committed isolation, then later approved
-- into a DUPLICATE Procore project. Covering 'override_approving' here makes that insert — and a
-- claim racing a competing pending — conflict at the DB level, fully closing the window the
-- application-level conflict checks could only narrow.
--
-- NOTE: SyncHub does NOT auto-run migrations. Apply this manually on deploy:
--   railway connect Postgres   (then paste this file)
-- The index NAMES are unchanged, so createRfpApprovalRequest's existing unique-violation handlers
-- (which key off these index names) keep working.
--
-- Wrapped in an explicit transaction so the DROP and the re-CREATE are atomic: if a CREATE UNIQUE
-- ever fails (e.g. a pre-existing duplicate the broader predicate now catches), the whole thing rolls
-- back and the original pending-only index is preserved — production is never left without the
-- uniqueness guard.

BEGIN;

DROP INDEX IF EXISTS idx_rfp_approval_pending_source_deal;
CREATE UNIQUE INDEX idx_rfp_approval_pending_source_deal
  ON rfp_approval_requests(source_system, source_deal_id)
  WHERE status IN ('pending', 'override_approving');

DROP INDEX IF EXISTS idx_rfp_approval_pending_project_number;
CREATE UNIQUE INDEX idx_rfp_approval_pending_project_number
  ON rfp_approval_requests(project_number)
  WHERE status IN ('pending', 'override_approving')
    AND project_number IS NOT NULL
    AND project_number != '';

COMMIT;
