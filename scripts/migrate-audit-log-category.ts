#!/usr/bin/env -S npx tsx
/**
 * Add category column to audit_logs and backfill sync vs system.
 * Run: npx tsx scripts/migrate-audit-log-category.ts
 * 
 * - Adds category column (default 'system')
 * - Backfills existing rows: marks sync operations based on action patterns
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  await pool.query(`
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'system';
  `);

  const { rowCount } = await pool.query(`
    UPDATE audit_logs
    SET category = 'sync'
    WHERE
      action ILIKE '%vendor_created%' OR action ILIKE '%vendor_updated%'
      OR action ILIKE '%project_created%' OR action ILIKE '%deal_created%' OR action ILIKE '%deal_updated%'
      OR action ILIKE '%stage_change_processed%' OR action ILIKE '%role_assignment_processed%'
      OR action ILIKE '%deactivation_closeout%' OR action ILIKE '%document%'
      OR action ILIKE '%rfp_%' OR action ILIKE '%change_order%'
      OR action ILIKE '%closeout%' OR action ILIKE '%mapping_created%' OR action ILIKE '%mapping_updated%'
      OR action ILIKE '%companycam%' OR action ILIKE '%bidboard%'
      OR action IN (
        'webhook_deal_project_created', 'webhook_deal_project_linked',
        'webhook_stage_change_processed', 'webhook_role_assignment_processed',
        'procore_hubspot_deal_created', 'procore_hubspot_deal_updated',
        'deal_project_number_assigned', 'stage_sync_processed'
      )
  `);

  await pool.end();
  console.log(`Migration complete: added audit_logs.category, backfilled ${rowCount ?? 0} rows as sync`);
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
