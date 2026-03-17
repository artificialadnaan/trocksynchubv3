/**
 * Import Procore users from Project Directory CSV/Excel.
 * Expected columns: Id, First Name, Last Name, Email, Job Title, Business Phone, Mobile Phone
 * (from Procore Company Directory export)
 *
 * Usage: npx tsx scripts/import-procore-users.ts <path-to-csv-or-xlsx>
 * Requires: DATABASE_URL
 */

import * as fs from "fs";
import XLSX from "xlsx";
import { db } from "../server/db";
import { procoreUsers } from "../shared/schema";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npx tsx scripts/import-procore-users.ts <path-to-csv-or-xlsx>");
  process.exit(1);
}

function parseRows(path: string): unknown[][] {
  const buf = fs.readFileSync(path);
  const ext = path.toLowerCase().split(".").pop();
  const wb =
    ext === "csv"
      ? XLSX.read(buf.toString("utf-8"), { type: "string", raw: false })
      : XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
}

async function main() {
  const rows = parseRows(filePath);
  const header = (rows[0] || []) as string[];
  const idIdx = header.findIndex((h) => /^id$/i.test(String(h).trim()));
  const firstNameIdx = header.findIndex((h) => /first\s*name/i.test(String(h)));
  const lastNameIdx = header.findIndex((h) => /last\s*name/i.test(String(h)));
  const emailIdx = header.findIndex((h) => /^email$/i.test(String(h).trim()));
  const jobTitleIdx = header.findIndex((h) => /job\s*title/i.test(String(h)));
  const businessPhoneIdx = header.findIndex((h) => /business\s*phone/i.test(String(h)));
  const mobilePhoneIdx = header.findIndex((h) => /mobile\s*phone/i.test(String(h)));

  if (idIdx < 0 || emailIdx < 0) {
    console.error("Expected columns: Id, Email (case-insensitive). Found:", header.join(", "));
    process.exit(1);
  }

  let created = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const procoreId = String(row[idIdx] ?? "").trim();
    const email = String(row[emailIdx] ?? "").trim();
    if (!procoreId || !email) continue;

    const firstName = firstNameIdx >= 0 ? String(row[firstNameIdx] ?? "").trim() || null : null;
    const lastName = lastNameIdx >= 0 ? String(row[lastNameIdx] ?? "").trim() || null : null;
    const name = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || email;
    const jobTitle = jobTitleIdx >= 0 ? String(row[jobTitleIdx] ?? "").trim() || null : null;
    const businessPhone = businessPhoneIdx >= 0 ? String(row[businessPhoneIdx] ?? "").trim() || null : null;
    const mobilePhone = mobilePhoneIdx >= 0 ? String(row[mobilePhoneIdx] ?? "").trim() || null : null;

    await db
      .insert(procoreUsers)
      .values({
        procoreId,
        emailAddress: email,
        firstName,
        lastName,
        name,
        jobTitle,
        businessPhone,
        mobilePhone,
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: procoreUsers.procoreId,
        set: {
          emailAddress: email,
          firstName,
          lastName,
          name,
          jobTitle,
          businessPhone,
          mobilePhone,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    created++;
    console.log(`  ${name || email} (${procoreId})`);
  }

  console.log(`\nImported ${created} Procore users.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
