/**
 * Pending RFP Digest Scheduler — end-of-day reminder of un-approved RFPs.
 * =======================================================================
 * Fires Mon–Sat at 5:00 PM America/Chicago. Reads every still-pending
 * rfp_approval_requests row, builds ONE union digest (buildPendingRfpDigest), and
 * sends a single email to the union of approvers across the pending set so they can
 * come approve them. Skips the send entirely when there are 0 pending RFPs.
 */

import cron from "node-cron";
import { eq, asc } from "drizzle-orm";
import { db } from "../db";
import { rfpApprovalRequests } from "@shared/schema";
import { getRfpReviewRecipients } from "../rfp-approval";
import { buildPendingRfpDigest } from "../pendingRfpDigest";
import { sendEmail } from "../email-service";

let cronTask: ReturnType<typeof cron.schedule> | null = null;

async function runPendingRfpDigest(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(rfpApprovalRequests)
      .where(eq(rfpApprovalRequests.status, "pending"))
      .orderBy(asc(rfpApprovalRequests.createdAt));

    // jsonb columns infer as `unknown`; cast at the boundary (same as rfp-reports.ts) so the
    // pure builder keeps its strict, documented row shape.
    const digest = await buildPendingRfpDigest(
      rows.map((r) => ({
        token: r.token,
        createdAt: r.createdAt,
        dealData: (r.dealData as Record<string, unknown> | null) ?? null,
        editedFields: (r.editedFields as Record<string, unknown> | null) ?? null,
        sourceSystem: r.sourceSystem,
      })),
      getRfpReviewRecipients
    );
    if (digest.skip || digest.recipients.length === 0) {
      console.log(
        `[pending-rfp-digest] No email sent (pending=${digest.pendingCount}, recipients=${digest.recipients.length})`
      );
      return;
    }

    // Single union send: first approver in `to`, the rest cc'd (sendEmail.to is a single
    // address; GLOBAL_CC is appended automatically). One email, the whole pending list.
    const [primary, ...rest] = digest.recipients;
    console.log(
      `[pending-rfp-digest] Sending digest: pending=${digest.pendingCount}, recipients=${digest.recipients.length}`
    );
    await sendEmail({
      to: primary,
      cc: rest,
      subject: digest.subject,
      htmlBody: digest.htmlBody,
    });
  } catch (e: unknown) {
    console.error(
      "[pending-rfp-digest] Scheduled digest failed:",
      e instanceof Error ? e.message : e
    );
  }
}

export function startPendingRfpDigestScheduler() {
  stopPendingRfpDigestScheduler();
  // Mon–Sat at 5:00 PM Central — end-of-day reminder before approvers leave.
  cronTask = cron.schedule("0 17 * * 1-6", runPendingRfpDigest, {
    timezone: "America/Chicago",
  });
  console.log("[pending-rfp-digest] EOD pending-RFP digest scheduler started (Mon–Sat 5:00 PM CT)");
}

export function stopPendingRfpDigestScheduler() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
