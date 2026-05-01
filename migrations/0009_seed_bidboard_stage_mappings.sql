-- Seed Bid Board stage mappings for the signed-contract stage model.
-- Idempotent: updates matching rows and inserts missing rows without deleting legacy labels.

WITH desired (
  hubspot_stage,
  hubspot_stage_label,
  procore_stage,
  procore_stage_label,
  direction,
  is_active,
  sort_order,
  trigger_portfolio
) AS (
  VALUES
    ('Estimating', 'Estimating', 'Estimating', 'Estimating', 'bidboard_to_hubspot', true, 10, false),
    ('Service – Estimating', 'Service – Estimating', 'Service Estimating', 'Service Estimating', 'bidboard_to_hubspot', true, 20, false),
    ('Internal Review', 'Internal Review', 'Estimate Under Review', 'Estimate Under Review', 'bidboard_to_hubspot', true, 30, false),
    ('Proposal Sent', 'Proposal Sent', 'Estimate Sent to Client', 'Estimate Sent to Client', 'bidboard_to_hubspot', true, 40, false),
    ('Closed Won', 'Closed Won', 'Contract', 'Contract', 'bidboard_to_hubspot', true, 50, true),
    ('Service – Won', 'Service – Won', 'Contract', 'Contract', 'bidboard_to_hubspot', true, 51, true),
    ('Closed Won', 'Closed Won', 'Won', 'Won', 'bidboard_to_hubspot', true, 60, false),
    ('Service – Won', 'Service – Won', 'Won', 'Won', 'bidboard_to_hubspot', true, 61, false),
    ('Closed Lost', 'Closed Lost', 'Lost', 'Lost', 'bidboard_to_hubspot', true, 70, false),
    ('Service – Lost', 'Service – Lost', 'Lost', 'Lost', 'bidboard_to_hubspot', true, 71, false)
),
updated AS (
  UPDATE stage_mappings sm
  SET
    hubspot_stage = d.hubspot_stage,
    procore_stage = d.procore_stage,
    direction = d.direction,
    is_active = d.is_active,
    sort_order = d.sort_order,
    trigger_portfolio = d.trigger_portfolio
  FROM desired d
  WHERE sm.procore_stage_label = d.procore_stage_label
    AND sm.hubspot_stage_label = d.hubspot_stage_label
  RETURNING sm.procore_stage_label, sm.hubspot_stage_label, sm.direction
)
INSERT INTO stage_mappings (
  hubspot_stage,
  hubspot_stage_label,
  procore_stage,
  procore_stage_label,
  direction,
  is_active,
  sort_order,
  trigger_portfolio
)
SELECT
  d.hubspot_stage,
  d.hubspot_stage_label,
  d.procore_stage,
  d.procore_stage_label,
  d.direction,
  d.is_active,
  d.sort_order,
  d.trigger_portfolio
FROM desired d
WHERE NOT EXISTS (
  SELECT 1
  FROM stage_mappings sm
  WHERE sm.procore_stage_label = d.procore_stage_label
    AND sm.hubspot_stage_label = d.hubspot_stage_label
);
