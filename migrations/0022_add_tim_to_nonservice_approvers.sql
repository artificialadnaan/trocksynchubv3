-- Add Tim Mitchell (tmitchell@trockgc.com) as a full approver on the
-- non-service ('*') RFP approver routing row, alongside Sidney + James.
-- Service routing (project_type '4' = James + Colby) is intentionally untouched.
--
-- IMPORTANT: this repo does NOT auto-apply migrations on deploy. Adnaan must
-- run this manually against prod via `railway connect Postgres`.
--
-- FIRST run this census to confirm there are no extra per-source_system
-- non-service rows that ALSO need Tim (the UPDATE below only touches the
-- source_system IS NULL wildcard row):
--
--   SELECT project_type, source_system, approver_emails, is_active
--   FROM rfp_approver_config
--   WHERE is_active = true
--   ORDER BY project_type, source_system;
--
-- The '*' row already exists (seeded in 0017 with ON CONFLICT DO NOTHING).
-- APPEND Tim to whatever is already there (preserving existing recipients and
-- their order) instead of overwriting the array, so any approvers added to this
-- row out-of-band are not silently dropped. The NOT (... = ANY(...)) guard makes
-- it idempotent: rerunning will not duplicate Tim and is a no-op once he's present.

UPDATE rfp_approver_config
SET approver_emails = approver_emails || ARRAY['tmitchell@trockgc.com'],
    updated_at = now()
WHERE project_type = '*'
  AND source_system IS NULL
  AND NOT ('tmitchell@trockgc.com' = ANY(approver_emails));
