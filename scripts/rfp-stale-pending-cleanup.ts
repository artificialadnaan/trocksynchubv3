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
 * RUN FROM A CHECKOUT, not inside the deployed container: the production image ships the bundle, not server/
 * (Codex round 4 on #114). Use SyncHub's production env (CRM / HubSpot credentials the gate uses), with DATABASE_URL
 * set to the database's PUBLIC url, e.g. `railway run --service <synchub> -- env DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx ...`.
 *
 * An id with ANY rfp_approval_attempt audit row is never cancelled (an approval may be in flight; re-checked inside
 * the apply transaction) and the preview lists it as approval_attempted.
 *
 *   npx tsx scripts/rfp-stale-pending-cleanup.ts                       # preview
 *   npx tsx scripts/rfp-stale-pending-cleanup.ts --apply --ids=12,40   # ONLY the ids the owner approved by name
 *
 * APPLY: for each listed id STILL 'pending', status -> 'cancelled_source_ineligible' (the status the approve gate
 * itself sets for an ineligible source) and its audit_logs row, in ONE transaction (Codex P2 / CodeRabbit on #114).
 * The --ids list is all or nothing. NO email is sent, nothing is deleted, and an id that is no longer pending is
 * skipped and reported.
 */
import { tmpdir } from "os";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../server/db";
import { auditLogs, rfpApprovalRequests } from "@shared/schema";
// The side-effect-free eligibility module, NOT rfp-approval: that one's import graph boots the SyncHub server
// (Express, schedulers, workers) via ./index (Codex P1 on #114). A test pins the closure.
import { checkRfpApprovalSourceEligibility } from "../server/rfp-source-eligibility";
import { classifyPendingRfp, parseOlderThanDays, parseRfpCleanupIds, rfpCleanupBlock, rfpDisplayName as name } from "../server/pendingRfpOpen";
import { writeRfpCleanupSnapshot } from "../server/rfpCleanupSnapshot";

const OLDER_THAN_DAYS = parseOlderThanDays(process.env.PENDING_RFP_DIGEST_OLDER_DAYS);

// How many approval attempts the audit log holds for one request (processRfpApproval writes one before any work).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function approvalAttempts(q: typeof db | Tx, requestId: number): Promise<number> {
  const rows = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "rfp_approval_attempt"), sql`${auditLogs.details}->>'requestId' = ${String(requestId)}`));
  return rows[0]?.n ?? 0;
}

async function preview() {
  const now = new Date();
  const rows = await db.select().from(rfpApprovalRequests).where(eq(rfpApprovalRequests.status, "pending")).orderBy(asc(rfpApprovalRequests.createdAt));
  const out = [];
  for (const r of rows) {
    const c = classifyPendingRfp(r, await checkRfpApprovalSourceEligibility(r), now, OLDER_THAN_DAYS);
    const blocked = rfpCleanupBlock(await approvalAttempts(db, r.id));
    const n = name(r);
    out.push({
      id: r.id, group: blocked ? "approval_attempted" : c.group, reason: blocked ?? c.reason, ageDays: c.ageDays, name: n, projectNumber: r.projectNumber ?? null,
      source: `${r.sourceSystem}:${r.sourceDealId}`, sentAt: r.createdAt, testLooking: /test/i.test(n),
    });
  }
  for (const group of ["source_ineligible", "approval_attempted", "older", "open"] as const) {
    const list = out.filter((o) => o.group === group);
    console.log(`\n== ${group} (${list.length})`);
    for (const o of list) {
      console.log(`  #${o.id}  ${o.name}  ${o.projectNumber ?? "(no number)"}  ${o.ageDays ?? "?"}d  ${o.testLooking ? "[TEST?] " : ""}— ${o.reason}`);
    }
  }
  const file = writeRfpCleanupSnapshot(tmpdir(), out);
  console.log(`\npreview only: nothing written to the database. Snapshot: ${file}`);
}

async function apply(ids: number[]) {
  const rows = await db.select().from(rfpApprovalRequests).where(inArray(rfpApprovalRequests.id, ids));
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    if (!r) { console.log(`#${id}: not found — skipped`); continue; }
    // The status change and its audit row commit TOGETHER: an audit failure rolls the cancellation back.
    const done = await db.transaction(async (tx) => {
      // Re-checked HERE, in the same transaction as the update: never cancel a request an approver already started.
      const blocked = rfpCleanupBlock(await approvalAttempts(tx, id));
      if (blocked) return blocked;
      const updated = await tx
        .update(rfpApprovalRequests)
        .set({ status: "cancelled_source_ineligible" })
        // ONE conditional statement (CodeRabbit on #114): the attempt test lives in the UPDATE itself, so there is no
        // gap between "no attempt yet" and the write. The count above only names the reason for the report.
        .where(and(
          eq(rfpApprovalRequests.id, id),
          eq(rfpApprovalRequests.status, "pending"),
          sql`NOT EXISTS (SELECT 1 FROM ${auditLogs} WHERE ${auditLogs.action} = 'rfp_approval_attempt' AND ${auditLogs.details}->>'requestId' = ${String(id)})`,
        ))
        .returning({ id: rfpApprovalRequests.id });
      if (updated.length === 0) return "no longer pending, or an approval attempt just appeared";
      await tx.insert(auditLogs).values({
        action: "rfp_stale_pending_cleanup",
        entityType: "deal",
        entityId: r.sourceDealId,
        source: "rfp-stale-pending-cleanup",
        status: "success",
        category: "system",
        details: { requestId: id, from: "pending", to: "cancelled_source_ineligible", name: name(r), projectNumber: r.projectNumber, ownerGo: "ids approved by the owner by name" },
      });
      return null;
    });
    if (done) { console.log(`#${id}: ${done} — skipped`); continue; }
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
