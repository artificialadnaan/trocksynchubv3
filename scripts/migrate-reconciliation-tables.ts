#!/usr/bin/env npx tsx
/**
 * Add reconciliation tables for the Data Health / reconciliation engine.
 * Run: npx tsx scripts/migrate-reconciliation-tables.ts
 * Or: npm run db:migrate-reconciliation
 *
 * Idempotent: each statement uses IF NOT EXISTS / DO $$ so safe to re-run.
 * No early exit — runs every statement so partial failures can be repaired on next deploy.
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runReconciliationMigration(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const client = await pool.connect();

  const enumExists = async (name: string) =>
    (await client.query("SELECT 1 FROM pg_type WHERE typname = $1", [name])).rows.length > 0;
  const tableExists = async (name: string) =>
    (await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [name]
    )).rows.length > 0;

  try {
    // Create enums (idempotent — skip if already exists)
    {
      const exists = await enumExists("reconciliation_bucket");
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reconciliation_bucket') THEN
            CREATE TYPE reconciliation_bucket AS ENUM (
              'exact_match', 'fuzzy_match', 'orphan_procore', 'orphan_hubspot',
              'orphan_bidboard', 'conflict', 'resolved', 'ignored'
            );
          END IF;
        END $$;
      `);
      console.log(exists ? "[migrate] Enum reconciliation_bucket already existed" : "[migrate] Created enum reconciliation_bucket");
    }
    {
      const exists = await enumExists("conflict_severity");
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conflict_severity') THEN
            CREATE TYPE conflict_severity AS ENUM ('critical', 'warning', 'info');
          END IF;
        END $$;
      `);
      console.log(exists ? "[migrate] Enum conflict_severity already existed" : "[migrate] Created enum conflict_severity");
    }
    {
      const exists = await enumExists("resolution_action");
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'resolution_action') THEN
            CREATE TYPE resolution_action AS ENUM (
              'accept_procore', 'accept_hubspot', 'manual_override', 'create_counterpart',
              'link_existing', 'mark_ignored', 'merge_records', 'assign_canonical_number'
            );
          END IF;
        END $$;
      `);
      console.log(exists ? "[migrate] Enum resolution_action already existed" : "[migrate] Created enum resolution_action");
    }
    {
      const exists = await enumExists("project_number_era");
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_number_era') THEN
            CREATE TYPE project_number_era AS ENUM ('legacy', 'zapier', 'synchub');
          END IF;
        END $$;
      `);
      console.log(exists ? "[migrate] Enum project_number_era already existed" : "[migrate] Created enum project_number_era");
    }

    // Create tables (idempotent — IF NOT EXISTS on each)
    {
      const exists = await tableExists("reconciliation_projects");
      await client.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_projects (
        id SERIAL PRIMARY KEY,
        procore_project_id TEXT,
        hubspot_deal_id TEXT,
        bidboard_item_id TEXT,
        companycam_project_id TEXT,
        procore_data JSONB,
        hubspot_data JSONB,
        bidboard_data JSONB,
        bucket reconciliation_bucket NOT NULL DEFAULT 'fuzzy_match',
        match_confidence REAL,
        match_method TEXT,
        canonical_name TEXT,
        canonical_project_number TEXT,
        canonical_location TEXT,
        canonical_amount REAL,
        canonical_stage TEXT,
        is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        admin_notes TEXT,
        last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
      console.log(exists ? "[migrate] Table reconciliation_projects already existed" : "[migrate] Created table reconciliation_projects");
    }
    {
      const exists = await tableExists("reconciliation_conflicts");
      await client.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_conflicts (
        id SERIAL PRIMARY KEY,
        reconciliation_project_id INTEGER NOT NULL REFERENCES reconciliation_projects(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        procore_value TEXT,
        hubspot_value TEXT,
        bidboard_value TEXT,
        severity conflict_severity NOT NULL DEFAULT 'warning',
        is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_value TEXT,
        resolved_source TEXT,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
      console.log(exists ? "[migrate] Table reconciliation_conflicts already existed" : "[migrate] Created table reconciliation_conflicts");
    }
    {
      const exists = await tableExists("reconciliation_audit_log");
      await client.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_audit_log (
        id SERIAL PRIMARY KEY,
        reconciliation_project_id INTEGER NOT NULL REFERENCES reconciliation_projects(id) ON DELETE CASCADE,
        action resolution_action NOT NULL,
        field_name TEXT,
        previous_value TEXT,
        new_value TEXT,
        source TEXT,
        performed_by TEXT NOT NULL,
        performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes TEXT,
        snapshot_before JSONB,
        snapshot_after JSONB
      );
    `);
      console.log(exists ? "[migrate] Table reconciliation_audit_log already existed" : "[migrate] Created table reconciliation_audit_log");
    }
    {
      const exists = await tableExists("legacy_number_mappings");
      await client.query(`
      CREATE TABLE IF NOT EXISTS legacy_number_mappings (
        id SERIAL PRIMARY KEY,
        legacy_number TEXT NOT NULL UNIQUE,
        canonical_number TEXT,
        era project_number_era NOT NULL,
        project_name TEXT,
        procore_project_id TEXT,
        hubspot_deal_id TEXT,
        mapped_by TEXT,
        mapped_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
      console.log(exists ? "[migrate] Table legacy_number_mappings already existed" : "[migrate] Created table legacy_number_mappings");
    }
    {
      const exists = await tableExists("reconciliation_scan_runs");
      await client.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_scan_runs (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        total_projects INTEGER,
        exact_matches INTEGER,
        fuzzy_matches INTEGER,
        orphans_procore INTEGER,
        orphans_hubspot INTEGER,
        conflicts INTEGER,
        resolved INTEGER,
        new_conflicts INTEGER,
        new_resolutions INTEGER,
        triggered_by TEXT,
        error TEXT
      );
    `);
      console.log(exists ? "[migrate] Table reconciliation_scan_runs already existed" : "[migrate] Created table reconciliation_scan_runs");
    }

    console.log("[migrate] Reconciliation tables and enums ensured successfully");
  } catch (e) {
    console.error("[migrate] Reconciliation migration failed:", e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

runReconciliationMigration()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
