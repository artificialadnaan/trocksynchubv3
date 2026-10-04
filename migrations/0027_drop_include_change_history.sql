-- #41: drop report_schedule_config.include_change_history.
--
-- The "Include Change History" toggle has had no effect since #38 removed the change-history section from the
-- RFP report email, and #41 removed it from the code (UI, save route, Drizzle schema, email builder).
--
-- MANUAL, and ORDERED: SyncHub does not run migrations on deploy. Apply this only AFTER the #41 code is deployed.
-- Until then the running code still writes the column, so dropping it first would break saving the report
-- schedule. Once the #41 code is live, nothing reads or writes it. Idempotent.
ALTER TABLE report_schedule_config
  DROP COLUMN IF EXISTS include_change_history;
