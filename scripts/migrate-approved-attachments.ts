#!/usr/bin/env -S npx tsx
/**
 * Add approved_attachments column to rfp_approval_requests.
 * Run: npx tsx scripts/migrate-approved-attachments.ts
 * Self-contained: uses pg directly (no server/db import) so it works in production Docker.
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
    ALTER TABLE rfp_approval_requests ADD COLUMN IF NOT EXISTS approved_attachments jsonb;
  `);
  await pool.end();
  console.log("Migration complete: added approved_attachments column");
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
