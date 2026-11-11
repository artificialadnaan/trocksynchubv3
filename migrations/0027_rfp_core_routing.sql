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

-- (1b) S0b-2a (§10 path P3; runbook r5): the email path's create-in-progress record. The `approving` STATUS lives on the
--     request row; its timestamps live HERE, not as rfp_approval_requests columns: the drizzle request table is read
--     everywhere and SyncHub code can be live before 0027 is, so a column there would break every request read (d9).
--     started_at = the flip (same transaction); submit_at = committed before createBidBoardProject starts (NULL ⇒ the
--     create never started). Written only after the preflight reads present. Created BEFORE the Core tables, so "Core
--     tables present" implies this table is too.
--     S0b-2b (d9 QA): the ORIGINAL approval's inputs, recorded in the flip's own transaction, so the resolve CLI's
--     `recreate` replays exactly them (runbook r5 §3B): approved_by / edited_fields / approved_attachments ({"override":
--     null | [...]}) / force. hubspot_done_at = the pre-create HubSpot / CRM steps all reported success (NULL ⇒ recreate
--     refuses). All nullable: a row claimed without them is refused, never replayed.
CREATE TABLE IF NOT EXISTS rfp_approval_approving (
  request_id integer PRIMARY KEY,
  started_at timestamp NOT NULL DEFAULT now(),
  submit_at timestamp,
  approved_by text,
  edited_fields jsonb,
  approved_attachments jsonb,
  force boolean,
  hubspot_done_at timestamp
);
-- The WIDER live-request indexes (0021's two stay exactly as they are: no DROP) and the side table's FK. Guarded because a
-- narrow test schema may have no rfp_approval_requests. Deploy note: the pre-apply collision read must return 0 first.
DO $$ BEGIN
  IF to_regclass('public.rfp_approval_requests') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approval_live_source_deal
      ON rfp_approval_requests(source_system, source_deal_id)
      WHERE status IN ('pending', 'approving', 'override_approving');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approval_live_project_number
      ON rfp_approval_requests(project_number)
      WHERE status IN ('pending', 'approving', 'override_approving') AND project_number IS NOT NULL AND project_number != '';
    BEGIN
      ALTER TABLE rfp_approval_approving
        ADD CONSTRAINT rfp_approval_approving_request_id_rfp_approval_requests_id_fk
        FOREIGN KEY (request_id) REFERENCES rfp_approval_requests(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

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
  -- Set true BEFORE the first E2 send and never reset (a RE-ARM resets attempt_count, so attempt_count can't tell). A held
  -- row that never sent E2 made no bid and is NOT a Core footprint; one that ever sent may have (d9, S0b; §10 FOOTPRINT).
  e2_ever_sent boolean NOT NULL DEFAULT false,
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
