/**
 * Startup migration: Add last_role_check_at to procore_projects if it doesn't exist.
 * Schema drift fix when db:push fails silently or blocks on Railway deploy.
 */
import { pool } from "./db";

export async function ensureProcoreLastRoleCheckColumn(): Promise<void> {
  try {
    await pool.query(`
      ALTER TABLE procore_projects
      ADD COLUMN IF NOT EXISTS last_role_check_at TIMESTAMPTZ DEFAULT NULL
    `);
    console.log("[migrate] procore_projects last_role_check_at column ensured");
  } catch (e) {
    console.error("[migrate] Failed to ensure procore_projects last_role_check_at column:", e);
    throw e;
  }
}
