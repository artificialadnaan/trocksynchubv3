/**
 * Pending RFP Digest — pure builder
 * =================================
 * Builds the daily end-of-day "RFPs still awaiting approval" email from the set of
 * still-pending rfp_approval_requests rows. Kept PURE (no DB / no cron / no env-coupled
 * side effects) so it is unit-testable: callers pass the rows and a recipient-resolver
 * fn (getRfpReviewRecipients in prod). The scheduler does the DB read + the send.
 *
 * Each row renders: project name, project number, date sent, who it's awaiting (the
 * approver recipients for that row), and the approval-page link (reviewUrl). The email
 * is a SINGLE union digest: one message listing every pending RFP, addressed to the
 * union of approvers across the whole pending set.
 *
 * Field-extraction (projectName/projectNumber, edited-over-original precedence) mirrors
 * server/rfp-reports.ts so the digest reflects the same values the RFP report shows.
 */

/** Minimal shape of a pending rfp_approval_requests row this builder needs. */
export interface PendingRfpRow {
  token: string;
  createdAt: Date | string | null;
  dealData: Record<string, unknown> | null;
  editedFields?: Record<string, unknown> | null;
  sourceSystem?: string | null;
}

export interface PendingRfpDigest {
  /** true when there are no pending RFPs — caller skips the send entirely. */
  skip: boolean;
  /** Union of approver recipients across all pending rows (de-duplicated, trimmed). */
  recipients: string[];
  subject: string;
  htmlBody: string;
  pendingCount: number;
}

/** Resolves the approver recipients for one row (prod = getRfpReviewRecipients). */
export type RfpRecipientResolver = (
  projectType: string | null | undefined,
  sourceSystem: string | null | undefined
) => Promise<string[]>;

/** Normalize null/undefined/blank-string to undefined so `??` chains skip blanks like `||` did. */
function blankToUndef(v: unknown): unknown {
  return v !== undefined && v !== null && String(v).trim() !== "" ? v : undefined;
}

/** Pick a reviewer-edited value for `key` (from editedFields), or undefined if absent/blank. */
function pickEditedValue(
  editedFields: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  return blankToUndef(editedFields?.[key]);
}

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Format the date the RFP was sent (createdAt) in Central time; "—" when missing/invalid. */
function formatDateSent(createdAt: Date | string | null | undefined): string {
  if (!createdAt) return "—";
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export async function buildPendingRfpDigest(
  rows: PendingRfpRow[],
  resolveRecipients: RfpRecipientResolver
): Promise<PendingRfpDigest> {
  const pendingCount = rows.length;
  if (pendingCount === 0) {
    return { skip: true, recipients: [], subject: "", htmlBody: "", pendingCount: 0 };
  }

  const appUrl = process.env.APP_URL || "http://localhost:5000";
  const recipientUnion = new Set<string>();
  const cells: Array<{
    projectName: string;
    projectNumber: string;
    dateSent: string;
    awaiting: string[];
    reviewUrl: string;
  }> = [];

  for (const row of rows) {
    const dealData = (row.dealData as Record<string, unknown>) || {};
    const editedFields = (row.editedFields as Record<string, unknown> | null) || null;

    const projectName = String(
      pickEditedValue(editedFields, "dealname") ??
        pickEditedValue(editedFields, "project_name") ??
        blankToUndef(dealData.dealname) ??
        blankToUndef(dealData.project_name) ??
        "—"
    );
    const projectNumber = String(
      pickEditedValue(editedFields, "project_number") ??
        blankToUndef(dealData.project_number) ??
        "—"
    );
    const dateSent = formatDateSent(row.createdAt);
    const reviewUrl = `${appUrl}/rfp-review/${row.token}`;

    // "Who it's awaiting" = the approver recipients for this row, via the SAME resolver the
    // approval email uses (so Item-3's Tim flows in automatically). Inputs mirror the live
    // send path: dealData.project_types + the row's sourceSystem.
    const awaiting = await resolveRecipients(
      dealData.project_types as string | null | undefined,
      row.sourceSystem ?? null
    );
    for (const r of awaiting) {
      const trimmed = String(r ?? "").trim();
      if (trimmed) recipientUnion.add(trimmed);
    }

    cells.push({ projectName, projectNumber, dateSent, awaiting, reviewUrl });
  }

  const recipients = Array.from(recipientUnion);

  const cellStyle =
    "padding:10px 12px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;vertical-align:top;";
  const headStyle =
    "padding:10px 12px;border-bottom:2px solid #cbd5e1;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;text-align:left;";

  const tableRows = cells
    .map(
      (c) => `
        <tr>
          <td style="${cellStyle}">${esc(c.projectName)}</td>
          <td style="${cellStyle}">${esc(c.projectNumber)}</td>
          <td style="${cellStyle}">${esc(c.dateSent)}</td>
          <td style="${cellStyle}">${c.awaiting.length ? esc(c.awaiting.join(", ")) : "—"}</td>
          <td style="${cellStyle}"><a href="${esc(c.reviewUrl)}" style="color:#d11921;text-decoration:underline;">Review</a></td>
        </tr>`
    )
    .join("");

  const subject = `RFPs Awaiting Approval — ${pendingCount} pending`;

  const htmlBody = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f8fafc;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:760px;margin:0 auto;">
    <tr><td>
      <h2 style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0 0 4px 0;">RFPs Awaiting Approval</h2>
      <p style="font-family:Arial,Helvetica,sans-serif;color:#475569;font-size:14px;margin:0 0 20px 0;">
        ${pendingCount} RFP${pendingCount === 1 ? "" : "s"} ${pendingCount === 1 ? "is" : "are"} still pending approval as of end of day. Please review.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tr>
          <th style="${headStyle}">Project</th>
          <th style="${headStyle}">Number</th>
          <th style="${headStyle}">Date Sent</th>
          <th style="${headStyle}">Awaiting</th>
          <th style="${headStyle}">Link</th>
        </tr>
        ${tableRows}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { skip: false, recipients, subject, htmlBody, pendingCount };
}
