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
import { recipientReviewUrl } from "./rfp-recipient-link";
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

/**
 * Resolves the approver recipients for one row (prod: resolveRfpReviewRecipients, mapped). null means the approver
 * config could not be read: the safety net is not known to be the authorized set, so no signed link is issued for
 * that row's configured approvers (#47; the GLOBAL_CC directors below are config-independent and still get one).
 */
export type RfpRecipientResolver = (
  projectType: string | null | undefined,
  sourceSystem: string | null | undefined
) => Promise<string[] | null>;

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
  /** The RFP's request token; each recipient's link is signed to THEM at render time (#47). */
  token: string;
};

/**
 * The review link one recipient receives for one RFP token (#47). Prod: recipientReviewUrl (server/rfp-recipient-link.ts),
 * signed to that recipient, so a digest link acts as its recipient only. Injected to keep this builder pure.
 */
export type RfpReviewLinkFor = (token: string, recipient: string) => string;

/** Render one approver's scoped digest table (only the RFPs awaiting them). */
function renderRecipientDigestHtml(cells: DigestCell[], recipient: string, linkFor: RfpReviewLinkFor): string {
  const count = cells.length;
  const tableRows = cells
    .map(
      (c) => `
        <tr>
          <td style="${CELL_STYLE}">${esc(c.projectName)}</td>
          <td style="${CELL_STYLE}">${esc(c.projectNumber)}</td>
          <td style="${CELL_STYLE}">${esc(c.dateSent)}</td>
          <td style="${CELL_STYLE}">${c.awaiting.length ? esc(c.awaiting.join(", ")) : "—"}</td>
          <td style="${CELL_STYLE}"><a href="${esc(linkFor(c.token, recipient))}" style="color:#d11921;text-decoration:underline;">Review</a></td>
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
  isExpired: (row: { tokenExpiresAt?: Date | string | null }) => boolean,
  // How a recipient's link is built (#47). Default: signed to that recipient with SESSION_SECRET's HKDF key.
  linkFor: RfpReviewLinkFor = (token, recipient) => recipientReviewUrl(appUrl, token, recipient),
  // Approvers authorized for EVERY RFP regardless of type (prod: the GLOBAL_CC directors). The initial review email
  // sends each of them a signed copy (#47), so the digest must too: after a deploy or a SESSION_SECRET rotation it is
  // the only path that reissues their links for RFPs already pending. Never RFP_ADMIN_EMAIL (a personal inbox).
  alwaysAuthorized: readonly string[] = [],
): Promise<PendingRfpDigest> {
  // Only actionable (non-expired) pending RFPs belong in the reminder.
  const actionable = rows.filter((row) => !isExpired(row));
  const pendingCount = actionable.length;
  if (pendingCount === 0) {
    return { skip: true, pendingCount: 0, perRecipient: [] };
  }

  // (recipientReviewUrl strips a trailing slash from appUrl, so "https://host/" never yields "//rfp-review/".)

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

    // "Who it's awaiting" = the approvers who can ACTUALLY act on this row, mirroring the approve gate
    // EXACTLY: authorized for BOTH the BASELINE (project-number) type AND the CREATED (edited) type.
    // Uses the same resolver the approval email + gate use (so Item-3's Tim flows in). For an unedited
    // row baseline === created, so this is just that type's set (and we skip the second lookup); for an
    // edited pending row (e.g. project_types reset/edited away from the number's type) it's the
    // INTERSECTION — only a dual-authorized approver can finalize a type change, so bucketing under the
    // created type alone would remind created-type approvers the gate would 403.
    const baselineType = resolveEffectiveRfpProjectType(dealData);
    const createdType = resolveEffectiveRfpProjectType(dealData, editedFields);
    // Trim AND lowercase, matching the approve gate's normalizeApproverEmail, so the baseline∩created
    // intersection is case-insensitive (an approver in both sets under different casing still matches).
    const normRecipients = (list: readonly string[]) =>
      new Set(list.map((r) => String(r ?? "").trim().toLowerCase()).filter((r) => r.length > 0));
    // An unreadable config (null) contributes nobody: an empty set fails the intersection closed.
    const baselineRecipients = normRecipients(
      (await resolveRecipients(baselineType, row.sourceSystem ?? null)) ?? []
    );
    const createdRecipients =
      createdType === baselineType
        ? baselineRecipients
        : normRecipients((await resolveRecipients(createdType, row.sourceSystem ?? null)) ?? []);
    const awaiting = Array.from(baselineRecipients).filter((r) => createdRecipients.has(r));

    const cell: DigestCell = { projectName, projectNumber, dateSent, awaiting, token: row.token };
    // Scope: this RFP only goes to its own authorized approvers, plus the directors authorized for every RFP.
    for (const approver of new Set([...awaiting, ...normRecipients(alwaysAuthorized)])) {
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
      htmlBody: renderRecipientDigestHtml(cells, recipient, linkFor),
    }));

  return { skip: false, pendingCount, perRecipient };
}
