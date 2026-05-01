#!/usr/bin/env -S npx tsx
/**
 * Deduplicate procore_role_assignments before adding unique constraint.
 * Required for Railway deploy: avoids interactive truncate prompt when db:push adds unique.
 * Keeps one row per (procore_project_id, role_name, assignee_id) — the one with highest id.
 * Run before db:push to avoid interactive "truncate table?" prompt when adding unique.
 * Run: npx tsx scripts/migrate-procore-role-dedupe.ts
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const tableExists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'procore_role_assignments'
  `);
  if (tableExists.rows.length === 0) {
    console.log("[migrate] procore_role_assignments table does not exist, skipping dedupe");
    await pool.end();
    process.exit(0);
    return;
  }

  const { rows: before } = await pool.query(
    "SELECT COUNT(*) AS n FROM procore_role_assignments"
  );
  const countBefore = parseInt(String(before[0]?.n ?? 0), 10);

  const { rows: dupRows } = await pool.query(`
    WITH duplicates AS (
      SELECT id,
        ROW_NUMBER() OVER (
          PARTITION BY procore_project_id, role_name, assignee_id
          ORDER BY id DESC
        ) AS rn
      FROM procore_role_assignments
    )
    SELECT COUNT(*) AS n FROM duplicates WHERE rn > 1
  `);
  const dupCount = parseInt(String(dupRows[0]?.n ?? 0), 10);

  if (dupCount === 0) {
    console.log(`[migrate] procore_role_assignments: no duplicates (${countBefore} rows), skipping`);
    // Ensure unique constraint exists so db:push doesn't prompt to truncate
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'procore_role_assignments_procore_project_id_role_name_assignee_id_unique'
        ) THEN
          ALTER TABLE procore_role_assignments
            ADD CONSTRAINT procore_role_assignments_procore_project_id_role_name_assignee_id_unique
            UNIQUE (procore_project_id, role_name, assignee_id);
        END IF;
      END $$;
    `).catch(() => { /* constraint may already exist */ });
    await pool.end();
    process.exit(0);
    return;
  }

  // Keep row with highest id per (procore_project_id, role_name, assignee_id); delete rest
  await pool.query(`
    DELETE FROM procore_role_assignments a
    USING procore_role_assignments b
    WHERE a.procore_project_id = b.procore_project_id
      AND a.role_name = b.role_name
      AND (a.assignee_id IS NOT DISTINCT FROM b.assignee_id)
      AND a.id < b.id
  `);

  const { rows: after } = await pool.query(
    "SELECT COUNT(*) AS n FROM procore_role_assignments"
  );
  const countAfter = parseInt(String(after[0]?.n ?? 0), 10);

  console.log(
    `[migrate] procore_role_assignments: removed ${countBefore - countAfter} duplicates (${countBefore} -> ${countAfter} rows)`
  );
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("[migrate] procore_role_assignments dedupe failed:", err.message);
  process.exit(1);
});
