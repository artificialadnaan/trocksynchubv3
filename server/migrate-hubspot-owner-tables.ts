/**
 * One-time migration: Create hubspot_owners and hubspot_owner_mappings
 * if they don't exist (schema drift from older deploys).
 */
import { pool } from "./db";

export async function ensureHubspotOwnerTables(): Promise<void> {
  try {
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
    console.log("[migrate] hubspot_owners and hubspot_owner_mappings tables ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure hubspot owner tables:", e);
    throw e;
  }
}
