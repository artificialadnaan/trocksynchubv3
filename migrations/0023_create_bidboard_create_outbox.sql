-- Durable command outbox for create-from-rfp (findings V1-V4): the endpoint persists a command row before its
-- 202, and a serial worker does the eligibility recheck + guards + Playwright create + callback enqueue.
--
-- Also drops NOT NULL on bidboard_callback_outbox.rfp_approval_request_id (finding S2): voting-path callbacks
-- mint no rfp_approval_requests row, so they persist here with a NULL request id (keyed by source_deal_id). The
-- existing unique index on that column keeps deduping the request-backed path (NULLs are distinct in Postgres
-- unique indexes, so voting rows aren't collapsed by it).

CREATE TABLE IF NOT EXISTS bidboard_create_outbox (
  id serial PRIMARY KEY,
  source_system text NOT NULL,
  source_deal_id text NOT NULL,
  source_event_id text NOT NULL,
  project_number text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  processed_at timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bidboard_create_outbox_source_event
  ON bidboard_create_outbox(source_event_id);

CREATE INDEX IF NOT EXISTS idx_bidboard_create_outbox_pending
  ON bidboard_create_outbox(status, next_attempt_at)
  WHERE status = 'pending';

ALTER TABLE bidboard_callback_outbox ALTER COLUMN rfp_approval_request_id DROP NOT NULL;
