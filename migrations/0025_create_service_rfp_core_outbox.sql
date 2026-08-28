-- Durable outbound outbox for the approved-service-RFP handoff to TROCK Core. Shaped like
-- bidboard_callback_outbox (per-row target_url, attempt accounting, backoff, dead-lettering) rather
-- than bidboard_create_outbox: that table has no command-kind column and its claim query has no type
-- filter, so the Playwright worker would claim a Core-shaped row and create a SECOND Procore project,
-- and its global unique index on source_event_id would let the two commands overwrite each other's
-- payload.
--
-- target_url is NULLABLE, unlike the callback outbox. A refusal recorded BEFORE any POST (a
-- HubSpot-sourced service RFP, or an office with no Core tenant) has no destination at all; a
-- fabricated URL would make a permanently-undeliverable row look drainable.

CREATE TABLE IF NOT EXISTS service_rfp_core_outbox (
  id serial PRIMARY KEY,
  source_system text NOT NULL,
  source_deal_id text NOT NULL,
  rfp_request_id integer NOT NULL,
  payload jsonb NOT NULL,
  target_url text,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  -- One MORE than the number of backoff intervals the worker declares: five waits describe the gaps
  -- between six attempts, and this value WINS at runtime (the worker reads it off the claimed row), so
  -- a default equal to the interval count would dead-letter the row before its last — two-hour — retry
  -- ever ran. See SERVICE_RFP_CORE_MAX_ATTEMPTS in server/sync/service-rfp-core-outbox.ts.
  max_attempts integer NOT NULL DEFAULT 6,
  last_error text,
  last_status_code integer,
  core_bid_id text,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
);

-- processRfpApproval is not idempotent and both entry points are fire-and-forget behind a 202. This
-- triple is what makes a concurrent re-entry safe: the second insert conflicts and posts nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_rfp_core_outbox_request
  ON service_rfp_core_outbox(source_system, source_deal_id, rfp_request_id);

CREATE INDEX IF NOT EXISTS idx_service_rfp_core_outbox_pending
  ON service_rfp_core_outbox(status, next_attempt_at)
  WHERE status = 'pending';
