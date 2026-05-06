-- Durable outbox for SyncHub -> T Rock CRM BidBoard-created callbacks.
-- Ensures CRM-sourced RFP approvals hard-link the CRM deal to the created BidBoard project.

CREATE TABLE IF NOT EXISTS bidboard_callback_outbox (
  id serial PRIMARY KEY,
  source_system text NOT NULL,
  source_deal_id text NOT NULL,
  rfp_approval_request_id integer NOT NULL REFERENCES rfp_approval_requests(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  target_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bidboard_callback_outbox_rfp_request
  ON bidboard_callback_outbox(rfp_approval_request_id);

CREATE INDEX IF NOT EXISTS idx_bidboard_callback_outbox_pending
  ON bidboard_callback_outbox(status, next_attempt_at)
  WHERE status = 'pending';
