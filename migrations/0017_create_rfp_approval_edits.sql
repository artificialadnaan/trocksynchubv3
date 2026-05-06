-- Store source-specific review-page edits before they are written back to CRM.
-- HubSpot write-back remains synchronous in Phase 3; CRM write-back is wired in Phase 5.

CREATE TABLE IF NOT EXISTS rfp_approval_edits (
  id serial PRIMARY KEY,
  rfp_approval_request_id integer NOT NULL REFERENCES rfp_approval_requests(id) ON DELETE CASCADE,
  edited_fields jsonb NOT NULL,
  edited_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfp_approval_edits_request_id
  ON rfp_approval_edits(rfp_approval_request_id);
