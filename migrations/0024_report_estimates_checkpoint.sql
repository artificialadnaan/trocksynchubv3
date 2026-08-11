-- A SECOND checkpoint on report_schedule_config, separate from last_sent_at.
--
-- last_sent_at answers "when did a report last go out" and drives the scheduler's cadence guard, i.e.
-- delivery deduplication. The estimates section needs a different answer — "how far has the CRM lookup
-- successfully covered" — because it fails independently of the email. One column could not do both:
-- gating last_sent_at on the lookup let two eligible slots inside one cadence each send a report, while
-- advancing it regardless permanently skipped whatever interval the CRM did not answer for.
--
-- Nullable, and idempotent: an existing deployment simply falls back to the cadence duration until the
-- first successful lookup records a boundary.
ALTER TABLE report_schedule_config
  ADD COLUMN IF NOT EXISTS estimates_covered_through timestamptz;
