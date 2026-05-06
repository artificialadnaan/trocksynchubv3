-- RFP approver routing configuration.
-- TODO: Build an admin settings UI; for now this table is maintained via SQL.

CREATE TABLE IF NOT EXISTS rfp_approver_config (
  id serial PRIMARY KEY,
  project_type text NOT NULL,
  source_system text,
  approver_emails text[] NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approver_config_project_source
  ON rfp_approver_config(project_type, COALESCE(source_system, '__all__'));

INSERT INTO rfp_approver_config (project_type, source_system, approver_emails, is_active)
VALUES
  ('4', NULL, ARRAY['jhelms@trockgc.com', 'cburling@trockgc.com'], true),
  ('*', NULL, ARRAY['sgibson@trockgc.com', 'jhelms@trockgc.com'], true)
ON CONFLICT DO NOTHING;
