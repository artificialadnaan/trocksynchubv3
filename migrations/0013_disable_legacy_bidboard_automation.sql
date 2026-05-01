UPDATE "automation_config"
SET
  "value" = jsonb_set(COALESCE("value", '{}'::jsonb), '{enabled}', 'false'::jsonb, true),
  "updated_at" = now()
WHERE "key" = 'bidboard_automation';
