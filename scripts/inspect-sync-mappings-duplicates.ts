#!/usr/bin/env -S npx tsx
/**
 * Inspect duplicate sync_mappings source identity rows after migration 0014 preflight failure.
 * Run: npx tsx scripts/inspect-sync-mappings-duplicates.ts
 */
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

type DuplicateRow = {
  source_system: string;
  source_deal_id: string;
  duplicate_count: string | number;
  mapping_ids: Array<string | number>;
  bidboard_ids: Array<string | null>;
  portfolio_ids: Array<string | null>;
  procore_ids: Array<string | null>;
  created_at_list: Array<Date | string | null>;
};

function formatValue(value: unknown): string {
  if (value == null) return "NULL";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const result = await pool.query<DuplicateRow>(`
    SELECT source_system, source_deal_id, COUNT(*) as duplicate_count,
           ARRAY_AGG(id ORDER BY id) as mapping_ids,
           ARRAY_AGG(bidboard_project_id ORDER BY id) as bidboard_ids,
           ARRAY_AGG(portfolio_project_id ORDER BY id) as portfolio_ids,
           ARRAY_AGG(procore_project_id ORDER BY id) as procore_ids,
           ARRAY_AGG(created_at ORDER BY id) as created_at_list
    FROM sync_mappings
    WHERE source_system IS NOT NULL AND source_deal_id IS NOT NULL
    GROUP BY source_system, source_deal_id
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC, source_deal_id ASC;
  `);

  const distribution = new Map<number, number>();
  let totalDuplicateRows = 0;

  for (const row of result.rows) {
    const duplicateCount = Number(row.duplicate_count);
    totalDuplicateRows += Math.max(0, duplicateCount - 1);
    distribution.set(duplicateCount, (distribution.get(duplicateCount) ?? 0) + 1);

    console.log("--- Duplicate group ---");
    console.log(`source_system: ${row.source_system}`);
    console.log(`source_deal_id: ${row.source_deal_id}`);
    console.log(`duplicate count: ${duplicateCount}`);
    console.log("mapping rows:");

    for (let index = 0; index < row.mapping_ids.length; index += 1) {
      console.log(
        `  id=${formatValue(row.mapping_ids[index])}, ` +
          `bidboard_project_id=${formatValue(row.bidboard_ids[index])}, ` +
          `portfolio_project_id=${formatValue(row.portfolio_ids[index])}, ` +
          `procore_project_id=${formatValue(row.procore_ids[index])}, ` +
          `created_at=${formatValue(row.created_at_list[index])}`
      );
    }
    console.log("");
  }

  console.log("--- Summary ---");
  console.log(`Total duplicate groups found: ${result.rows.length}`);
  console.log(`Total duplicate rows: ${totalDuplicateRows}`);
  console.log("Distribution by duplicate_count:");

  if (distribution.size === 0) {
    console.log("  none");
  } else {
    for (const [duplicateCount, groupCount] of [...distribution.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  ${duplicateCount}: ${groupCount}`);
    }
  }

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Inspection failed:", err.message);
  process.exit(1);
});
