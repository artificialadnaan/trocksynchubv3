#!/usr/bin/env -S npx tsx
/**
 * STALE PENDING RFP CLEANUP — preview first, apply only on the owner's go BY NAME (2026-10-15, via 68)
 * ======================================================================================================
 * SyncHub's rfp_approval_requests rows stay 'pending' forever: nothing closes one when its source deal is won, lost,
 * deactivated or no longer an RFP, and the daily digest kept listing them (107 pending on 10-15; ~3/4 decided).
 *
 * PREVIEW (the default; writes NOTHING): every pending request, classified by the approve gate's own rule
 * (checkRfpApprovalSourceEligibility, fail-open), grouped by reason, with name, number, age and a test-name flag. The
 * flag matches "test" anywhere in the name; "demo" means DEMOLITION here and is never flagged (owner rule). The JSON
 * snapshot goes to the OS temp directory, never the repository: it holds customer names and ids (Codex P2 on #114).
 * Run in the SyncHub environment (it needs the CRM / HubSpot credentials the gate uses).
 *
 *   npx tsx scripts/rfp-stale-pending-cleanup.ts                       # preview
 *   npx tsx scripts/rfp-stale-pending-cleanup.ts --apply --ids=12,40   # ONLY the ids the owner approved by name
 *
 * APPLY: for each listed id STILL 'pending', status -> 'cancelled_source_ineligible' (the status the approve gate
 * itself sets for an ineligible source) and its audit_logs row, in ONE transaction (Codex P2 / CodeRabbit on #114).
 * The --ids list is all or nothing. NO email is sent, nothing is deleted, and an id that is no longer pending is
 * skipped and reported.
 */
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { auditLogs, rfpApprovalRequests } from "@shared/schema";
import { checkRfpApprovalSourceEligibility } from "../server/rfp-approval";
import { classifyPendingRfp, parseRfpCleanupIds } from "../server/pendingRfpOpen";

const OLDER_THAN_DAYS = Number(process.env.PENDING_RFP_DIGEST_OLDER_DAYS ?? "30") || 30;
const name = (r: { dealData: unknown; editedFields: unknown }) => {
  const e = (r.editedFields ?? {}) as Record<string, unknown>;
  const d = (r.dealData ?? {}) as Record<string, unknown>;
  return String(e.dealname ?? e.project_name ?? d.dealname ?? d.project_name ?? "—");
};

async function preview() {
  const now = new Date();
  const rows = await db.select().from(rfpApprovalRequests).where(eq(rfpApprovalRequests.status, "pending")).orderBy(asc(rfpApprovalRequests.createdAt));
  const out = [];
  for (const r of rows) {
    const c = classifyPendingRfp(r, await checkRfpApprovalSourceEligibility(r), now, OLDER_THAN_DAYS);
    const n = name(r);
    out.push({
      id: r.id, group: c.group, reason: c.reason, ageDays: c.ageDays, name: n, projectNumber: r.projectNumber ?? null,
      source: `${r.sourceSystem}:${r.sourceDealId}`, sentAt: r.createdAt, testLooking: /test/i.test(n),
    });
  }
  for (const group of ["source_ineligible", "older", "open"] as const) {
    const list = out.filter((o) => o.group === group);
    console.log(`\n== ${group} (${list.length})`);
    for (const o of list) {
      console.log(`  #${o.id}  ${o.name}  ${o.projectNumber ?? "(no number)"}  ${o.ageDays ?? "?"}d  ${o.testLooking ? "[TEST?] " : ""}— ${o.reason}`);
    }
  }
  const file = join(tmpdir(), `rfp-stale-pending-preview-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\npreview only: nothing written to the database. Snapshot: ${file}`);
}

async function apply(ids: number[]) {
  const rows = await db.select().from(rfpApprovalRequests).where(inArray(rfpApprovalRequests.id, ids));
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) { console.log(`#${id}: not found — skipped`); continue; }
    // The status change and its audit row commit TOGETHER: an audit failure rolls the cancellation back.
    const done = await db.transaction(async (tx) => {
      const updated = await tx
        .update(rfpApprovalRequests)
        .set({ status: "cancelled_source_ineligible" })
        .where(and(eq(rfpApprovalRequests.id, id), eq(rfpApprovalRequests.status, "pending")))
        .returning({ id: rfpApprovalRequests.id });
      if (updated.length === 0) return false;
      await tx.insert(auditLogs).values({
        action: "rfp_stale_pending_cleanup",
        entityType: "deal",
        entityId: r.sourceDealId,
        source: "rfp-stale-pending-cleanup",
        status: "success",
        category: "system",
        details: { requestId: id, from: "pending", to: "cancelled_source_ineligible", name: name(r), projectNumber: r.projectNumber, ownerGo: "ids approved by the owner by name" },
      });
      return true;
    });
    if (!done) { console.log(`#${id}: no longer pending (${r.status}) — skipped`); continue; }
    console.log(`#${id}: ${name(r)} -> cancelled_source_ineligible`);
  }
}

const run = async () => {
  if (!process.argv.includes("--apply")) return preview();
  const parsed = parseRfpCleanupIds(process.argv);
  if (!parsed.ok) throw new Error(parsed.error);
  return apply(parsed.ids);
};
run()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
