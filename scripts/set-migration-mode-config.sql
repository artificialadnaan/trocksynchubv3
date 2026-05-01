-- Bid Board migration-mode rollout config.
-- Review-only artifact; operator applies through the TypeScript runner so pre-flight,
-- snapshot, and rollback metadata are captured.
--
-- Runtime notification keys:
--   rollout bb_contract_won -> stage_notify_bb_closed_won_contract
--   rollout bb_lost         -> stage_notify_bb_closed_lost_lost
--
-- Scope note: migration mode suppresses stage-transition external effects
-- (HubSpot writes, Portfolio creation, and stage notifications). The scheduled
-- sync still posts the raw Bid Board export to the internal T Rock CRM ingestion
-- route, whose receiver updates CRM-local Bid Board cache fields only.

BEGIN;

INSERT INTO automation_config (key, value, description, is_active, updated_at)
VALUES
  (
    'bidboard_stage_sync',
    '{
      "enabled": true,
      "mode": "migration",
      "dryRun": false,
      "suppressHubSpotWrites": true,
      "suppressPortfolioTriggers": true,
      "suppressStageNotifications": true,
      "logSuppressedActions": true
    }'::jsonb,
    'BidBoard stage sync migration-mode rollout',
    true,
    NOW()
  ),
  (
    'bidboard_automation',
    '{ "enabled": false }'::jsonb,
    'BidBoard Playwright automation legacy poller disabled',
    true,
    NOW()
  ),
  (
    'bidboard_stage_mapping',
    '{
      "useDb": true,
      "allowHardcodedFallback": true,
      "auditFallbackUsage": true
    }'::jsonb,
    'BidBoard stage mapping source control',
    true,
    NOW()
  ),
  (
    'bidboard_portfolio_trigger',
    '{
      "source": "stage_mappings",
      "requireHubspotDeal": true,
      "allowUnmappedAutoCreate": false,
      "enabled": false
    }'::jsonb,
    'BidBoard Portfolio trigger controls',
    true,
    NOW()
  ),
  (
    'stage_notify_bb_closed_won_contract',
    '{ "enabled": false }'::jsonb,
    'Stage notification: Contract -> Closed Won',
    true,
    NOW()
  ),
  (
    'stage_notify_bb_closed_lost_lost',
    '{ "enabled": false }'::jsonb,
    'Stage notification: Lost -> Closed Lost',
    true,
    NOW()
  )
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    is_active = true,
    updated_at = NOW();

COMMIT;
