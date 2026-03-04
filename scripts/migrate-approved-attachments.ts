#!/usr/bin/env npx tsx
/**
 * Add approved_attachments column to rfp_approval_requests.
 * Run: npx tsx scripts/migrate-approved-attachments.ts
 */
import { pool } from "../server/db";

async function main() {
  await pool.query(`
    ALTER TABLE rfp_approval_requests ADD COLUMN IF NOT EXISTS approved_attachments jsonb;
  `);
  console.log("Migration complete: added approved_attachments column");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
