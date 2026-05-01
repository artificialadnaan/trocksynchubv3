#!/usr/bin/env -S npx tsx
/**
 * Create hubspot_owners and hubspot_owner_mappings tables if missing.
 * Run: npx tsx scripts/migrate-hubspot-owner-tables.ts
 * Self-contained: uses pg directly so it works in production Docker.
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
    CREATE TABLE IF NOT EXISTS hubspot_owners (
      id SERIAL PRIMARY KEY,
      hubspot_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      user_id TEXT,
      teams TEXT,
      archived BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hubspot_owner_mappings (
      id SERIAL PRIMARY KEY,
      hubspot_owner_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.end();
  console.log("Migration complete: hubspot_owners and hubspot_owner_mappings tables created");
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Migration failed:", err.message);
  process.exit(1);
});
