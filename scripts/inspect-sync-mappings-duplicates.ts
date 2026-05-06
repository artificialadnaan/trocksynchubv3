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

type FallbackDuplicateRow = {
  source_system: string;
  computed_source_deal_id: string;
  duplicate_count: string | number;
  mapping_ids: Array<string | number>;
  hubspot_ids: Array<string | null>;
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

function addDistribution(distribution: Map<number, number>, duplicateCount: number) {
  distribution.set(duplicateCount, (distribution.get(duplicateCount) ?? 0) + 1);
}

function printDistribution(distribution: Map<number, number>) {
  if (distribution.size === 0) {
    console.log("  none");
    return;
  }

  for (const [duplicateCount, groupCount] of [...distribution.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${duplicateCount}: ${groupCount}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const hubspotDuplicateResult = await pool.query<DuplicateRow>(`
    SELECT 
      'hubspot' AS source_system,
      hubspot_deal_id AS source_deal_id,
      COUNT(*) as duplicate_count, 
      ARRAY_AGG(id ORDER BY id) as mapping_ids,
      ARRAY_AGG(bidboard_project_id ORDER BY id) as bidboard_ids,
      ARRAY_AGG(portfolio_project_id ORDER BY id) as portfolio_ids,
      ARRAY_AGG(procore_project_id ORDER BY id) as procore_ids,
      ARRAY_AGG(created_at ORDER BY id) as created_at_list
    FROM sync_mappings
    WHERE hubspot_deal_id IS NOT NULL AND hubspot_deal_id != ''
    GROUP BY hubspot_deal_id
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC, hubspot_deal_id ASC;
  `);

  const fallbackDuplicateResult = await pool.query<FallbackDuplicateRow>(`
    SELECT
      'hubspot' AS source_system,
      COALESCE(
        NULLIF(hubspot_deal_id, ''),
        bidboard_project_id,
        portfolio_project_id,
        procore_project_id,
        'legacy-sync-mapping-' || id::text
      ) AS computed_source_deal_id,
      COUNT(*) as duplicate_count,
      ARRAY_AGG(id ORDER BY id) as mapping_ids,
      ARRAY_AGG(hubspot_deal_id ORDER BY id) as hubspot_ids,
      ARRAY_AGG(bidboard_project_id ORDER BY id) as bidboard_ids,
      ARRAY_AGG(portfolio_project_id ORDER BY id) as portfolio_ids,
      ARRAY_AGG(procore_project_id ORDER BY id) as procore_ids,
      ARRAY_AGG(created_at ORDER BY id) as created_at_list
    FROM sync_mappings
    GROUP BY computed_source_deal_id
    HAVING COUNT(*) > 1
    ORDER BY duplicate_count DESC;
  `);

  console.log("=== Real hubspot_deal_id duplicates ===");
  for (const row of hubspotDuplicateResult.rows) {
    const duplicateCount = Number(row.duplicate_count);

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

  console.log("=== Fallback-chain duplicates (computed migration 0014 source_deal_id) ===");
  for (const row of fallbackDuplicateResult.rows) {
    const duplicateCount = Number(row.duplicate_count);

    console.log("--- Duplicate group ---");
    console.log(`source_system: ${row.source_system}`);
    console.log(`computed_source_deal_id: ${row.computed_source_deal_id}`);
    console.log(`duplicate count: ${duplicateCount}`);
    console.log("mapping rows:");

    for (let index = 0; index < row.mapping_ids.length; index += 1) {
      console.log(
        `  id=${formatValue(row.mapping_ids[index])}, ` +
          `hubspot_deal_id=${formatValue(row.hubspot_ids[index])}, ` +
          `bidboard_project_id=${formatValue(row.bidboard_ids[index])}, ` +
          `portfolio_project_id=${formatValue(row.portfolio_ids[index])}, ` +
          `procore_project_id=${formatValue(row.procore_ids[index])}, ` +
          `created_at=${formatValue(row.created_at_list[index])}`
      );
    }
    console.log("");
  }

  const hubspotDuplicateKeys = new Set(hubspotDuplicateResult.rows.map((row) => row.source_deal_id));
  const fallbackOnlyDuplicateGroups = fallbackDuplicateResult.rows.filter(
    (row) => !hubspotDuplicateKeys.has(row.computed_source_deal_id)
  ).length;
  const totalDuplicateRows = fallbackDuplicateResult.rows.reduce(
    (total, row) => total + Math.max(0, Number(row.duplicate_count) - 1),
    0
  );
  const distribution = new Map<number, number>();
  for (const row of fallbackDuplicateResult.rows) {
    addDistribution(distribution, Number(row.duplicate_count));
  }

  console.log("--- Summary ---");
  console.log(`Total duplicate groups (query 1): ${hubspotDuplicateResult.rows.length}`);
  console.log(`Total duplicate groups (query 2 minus query 1): ${fallbackOnlyDuplicateGroups}`);
  console.log(`Total duplicate rows: ${totalDuplicateRows}`);
  console.log("Distribution by duplicate_count:");
  printDistribution(distribution);

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  await pool.end().catch(() => {});
  console.error("Inspection failed:", err.message);
  process.exit(1);
});
