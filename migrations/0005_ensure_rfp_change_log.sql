-- Ensure rfp_change_log table exists (fixes deployments where 0002 failed for this table)
-- rfp_change_log is required by 0003 trigger and by rfp-reports queries

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
