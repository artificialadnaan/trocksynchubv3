/**
 * Pending RFP Digest — pure builder
 * =================================
 * Builds the daily end-of-day "RFPs still awaiting approval" email from the set of
 * still-pending rfp_approval_requests rows. Kept PURE (no DB / no cron / no env-coupled
 * side effects) so it is unit-testable: callers pass the rows and a recipient-resolver
 * fn (getRfpReviewRecipients in prod). The scheduler does the DB read + the send.
 *
 * Each row renders: project name, project number, date sent, who it's awaiting (the
 * approver recipients for that row), and the approval-page link (reviewUrl).
 *
 * The digest is SCOPED PER RECIPIENT: every RFP is bucketed under ONLY its authorized
 * approvers (the same rfp_approver_config routing the approval email uses), so each
 * approver receives an email containing just the RFPs they may approve. This closes the
 * cross-type-approval exposure a single union email would create (the approve route only
 * checks token/status, so it would otherwise let any digest recipient approve any RFP).
 *
 * Field-extraction (projectName/projectNumber, edited-over-original precedence) mirrors
 * server/rfp-reports.ts so the digest reflects the same values the RFP report shows.
 */

// Canonical-type resolver — imported from the dependency-free constants module (NOT rfp-approval) so
// this builder stays PURE/unit-testable without a DB. Same single source the approve/decline gates
// and the review-email routing use, so the digest buckets each RFP under the approvers who can act.
import { resolveEffectiveRfpProjectType } from "./constants";

/** Minimal shape of a pending rfp_approval_requests row this builder needs. */
export interface PendingRfpRow {
  token: string;
  createdAt: Date | string | null;
  dealData: Record<string, unknown> | null;
  editedFields?: Record<string, unknown> | null;
  sourceSystem?: string | null;
  /** Review-token expiry; null = legacy never-expiring link. Used to drop dead-link rows. */
  tokenExpiresAt?: Date | string | null;
}

/** One scoped digest email for a single approver — only the RFPs they're authorized to approve. */
export interface PendingRfpRecipientDigest {
  recipient: string;
  subject: string;
  htmlBody: string;
  /** Number of pending RFPs in this recipient's scoped digest. */
  count: number;
}

export interface PendingRfpDigest {
  /** true when no approver has any actionable pending RFP — caller sends nothing. */
  skip: boolean;
  /** Total actionable (non-expired) pending RFPs across the whole set. */
  pendingCount: number;
  /** One scoped email per approver who has at least one RFP awaiting them. */
  perRecipient: PendingRfpRecipientDigest[];
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

const CELL_STYLE =
  "padding:10px 12px;border-bottom:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1e293b;vertical-align:top;";
const HEAD_STYLE =
  "padding:10px 12px;border-bottom:2px solid #cbd5e1;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;text-align:left;";

type DigestCell = {
  projectName: string;
  projectNumber: string;
  dateSent: string;
  awaiting: string[];
  reviewUrl: string;
};

/** Render one approver's scoped digest table (only the RFPs awaiting them). */
function renderRecipientDigestHtml(cells: DigestCell[]): string {
  const count = cells.length;
  const tableRows = cells
    .map(
      (c) => `
        <tr>
          <td style="${CELL_STYLE}">${esc(c.projectName)}</td>
          <td style="${CELL_STYLE}">${esc(c.projectNumber)}</td>
          <td style="${CELL_STYLE}">${esc(c.dateSent)}</td>
          <td style="${CELL_STYLE}">${c.awaiting.length ? esc(c.awaiting.join(", ")) : "—"}</td>
          <td style="${CELL_STYLE}"><a href="${esc(c.reviewUrl)}" style="color:#d11921;text-decoration:underline;">Review</a></td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f8fafc;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:760px;margin:0 auto;">
    <tr><td>
      <h2 style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0 0 4px 0;">RFPs Awaiting Your Approval</h2>
      <p style="font-family:Arial,Helvetica,sans-serif;color:#475569;font-size:14px;margin:0 0 20px 0;">
        ${count} RFP${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} awaiting your approval as of end of day. Please review.
      </p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <tr>
          <th style="${HEAD_STYLE}">Project</th>
          <th style="${HEAD_STYLE}">Number</th>
          <th style="${HEAD_STYLE}">Date Sent</th>
          <th style="${HEAD_STYLE}">Awaiting</th>
          <th style="${HEAD_STYLE}">Link</th>
        </tr>
        ${tableRows}
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function buildPendingRfpDigest(
  rows: PendingRfpRow[],
  resolveRecipients: RfpRecipientResolver,
  // Public base URL for the review links (prod: process.env.APP_URL). Required and
  // passed in by the caller — the builder never falls back to localhost, so a
  // missing config can't bake unusable links into a sent email (the scheduler
  // refuses to send when it's absent).
  appUrl: string,
  // Predicate marking a row's review token expired (prod: isRfpApprovalRequestExpired —
  // the SAME check the public review route uses to 410 the link). Expired-but-still-'pending'
  // rows are dropped: re-sending a /rfp-review/<token> link that can no longer be approved only
  // frustrates approvers. Rows with null tokenExpiresAt are legacy never-expiring links → kept.
  isExpired: (row: { tokenExpiresAt?: Date | string | null }) => boolean
): Promise<PendingRfpDigest> {
  // Only actionable (non-expired) pending RFPs belong in the reminder.
  const actionable = rows.filter((row) => !isExpired(row));
  const pendingCount = actionable.length;
  if (pendingCount === 0) {
    return { skip: true, pendingCount: 0, perRecipient: [] };
  }

  // Strip any trailing slash so a configured base URL like "https://host/" doesn't
  // produce a malformed "//rfp-review/..." link.
  const baseUrl = appUrl.replace(/\/+$/, "");

  // Bucket each RFP under ONLY its authorized approvers (resolveRecipients = the same
  // rfp_approver_config routing the approval email uses). Each approver's digest therefore
  // contains just the RFPs they may approve, so a non-service approver never receives an
  // actionable link for a service-only RFP.
  const buckets = new Map<string, DigestCell[]>();

  for (const row of actionable) {
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
    const reviewUrl = `${baseUrl}/rfp-review/${row.token}`;

    // "Who it's awaiting" = the approver recipients for this row, via the SAME resolver the
    // approval email uses (so Item-3's Tim flows in automatically). Routes by the CANONICAL type the
    // approval would create — resolveEffectiveRfpProjectType(dealData, editedFields), the same source
    // the approve gate authorizes the created type against — NOT the raw project_types. So a row with
    // project_types '2' but project_number 'DFW-4-...' buckets under the SERVICE approvers who can act,
    // and a pending row whose project_types was edited into a new routing group buckets under the type
    // the approval will actually create (not the stale routed type). No-op for consistent rows.
    const awaiting = Array.from(
      new Set(
        (
          await resolveRecipients(
            resolveEffectiveRfpProjectType(dealData, editedFields),
            row.sourceSystem ?? null
          )
        )
          .map((r) => String(r ?? "").trim())
          .filter((r) => r.length > 0)
      )
    );

    const cell: DigestCell = { projectName, projectNumber, dateSent, awaiting, reviewUrl };
    // Scope: this RFP only goes to its own authorized approvers.
    for (const approver of awaiting) {
      const list = buckets.get(approver);
      if (list) list.push(cell);
      else buckets.set(approver, [cell]);
    }
  }

  // Actionable rows existed but none resolved to any approver (e.g. empty config) — nothing to send.
  if (buckets.size === 0) {
    return { skip: true, pendingCount, perRecipient: [] };
  }

  const perRecipient: PendingRfpRecipientDigest[] = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recipient, cells]) => ({
      recipient,
      count: cells.length,
      subject: `RFPs Awaiting Your Approval — ${cells.length} pending`,
      htmlBody: renderRecipientDigestHtml(cells),
    }));

  return { skip: false, pendingCount, perRecipient };
}
