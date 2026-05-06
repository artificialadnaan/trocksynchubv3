CREATE TABLE IF NOT EXISTS "trockcrm_relay_outbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "webhook_log_id" integer REFERENCES "webhook_logs"("id") ON DELETE SET NULL,
  "sync_mapping_id" integer REFERENCES "sync_mappings"("id") ON DELETE SET NULL,
  "procore_portfolio_project_id" text NOT NULL,
  "project_number" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_attempt_at" timestamp,
  "last_error" text,
  "last_response_status" integer,
  "last_response_body" text,
  "created_at" timestamp DEFAULT now(),
  "sent_at" timestamp,
  "next_retry_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_trockcrm_relay_outbox_status_retry"
  ON "trockcrm_relay_outbox" ("status", "next_retry_at");

CREATE INDEX IF NOT EXISTS "idx_trockcrm_relay_outbox_webhook_log"
  ON "trockcrm_relay_outbox" ("webhook_log_id");

CREATE INDEX IF NOT EXISTS "idx_trockcrm_relay_outbox_sync_mapping"
  ON "trockcrm_relay_outbox" ("sync_mapping_id");

CREATE INDEX IF NOT EXISTS "idx_trockcrm_relay_outbox_project"
  ON "trockcrm_relay_outbox" ("procore_portfolio_project_id", "project_number");
