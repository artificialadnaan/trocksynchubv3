/**
 * Startup migration: Create bidboard_stage_sync_runs table if it doesn't exist.
 * Used when db:push is blocked by interactive prompts (e.g. procore_role_assignments constraint).
 */
import { pool } from "./db";

export async function ensureBidboardStageSyncRunsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bidboard_stage_sync_runs (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'running',
        total_changes INTEGER NOT NULL DEFAULT 0,
        synced_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        changes JSONB,
        errors JSONB,
        export_path TEXT,
        options JSONB
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS IDX_bidboard_stage_sync_started
      ON bidboard_stage_sync_runs (started_at);
    `);
    console.log("[migrate] bidboard_stage_sync_runs table ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure bidboard_stage_sync_runs table:", e);
    throw e;
  }
}
