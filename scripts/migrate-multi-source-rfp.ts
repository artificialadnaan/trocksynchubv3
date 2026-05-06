#!/usr/bin/env -S npx tsx
/**
 * Multi-source RFP approval migrations (Phases 1-8).
 * Run: npx tsx scripts/migrate-multi-source-rfp.ts
 *
 * Adds source identity to rfp_approval_requests and sync_mappings, relaxes 
 * hubspot_deal_id nullable, creates rfp_approver_config, rfp_approval_edits, 
 * pending project_number unique index, and bidboard_callback_outbox.
 *
 * All migrations are idempotent and additive. Migrations with unique index 
 * creation include explicit RAISE EXCEPTION preflight blocks that will halt 
 * if existing data would violate the new constraints.
 */
import pg from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runSqlFile(filename: string) {
  const path = join(migrationsDir, filename);
  const sql = readFileSync(path, "utf-8");
  console.log(`  → ${filename}`);
  await pool.query(sql);
  console.log(`  ✓ ${filename}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  console.log("Running multi-source RFP migrations (0013a, 0015-0020)...");
  await runSqlFile("0013a_dedupe_bidboard_project_id.sql");
  await runSqlFile("0015_add_source_identity_to_rfp_and_sync_mappings.sql");
  await runSqlFile("0016_relax_hubspot_deal_id_nullable.sql");
  await runSqlFile("0017_create_rfp_approver_config.sql");
  await runSqlFile("0018_create_rfp_approval_edits.sql");
  await runSqlFile("0019_add_pending_project_number_unique.sql");
  await runSqlFile("0020_create_bidboard_callback_outbox.sql");
  await pool.end();
  console.log("Migration complete.");
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
