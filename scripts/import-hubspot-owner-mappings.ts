/**
 * Import HubSpot owner mappings from an Excel file.
 * Columns: Name, Email, HS ID #
 *
 * Usage: npx tsx scripts/import-hubspot-owner-mappings.ts <path-to-xlsx>
 * Requires: DATABASE_URL
 */

import XLSX from "xlsx";
import { db } from "../server/db";
import { hubspotOwnerMappings } from "../shared/schema";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx scripts/import-hubspot-owner-mappings.ts <path-to-xlsx>");
  process.exit(1);
}

async function main() {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

  const header = (rows[0] || []) as string[];
  const nameIdx = header.findIndex((h) => /name/i.test(String(h)));
  const emailIdx = header.findIndex((h) => /email/i.test(String(h)));
  const idIdx = header.findIndex((h) => /^(HS\s*ID|HubSpot\s*ID|hs_object_id)\s*#?\s*$/i.test(String(h).trim()));

  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const name = nameIdx >= 0 ? String(row[nameIdx] ?? "").trim() : "";
    const email = emailIdx >= 0 ? String(row[emailIdx] ?? "").trim() : "";
    const id = idIdx >= 0 ? String(row[idIdx] ?? "").trim() : "";
    if (!id || !email) continue;

    await db
      .insert(hubspotOwnerMappings)
      .values({
        hubspotOwnerId: id,
        email,
        name: name || null,
      })
      .onConflictDoUpdate({
        target: hubspotOwnerMappings.hubspotOwnerId,
        set: { email, name: name || null, updatedAt: new Date() },
      });
    created++;
    console.log(`  ${name || email} (${id})`);
  }

  console.log(`\nImported ${created} owner mappings.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
