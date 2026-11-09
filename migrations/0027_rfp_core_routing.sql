-- 0027: RFP Phase 2 routing (CONTRACT v2.2 9a7e0a86 §2, §10). Hand-applied like every SyncHub migration (Dockerfile:69); ships
-- dark: with RFP_NONSERVICE_DESTINATION unset every create still goes to Procore. Additive only: no row rewritten, no column dropped.
--
-- (1) The destination STAMP lives on the create COMMAND row (one row per approval; source_event_id is already unique there).
--     The DEFAULT backfills 'procore' for every row that exists when this runs, so in-flight rows keep today's destination (§11).
ALTER TABLE bidboard_create_outbox ADD COLUMN IF NOT EXISTS destination text NOT NULL DEFAULT 'procore';
ALTER TABLE bidboard_create_outbox ADD COLUMN IF NOT EXISTS destination_setting text;
ALTER TABLE bidboard_create_outbox ADD COLUMN IF NOT EXISTS approval_kind text;
ALTER TABLE bidboard_create_outbox ADD COLUMN IF NOT EXISTS stamped_at timestamp;
DO $$ BEGIN
  ALTER TABLE bidboard_create_outbox
    ADD CONSTRAINT bidboard_create_outbox_destination_check CHECK (destination IN ('procore', 'core'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE bidboard_create_outbox
    ADD CONSTRAINT bidboard_create_outbox_approval_kind_check CHECK (approval_kind IS NULL OR approval_kind IN ('vote', 'override'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- (2) E2 (SyncHub → Core create). Its own table: the Procore worker never sees it (§2, §10).
--     status: pending | sending | sent | refused | failed | dead | held_cross_destination
CREATE TABLE IF NOT EXISTS rfp_core_create_outbox (
  id serial PRIMARY KEY,
  command_id integer NOT NULL REFERENCES bidboard_create_outbox(id),
  source_system text NOT NULL,
  source_deal_id text NOT NULL,
  source_event_id text NOT NULL,
  project_number text,
  payload jsonb,
  status text NOT NULL DEFAULT 'pending',
  refusal_reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  last_error text,
  last_status_code integer,
  core_bid_id text,
  core_created_at timestamptz,
  warnings jsonb,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_core_create_outbox_event
  ON rfp_core_create_outbox(source_system, source_event_id);
-- At most ONE in-flight Core create per deal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_core_create_outbox_live_deal
  ON rfp_core_create_outbox(source_system, source_deal_id) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_rfp_core_create_outbox_due
  ON rfp_core_create_outbox(status, next_attempt_at) WHERE status = 'pending';

-- (3) Follow-ups of a created bid: E4 (kind crm_link), E5 (kind core_confirm), N1 (kind crm_notice, one row per notice_kind).
--     status: pending | sending | sent | link_refused | orphan_stale | failed | dead
CREATE TABLE IF NOT EXISTS rfp_core_followup_outbox (
  id serial PRIMARY KEY,
  create_id integer NOT NULL REFERENCES rfp_core_create_outbox(id),
  kind text NOT NULL,
  notice_kind text NOT NULL DEFAULT '',
  notice_id text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 6,
  last_error text,
  last_status_code integer,
  last_attempt_at timestamp,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  sent_at timestamp
);
DO $$ BEGIN
  ALTER TABLE rfp_core_followup_outbox
    ADD CONSTRAINT rfp_core_followup_outbox_kind_check CHECK (kind IN ('crm_link', 'core_confirm', 'crm_notice'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_core_followup_outbox_kind
  ON rfp_core_followup_outbox(create_id, kind, notice_kind);
CREATE INDEX IF NOT EXISTS idx_rfp_core_followup_outbox_due
  ON rfp_core_followup_outbox(status, next_attempt_at) WHERE status = 'pending';
