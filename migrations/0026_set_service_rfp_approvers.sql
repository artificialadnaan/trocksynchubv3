-- Service RFP approvers (project_type '4'): the two people the owner named. Both get the approval email; EITHER
-- approves (one approvedBy; isAuthorizedRfpApprover accepts any listed email). Service board spec 2026-10-01, P1-3.
--
-- REPLACES the service list (today: the 0017 seed / the "James + Colby" safety net), it does not append: the spec
-- names exactly who approves sales-referred service RFPs. Non-service routing (every project_type <> '4') is
-- untouched.
--
-- IMPORTANT: this repo does NOT auto-apply migrations on deploy (see 0022). The owner runs it against prod via
-- `railway connect Postgres`, after the two placeholder emails below are replaced with the real ones.
--
-- FAIL-SAFE: while either placeholder is still in the file, the block RAISEs and writes nothing, so a placeholder
-- address can never become a service approver (which would send service RFP approvals to nobody).
--
-- FIRST run this census to see what will change (every service row, active or not; a source-specific row shadows
-- the general one in selectConfiguredRfpRecipients, so ALL of them are set, not only source_system IS NULL):
--
--   SELECT id, project_type, source_system, approver_emails, is_active
--   FROM rfp_approver_config
--   WHERE project_type = '4'
--   ORDER BY source_system NULLS FIRST;
--
-- Idempotent: rerunning sets the same list again. Approver changes are cached for up to 60 s
-- (RFP_APPROVER_CACHE_TTL_MS), so allow a minute before testing.

DO $$
DECLARE
  -- REPLACE BOTH before running. Lower-case, exact addresses.
  service_approvers text[] := ARRAY['REPLACE_WITH_FIRST_APPROVER_EMAIL', 'REPLACE_WITH_SECOND_APPROVER_EMAIL'];
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(service_approvers) AS e WHERE e LIKE 'REPLACE_WITH_%' OR e NOT LIKE '%_@_%.__%') THEN
    RAISE EXCEPTION 'service RFP approvers not set: replace both placeholder emails in this migration before running it';
  END IF;

  -- Every existing service row (any source system), so no source-specific row keeps the old list.
  UPDATE rfp_approver_config
  SET approver_emails = service_approvers,
      is_active = true,
      updated_at = now()
  WHERE project_type = '4';

  -- And the general service row, if none exists yet (the unique index is on the COALESCE expression).
  INSERT INTO rfp_approver_config (project_type, source_system, approver_emails, is_active)
  VALUES ('4', NULL, service_approvers, true)
  ON CONFLICT (project_type, (COALESCE(source_system, '__all__'))) DO NOTHING;
END $$;

-- Verify: every service row now lists exactly the two approvers.
--   SELECT project_type, source_system, approver_emails, is_active FROM rfp_approver_config WHERE project_type = '4';
