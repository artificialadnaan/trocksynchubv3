-- Add Tim Mitchell (tmitchell@trockgc.com) as a full approver on ALL
-- non-service RFP approver routing rows, alongside the existing recipients.
-- Service routing (project_type '4' = James + Colby) is intentionally untouched.
--
-- WHY all non-service rows (not just '*'): getRfpReviewRecipients prefers an
-- EXACT (project_type[, source_system]) config row over the '*' wildcard
-- default. So if an active non-service config exists for a specific type
-- (e.g. project_type='2'), that row SHADOWS the wildcard and patching only '*'
-- would leave Tim off as an approver there. Patching every row where
-- project_type <> '4' covers the '*' default AND any specific non-service rows.
--
-- IMPORTANT: this repo does NOT auto-apply migrations on deploy. Adnaan must
-- run this manually against prod via `railway connect Postgres`.
--
-- FIRST run this census to see exactly which non-service rows will be patched
-- (every active row with project_type <> '4'):
--
--   SELECT project_type, source_system, approver_emails, is_active
--   FROM rfp_approver_config
--   WHERE is_active = true
--   ORDER BY project_type, source_system;
--
-- The '*' row already exists (seeded in 0017 with ON CONFLICT DO NOTHING).
-- APPEND Tim to whatever is already there (preserving existing recipients and
-- their order) instead of overwriting the array, so any approvers added to these
-- rows out-of-band are not silently dropped. The NOT (... = ANY(...)) guard makes
-- it idempotent: rerunning will not duplicate Tim and is a no-op once he's present.

UPDATE rfp_approver_config
SET approver_emails = approver_emails || ARRAY['tmitchell@trockgc.com'],
    updated_at = now()
WHERE project_type <> '4'
  AND NOT ('tmitchell@trockgc.com' = ANY(approver_emails));
