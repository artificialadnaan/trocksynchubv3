#!/usr/bin/env npx tsx
/**
 * RFP Reporting & Scheduled Email migrations.
 * Run: npx tsx scripts/migrate-rfp-reporting.ts
 * Creates: rfp_change_log, rfp_approvals, report_schedule_config, and audit trigger.
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
  await pool.query(sql);
  console.log(`  ✓ ${filename}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }
  console.log("Running RFP Reporting migrations...");
  await runSqlFile("0002_rfp_reporting_tables.sql");
  await runSqlFile("0003_rfp_change_log_trigger.sql");
  await runSqlFile("0004_add_last_sent_at.sql");
  await runSqlFile("0005_ensure_rfp_change_log.sql");
  await pool.end();
  console.log("Migration complete.");
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
