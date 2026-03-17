-- RFP Reporting & Scheduled Email - New tables
-- =============================================
-- rfp_change_log: automatic audit trail for RFP updates
-- rfp_approvals: approval chain tracking (multi-approver support)
-- report_schedule_config: email schedule preferences

-- Create enum for approval status
DO $$ BEGIN
  CREATE TYPE rfp_approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create enum for report frequency
DO $$ BEGIN
  CREATE TYPE report_frequency AS ENUM ('daily', 'weekly', 'biweekly', 'monthly');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- rfp_change_log: captures every column change on rfp_approval_requests
CREATE TABLE IF NOT EXISTS rfp_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id INTEGER NOT NULL REFERENCES rfp_approval_requests(id) ON DELETE CASCADE,
  field_changed VARCHAR(255) NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by VARCHAR(255),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfp_change_log_rfp_id ON rfp_change_log(rfp_id);
CREATE INDEX IF NOT EXISTS idx_rfp_change_log_changed_at ON rfp_change_log(changed_at);

-- rfp_approvals: approval chain (can have multiple approvers per RFP)
CREATE TABLE IF NOT EXISTS rfp_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_id INTEGER NOT NULL REFERENCES rfp_approval_requests(id) ON DELETE CASCADE,
  approver_email VARCHAR(255) NOT NULL,
  status rfp_approval_status NOT NULL DEFAULT 'pending',
  comments TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfp_approvals_rfp_id ON rfp_approvals(rfp_id);

-- report_schedule_config: single row for schedule preferences
CREATE TABLE IF NOT EXISTS report_schedule_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL DEFAULT false,
  frequency report_frequency NOT NULL DEFAULT 'weekly',
  day_of_week INTEGER,
  time_of_day TIME NOT NULL DEFAULT '08:00',
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Chicago',
  recipients TEXT[] NOT NULL DEFAULT '{}',
  include_rfp_log BOOLEAN NOT NULL DEFAULT true,
  include_change_history BOOLEAN NOT NULL DEFAULT true,
  include_approval_summary BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Insert default config row if none exists
INSERT INTO report_schedule_config (id, enabled, frequency, time_of_day, timezone, updated_at)
SELECT gen_random_uuid(), false, 'weekly', '08:00'::time, 'America/Chicago', now()
WHERE NOT EXISTS (SELECT 1 FROM report_schedule_config LIMIT 1);
