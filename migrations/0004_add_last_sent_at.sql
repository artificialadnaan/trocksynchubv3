-- Add last_sent_at to report_schedule_config for RFP report scheduler
-- Tracks when the last scheduled report email was sent

ALTER TABLE report_schedule_config
ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ DEFAULT NULL;
