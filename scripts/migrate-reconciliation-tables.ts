#!/usr/bin/env npx tsx
/**
 * Add reconciliation tables for the Data Health / reconciliation engine.
 * Run: npx tsx scripts/migrate-reconciliation-tables.ts
 * Or: npm run db:migrate-reconciliation
 *
 * Idempotent: skips if tables already exist.
 */
import pg from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  // Check if reconciliation_projects already exists
  const check = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'reconciliation_projects'
    );
  `);

  if (check.rows[0]?.exists) {
    console.log("Reconciliation tables already exist, skipping migration.");
    await pool.end();
    process.exit(0);
    return;
  }

  const migrationPath = join(
    __dirname,
    "..",
    "migrations",
    "0006_add_reconciliation_tables.sql"
  );
  const sql = readFileSync(migrationPath, "utf-8");

  // Split by statement-breakpoint and execute each statement
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));

  for (const stmt of statements) {
    if (stmt) {
      await pool.query(stmt);
    }
  }

  await pool.end();
  console.log("Migration complete: reconciliation tables created.");
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
