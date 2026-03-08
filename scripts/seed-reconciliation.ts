#!/usr/bin/env npx tsx
/**
 * Seed reconciliation tables from existing sync mappings.
 * Run: npx tsx scripts/seed-reconciliation.ts
 * Or: npm run db:seed-reconciliation
 *
 * 1. Detects legacy-format project numbers and inserts into legacy_number_mappings
 * 2. Runs full reconciliation scan
 */
import { db } from "../server/db";
import { syncMappings } from "@shared/schema";
import { legacyNumberMappings } from "@shared/reconciliation-schema";
import { parseProjectNumber } from "../server/services/reconciliation/matcher";
import { runReconciliationScan } from "../server/services/reconciliation/engine";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set");
  }

  const mappings = await db.select().from(syncMappings);
  console.log(`[seed] Found ${mappings.length} existing sync mappings`);

  let legacyCount = 0;
  let zapierCount = 0;

  for (const m of mappings) {
    const projectNumber = m.procoreProjectNumber || null;
    if (!projectNumber) continue;

    const parsed = parseProjectNumber(projectNumber.toUpperCase());

    if (!parsed) {
      try {
        await db
          .insert(legacyNumberMappings)
          .values({
            legacyNumber: projectNumber,
            canonicalNumber: null,
            era: "legacy",
            projectName: m.procoreProjectName || m.hubspotDealName || null,
            procoreProjectId: m.procoreProjectId || null,
            hubspotDealId: m.hubspotDealId || null,
          })
          .onConflictDoNothing({ target: legacyNumberMappings.legacyNumber });
        legacyCount++;
      } catch {
        // Ignore duplicates
      }
    } else {
      zapierCount++;
    }
  }

  console.log(`[seed] Detected ${legacyCount} legacy numbers, ${zapierCount} DFW-format numbers`);

  console.log("[seed] Running full reconciliation scan...");
  const result = await runReconciliationScan("seed-script");
  console.log("[seed] Scan complete:", JSON.stringify(result, null, 2));

  console.log("[seed] Reconciliation seeding complete.");
  console.log(`[seed] Legacy numbers needing mapping: ${legacyCount}`);
  console.log("[seed] Open the Data Health page → Legacy Mappings tab to assign canonical numbers.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Failed:", err.message);
  process.exit(1);
});
