/**
 * RFP Reports API & Scheduled Email Engine
 * =========================================
 * Handles RFP reporting, change history, approval chain, export, and scheduled emails.
 */

import { eq, desc, and, gte, lte, sql, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import {
  rfpApprovalRequests,
  rfpChangeLog,
  rfpApprovals,
  reportScheduleConfig,
  syncMappings,
} from "@shared/schema";
import { sendEmail } from "./email-service";
import { DEFAULT_PROCORE_COMPANY_ID, PROJECT_TYPES, parseProjectTypeFromNumber } from "./constants";
import type { Request, Response } from "express";

/** Return the value only if it is an absolute http(s) URL, else null — so we never emit a
 *  relative/unsafe href into an email, regardless of where the value originated. */
export function safeHttpUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** Pick a reviewer-edited value for `key` (from editedFields), or undefined if absent/blank.
 *  On approval the reviewer's final edits are persisted to editedFields while dealData keeps the
 *  pre-edit values, so for any editable display field the edited value is the current truth. */
/** Normalize null/undefined/blank-string to undefined, so `??` chains skip blanks like `||` did. */
export function blankToUndef(v: unknown): unknown {
  return v !== undefined && v !== null && String(v).trim() !== "" ? v : undefined;
}

export function pickEditedValue(
  editedFields: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  return blankToUndef(editedFields?.[key]);
}

/** Resolve the project-type badge, preferring the reviewer-edited type over the original. */
export function resolveDisplayProjectType(
  dealData: Record<string, unknown>,
  editedFields: Record<string, unknown> | null | undefined,
  projectNumber?: string | null
): string | null {
  const projectTypes = pickEditedValue(editedFields, "project_types") ?? dealData?.project_types;
  return resolveProjectTypeLabel({ project_types: projectTypes }, projectNumber);
}

/** Resolve a human-readable project-type label (e.g. "Service", "Interior Renovation"). */
export function resolveProjectTypeLabel(
  dealData: Record<string, unknown>,
  projectNumber?: string | null
): string | null {
  const raw = String(dealData?.project_types ?? "").trim();
  // Stored as a 1–9 dropdown code → map to its label.
  if (/^[1-9]$/.test(raw)) return PROJECT_TYPES[raw] ?? null;
  // A non-numeric value is already a readable label (e.g. "Roofing"); a numeric value
  // outside 1–9 is an unknown code — never show a raw code as a badge.
  if (raw && !/^\d+$/.test(raw)) return raw;
  // Fall back to the digit encoded in the project number (e.g. DFW-4-… → Service).
  const digit = projectNumber ? parseProjectTypeFromNumber(projectNumber) : null;
  return digit ? PROJECT_TYPES[digit] ?? null : null;
}

/**
 * Build a Procore Bid Board deep link from a bidboard project id (null until the project exists).
 * Uses the canonical Bid Board namespace (`/tools/bid-board/project/{id}/details`) — the same
 * shape used everywhere else in the app (stage-notifications, portfolio-automation, routes/portfolio).
 * NOTE: bidboardProjectId is a Bid Board id, NOT a Procore portfolio-project id — do not use the
 * `/projects/{id}/tools/estimating` form, which is a different id namespace.
 */
export function buildBidBoardUrl(bidboardProjectId: string | null | undefined): string | null {
  const id = String(bidboardProjectId ?? "").trim();
  if (!id) return null;
  return `https://us02.procore.com/webclients/host/companies/${DEFAULT_PROCORE_COMPANY_ID}/tools/bid-board/project/${encodeURIComponent(id)}/details`;
}

/** Resolve the actionable RFP amount: a reviewer's edited value wins over the original deal amount. */
export function resolveRfpAmount(
  dealData: Record<string, unknown>,
  editedFields: Record<string, unknown> | null | undefined
): number | null {
  const raw = editedFields?.amount ?? dealData?.amount;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Format a number as USD for display (e.g. 1234.5 -> "$1,235"). Returns "—" when null. */
export function formatRfpAmount(amount: number | null): string {
  if (amount === null) return "—";
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export interface RfpReportFilters {
  dateFrom?: string;
  dateTo?: string;
  projectNumber?: string;
  status?: string;
  recipient?: string;
  page?: number;
  limit?: number;
}

export interface RfpReportRow {
  id: number;
  hubspotDealId: string;
  projectName: string;
  projectNumber: string;
  /** Human-readable project type (e.g. "Interior Renovation", "Service"); null when unknown. */
  projectType: string | null;
  recipient: string;
  dateSent: string;
  bidboardStage: string;
  approvalStatus: string;
  changeCount: number;
  /** Actionable RFP amount (reviewer-edited value wins over original); null when absent. */
  amount: number | null;
  /** Person the RFP belongs to — the deal owner (name preferred, falls back to email). */
  requestedBy: string;
  /** Approver email, or null when the RFP is still pending. */
  approvedBy: string | null;
  /** Decliner email when the RFP was rejected; null otherwise. */
  declinedBy: string | null;
  /** Procore Bid Board deep link; null until a Bid Board project exists (post-approval). */
  bidBoardUrl: string | null;
  /** Source CRM/HubSpot deep link to the deal; null when unavailable. */
  crmUrl: string | null;
}

/** Get paginated RFP list with filters */
export async function getRfpReportList(
  filters: RfpReportFilters
): Promise<{ data: RfpReportRow[]; total: number }> {
  const limit = Math.min(filters.limit || 50, 100);
  const offset = ((filters.page || 1) - 1) * limit;

  const conditions = [];

  if (filters.dateFrom) {
    conditions.push(gte(rfpApprovalRequests.createdAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const end = new Date(filters.dateTo);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(rfpApprovalRequests.createdAt, end));
  }
  if (filters.status) {
    // Treat "rejected" filter as including both rejected and declined (legacy naming)
    if (filters.status === "rejected") {
      conditions.push(inArray(rfpApprovalRequests.status, ["rejected", "declined"]));
    } else {
      conditions.push(eq(rfpApprovalRequests.status, filters.status));
    }
  }
  if (filters.projectNumber?.trim()) {
    const pnPattern = `%${filters.projectNumber.trim()}%`;
    // Search edited_fields and the top-level project_number column too, so a search for the
    // (possibly reviewer-edited) value shown on the row still matches the RFP.
    conditions.push(
      sql`(
        COALESCE(${rfpApprovalRequests.dealData}->>'project_number', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'dealname', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'project_name', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.editedFields}->>'project_number', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.editedFields}->>'dealname', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.projectNumber}, '') ILIKE ${pnPattern}
      )`
    );
  }
  if (filters.recipient?.trim()) {
    const recPattern = `%${filters.recipient.trim()}%`;
    conditions.push(
      sql`(
        COALESCE(${rfpApprovalRequests.dealData}->>'ownerEmail', '') ILIKE ${recPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'ownerName', '') ILIKE ${recPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'dealname', '') ILIKE ${recPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'project_name', '') ILIKE ${recPattern}
        OR COALESCE(${rfpApprovalRequests.editedFields}->>'dealname', '') ILIKE ${recPattern}
        OR COALESCE(${rfpApprovalRequests.editedFields}->>'project_name', '') ILIKE ${recPattern}
      )`
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rfps = await db
    .select()
    .from(rfpApprovalRequests)
    .where(whereClause)
    .orderBy(desc(rfpApprovalRequests.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(rfpApprovalRequests)
    .where(whereClause);

  const total = countRow?.count ?? 0;

  const changeCounts = await db
    .select({
      rfpId: rfpChangeLog.rfpId,
      count: sql<number>`count(*)::int`,
    })
    .from(rfpChangeLog)
    .groupBy(rfpChangeLog.rfpId);

  const changeMap = new Map(changeCounts.map((c) => [c.rfpId, c.count]));

  const dealIds = [...new Set(rfps.map((r) => r.hubspotDealId))].filter(
    (id): id is string => Boolean(id)
  );
  const mappings =
    dealIds.length > 0
      ? await db
          .select()
          .from(syncMappings)
          .where(inArray(syncMappings.hubspotDealId, dealIds))
      : [];

  const mappingByDeal = new Map(mappings.map((m) => [m.hubspotDealId, m]));

  let data: RfpReportRow[] = rfps.map((rfp) => {
    const dealData = (rfp.dealData as Record<string, unknown>) || {};
    const editedFields = (rfp.editedFields as Record<string, unknown> | null) || null;
    // Overlay reviewer-edited values (same precedence the amount already uses) so an approved
    // RFP's card reflects the final type/number/name, not the stale pre-edit dealData.
    // blankToUndef on the dealData reads so a present-but-blank dealname still falls through to
    // project_name (matching the original `dealname || project_name` behavior).
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
    const projectType = resolveDisplayProjectType(dealData, editedFields, projectNumber);
    const recipient = String(dealData.ownerEmail || dealData.ownerName || "—");
    // "Requested by" = the deal owner (name preferred); distinct from the approver.
    const requestedBy = String(dealData.ownerName || dealData.ownerEmail || "—");
    const amount = resolveRfpAmount(dealData, editedFields);
    // A Bid Board project only exists once the RFP is approved; gate on status so a non-approved
    // row can never surface a Bid Board link (defensive — bidboardProjectId is only set on approval).
    const bidBoardUrl = rfp.status === "approved" ? buildBidBoardUrl(rfp.bidboardProjectId) : null;
    // Only emit an absolute http(s) link so a malformed/relative stored value never
    // produces a broken button in recipients' inboxes.
    const crmUrl = safeHttpUrl(dealData.sourceDealUrl ?? dealData.hubspotDealUrl);
    const approvedBy = rfp.approvedBy ? String(rfp.approvedBy) : null;
    const declinedBy = rfp.declinedBy ? String(rfp.declinedBy) : null;
    const mapping = mappingByDeal.get(rfp.hubspotDealId);

    let bidboardStage = "—";
    if (mapping?.bidboardProjectName) {
      bidboardStage = mapping.lastSyncStatus || "Linked";
    }

    const changeCount = changeMap.get(rfp.id) ?? 0;

    // Normalize "declined" → "rejected" for report display, filters, and approval summary
    const approvalStatus = rfp.status === "declined" ? "rejected" : rfp.status;

    return {
      id: rfp.id,
      hubspotDealId: rfp.hubspotDealId ?? "",
      projectName,
      projectNumber,
      projectType,
      recipient,
      dateSent: rfp.createdAt ? new Date(rfp.createdAt).toISOString() : "",
      bidboardStage,
      approvalStatus,
      changeCount,
      amount,
      requestedBy,
      approvedBy,
      declinedBy,
      bidBoardUrl,
      crmUrl,
    };
  });

  return { data, total };
}

/** Build approval chain for an RFP (from rfp_approvals + legacy approvedBy/declinedBy) */
export async function getRfpApprovalChain(rfpId: number) {
  const [rfp, approvals] = await Promise.all([
    storage.getRfpApprovalRequestById(rfpId),
    storage.getRfpApprovals(rfpId),
  ]);

  const chain: Array<{
    approverEmail: string;
    status: "pending" | "approved" | "rejected";
    comments: string | null;
    decidedAt: string | null;
  }> = [];

  if (approvals.length > 0) {
    chain.push(
      ...approvals.map((a) => ({
        approverEmail: a.approverEmail,
        status: a.status as "pending" | "approved" | "rejected",
        comments: a.comments,
        decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
      }))
    );
  } else if (rfp) {
    if (rfp.approvedBy) {
      chain.push({
        approverEmail: rfp.approvedBy,
        status: "approved" as const,
        comments: null,
        decidedAt: rfp.approvedAt ? new Date(rfp.approvedAt).toISOString() : null,
      });
    }
    if (rfp.declinedBy) {
      chain.push({
        approverEmail: rfp.declinedBy,
        status: "rejected" as const,
        comments: null,
        decidedAt: rfp.declinedAt ? new Date(rfp.declinedAt).toISOString() : null,
      });
    }
    if (chain.length === 0 && rfp.status === "pending") {
      chain.push({
        approverEmail: "Awaiting approval",
        status: "pending" as const,
        comments: null,
        decidedAt: null,
      });
    }
  }

  return chain;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Compute next scheduled report run (timezone-aware, no Date-from-locale-string) */
export function computeNextRun(config: {
  enabled?: boolean;
  frequency?: string;
  dayOfWeek?: number | null;
  timeOfDay?: string;
  timezone?: string;
  recipients?: string[];
}): string {
  if (!config?.enabled || !config.recipients?.length) return "Not scheduled";
  const tz = config.timezone || "America/Chicago";
  const tzLabel = tz.split("/")[1]?.replace("_", " ") || "CT";
  const recipientCount = config.recipients.length;

  const freq = config.frequency || "weekly";
  const targetDow = config.dayOfWeek ?? 1;
  const timeStr = String(config.timeOfDay || "08:00");
  const [configHour, configMin] = timeStr.split(":").map(Number);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });

  const now = new Date();

  const getParts = (d: Date) => {
    const parts = formatter.formatToParts(d);
    return {
      hour: parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10),
      minute: parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10),
      weekday: parts.find((p) => p.type === "weekday")?.value ?? "Sun",
      day: parseInt(parts.find((p) => p.type === "day")?.value ?? "0", 10),
      month: parseInt(parts.find((p) => p.type === "month")?.value ?? "0", 10),
      year: parseInt(parts.find((p) => p.type === "year")?.value ?? "0", 10),
    };
  };

  const isRunDay = (d: Date): boolean => {
    const { hour, minute, weekday, day } = getParts(d);
    const currentDow = DOW_MAP[weekday] ?? 0;
    const slot = hour * 4 + Math.floor(minute / 15);
    const targetSlot = (configHour || 8) * 4 + Math.floor((configMin || 0) / 15);

    if (slot !== targetSlot) return false;

    switch (freq) {
      case "daily":
        return true;
      case "weekly":
        return currentDow === targetDow;
      case "biweekly": {
        const weekNum = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000));
        return currentDow === targetDow && weekNum % 2 === 0;
      }
      case "monthly":
        return day === 1;
      default:
        return currentDow === targetDow;
    }
  };

  const formatDisplay = (d: Date): string => {
    const parts = formatter.formatToParts(d);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const day = parseInt(parts.find((p) => p.type === "day")?.value ?? "1", 10);
    const month = parseInt(parts.find((p) => p.type === "month")?.value ?? "1", 10);
    const year = parts.find((p) => p.type === "year")?.value ?? "2025";
    const monthName = MONTH_NAMES[month - 1] ?? "Jan";
    const dayName = DAY_NAMES[DOW_MAP[weekday] ?? 1] ?? weekday;
    const h = configHour ?? 8;
    const m = configMin ?? 0;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    const minStr = String(m).padStart(2, "0");
    return `${dayName}, ${monthName} ${day}, ${year} at ${h12}:${minStr} ${ampm} ${tzLabel} to ${recipientCount} recipient${recipientCount !== 1 ? "s" : ""}`;
  };

  const maxSlots = 90 * 24 * 4;
  for (let i = 1; i <= maxSlots; i++) {
    const candidate = new Date(now.getTime() + i * 15 * 60 * 1000);
    if (isRunDay(candidate)) {
      return formatDisplay(candidate);
    }
  }

  return `No run in next 90 days (${tzLabel})`;
}

/** Export RFPs as CSV */
export function exportRfpsToCsv(data: RfpReportRow[]): string {
  const headers = [
    "Project Name",
    "Project #",
    "Recipient",
    "Date Sent",
    "Bid Board Stage",
    "Approval Status",
    "# Changes",
  ];
  const rows = data.map((r) => [
    r.projectName,
    r.projectNumber,
    r.recipient,
    r.dateSent ? new Date(r.dateSent).toLocaleString() : "",
    r.bidboardStage,
    r.approvalStatus,
    String(r.changeCount),
  ]);

  const escape = (v: string) => {
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n"))
      return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  return [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\n");
}

/** Export RFPs as simple PDF (HTML-based, readable in browser/print) */
export function exportRfpsToPdfHtml(data: RfpReportRow[]): string {
  const rows = data
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.projectName)}</td>
      <td>${escapeHtml(r.projectNumber)}</td>
      <td>${escapeHtml(r.recipient)}</td>
      <td>${r.dateSent ? new Date(r.dateSent).toLocaleString() : ""}</td>
      <td>${escapeHtml(r.bidboardStage)}</td>
      <td>${escapeHtml(r.approvalStatus)}</td>
      <td>${r.changeCount}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>RFP Report — T-Rock Construction</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 0; color: #111214; background: #fff; }
    .header { background: #1e2024; padding: 20px 32px; display: flex; align-items: center; gap: 16px; }
    .header-text { color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
    .header-sub { color: #9ca3af; font-size: 11px; font-weight: 400; margin-top: 2px; }
    .red-stripe { height: 3px; background: #d11921; }
    .content { padding: 28px 32px; }
    h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; color: #111214; letter-spacing: -0.02em; }
    .meta { color: #6b7280; font-size: 11px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e2024; color: #fff; padding: 10px 14px; text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 2px solid #d11921; }
    td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 12px; color: #111214; }
    tr:nth-child(even) td { background: #f9fafb; }
    .footer { padding: 20px 32px; border-top: 1px solid #d11921; font-size: 10px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-text">T-ROCK CONSTRUCTION</div>
      <div class="header-sub">RFP Report</div>
    </div>
  </div>
  <div class="red-stripe"></div>
  <div class="content">
    <h1>RFP Report</h1>
    <p class="meta">Generated ${new Date().toLocaleString()}</p>
    <table>
      <thead>
        <tr>
          <th>Project Name</th>
          <th>Project #</th>
          <th>Recipient</th>
          <th>Date Sent</th>
          <th>Bid Board Stage</th>
          <th>Approval Status</th>
          <th># Changes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="footer">T-Rock Construction &nbsp;|&nbsp; Confidential</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format an ISO timestamp into a Central-Time date and time pair for the email. */
export function formatRfpDateTime(iso: string): { date: string; time: string } {
  if (!iso) return { date: "—", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "—", time: "" };
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return { date, time: `${time} CT` };
}

/** Build HTML email body for scheduled RFP report */
export async function buildRfpReportEmailHtml(options: {
  periodLabel: string;
  rfps: RfpReportRow[];
  changes: Array<{ rfpId: number; projectName: string; projectNumber: string; items: Array<{ field: string; oldVal: string; newVal: string; changedBy: string }> }>;
  approvalSummary: { pending: number; approved: number; rejected: number };
  includeRfpLog: boolean;
  /** @deprecated The raw change-history section was removed in the redesign; this flag is
   *  accepted for backward compatibility but ignored. `changes` is still used for the count stat. */
  includeChangeHistory?: boolean;
  includeApprovalSummary: boolean;
  dashboardUrl: string;
}): Promise<string> {
  const {
    periodLabel,
    rfps,
    changes,
    approvalSummary,
    includeRfpLog,
    includeApprovalSummary,
    dashboardUrl,
  } = options;

  const totalRfps = rfps.length;
  const totalChanges = changes.reduce((s, c) => s + c.items.length, 0);

  let sections: string[] = [];

  // Stat chips use inline-block so they sit side-by-side on desktop and wrap
  // cleanly on mobile instead of overflowing a fixed 3-column table.
  const statChip = (text: string, bg: string, color: string, accent = false) =>
    `<span style="display: inline-block; margin: 0 8px 8px 0; padding: 10px 16px; background: ${bg}; color: ${color}; border-radius: 6px; font-weight: 600; font-size: 13px;${accent ? " border-left: 3px solid #d11921;" : ""}">${text}</span>`;

  sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px 12px 32px;">
      ${statChip(`${totalRfps} RFPs Sent`, "#1e2024", "#ffffff", true)}${statChip(`${totalChanges} ${totalChanges === 1 ? "Change" : "Changes"}`, "#1e2024", "#ffffff", true)}${statChip(`${approvalSummary.pending} Pending`, "#fef3c7", "#92400e")}
    </td></tr>`);

  if (includeRfpLog) {
    // Status-aware approver value: approver email, rejection, cancellation, or pending.
    const pill = (text: string, bg: string, color: string, after = "") =>
      `<span style="display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: ${bg}; color: ${color};">${text}</span>${after}`;
    const approverValue = (r: RfpReportRow): string => {
      if (r.approvedBy) {
        return `<span style="color: #166534; font-weight: 600; word-break: break-word;">${escapeHtml(r.approvedBy)}</span>`;
      }
      // "declined" is the raw status that getRfpReportList normalizes to "rejected"; accept both
      // here so the email helper is correct even if a caller passes the un-normalized value.
      if (r.approvalStatus === "rejected" || r.approvalStatus === "declined") {
        const who = r.declinedBy
          ? ` <span style="color: #475569; word-break: break-word;">${escapeHtml(r.declinedBy)}</span>`
          : "";
        return pill("Rejected", "#fee2e2", "#991b1b", who);
      }
      if (r.approvalStatus === "pending") {
        return pill("Awaiting approval", "#fef3c7", "#92400e");
      }
      // Any other terminal/non-pending status (e.g. cancelled_source_ineligible) — show it
      // neutrally rather than implying action is still pending.
      const label = r.approvalStatus
        ? r.approvalStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "—";
      return pill(escapeHtml(label), "#e5e7eb", "#374151");
    };

    // One label/value row inside a card.
    const metaRow = (label: string, valueHtml: string) => `
              <tr>
                <td style="padding: 4px 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; width: 110px; vertical-align: top;">${label}</td>
                <td style="padding: 4px 0; font-size: 14px; color: #1e293b; vertical-align: top;">${valueHtml}</td>
              </tr>`;

    // Tappable link buttons — each rendered only when its URL exists (absolute URLs).
    const linkButton = (href: string, label: string, bg: string) =>
      `<a href="${escapeHtml(href)}" target="_blank" style="display: inline-block; margin: 0 8px 0 0; padding: 11px 20px; background: ${bg}; color: #ffffff; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 6px; white-space: nowrap;">${label}</a>`;

    const card = (r: RfpReportRow): string => {
      const { date, time } = formatRfpDateTime(r.dateSent);
      const typeBadge = r.projectType
        ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 11px; font-weight: 600; white-space: nowrap;">${escapeHtml(r.projectType)}</span>`
        : "";
      const numberLine = [escapeHtml(r.projectNumber), typeBadge].filter(Boolean).join("&nbsp;&nbsp;");

      // Re-validate at the render boundary: this function is exported, so don't assume the
      // caller already filtered the URLs to absolute http(s). The Bid Board link is additionally
      // gated to approved RFPs so a non-approved row never shows one even if a caller set the field.
      const bidBoardHref = r.approvalStatus === "approved" ? safeHttpUrl(r.bidBoardUrl) : null;
      const crmHref = safeHttpUrl(r.crmUrl);
      const buttons: string[] = [];
      if (bidBoardHref) buttons.push(linkButton(bidBoardHref, "Bid Board →", "#1e2024"));
      if (crmHref) buttons.push(linkButton(crmHref, "CRM →", "#d11921"));
      const buttonRow = buttons.length > 0
        ? `<tr><td style="padding: 14px 18px 16px 18px;">${buttons.join("")}</td></tr>`
        : "";

      return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; background: #ffffff;">
          <tr>
            <td style="padding: 16px 18px 0 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size: 16px; font-weight: 700; color: #111214; line-height: 1.3; word-break: break-word;">${escapeHtml(r.projectName)}</td>
                  <td align="right" style="font-size: 16px; font-weight: 700; color: #111214; white-space: nowrap; padding-left: 10px; vertical-align: top;">${escapeHtml(formatRfpAmount(r.amount))}</td>
                </tr>
              </table>
              <div style="margin-top: 5px; font-size: 12px; color: #6b7280;">${numberLine}</div>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 18px 4px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${metaRow("Requested by", `<span style="word-break: break-word;">${escapeHtml(r.requestedBy)}</span>`)}
                ${metaRow("Approved by", approverValue(r))}
                ${metaRow("Sent", `${escapeHtml(date)} · <span style="color: #6b7280;">${escapeHtml(time)}</span>`)}
              </table>
            </td>
          </tr>
          ${buttonRow}
        </table>`;
    };

    const body =
      rfps.length > 0
        ? `${rfps.slice(0, 30).map(card).join("")}
      ${rfps.length > 30 ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Showing 30 of ${rfps.length} RFPs. <a href="${escapeHtml(dashboardUrl)}" style="color: #d11921; text-decoration: none;">View full report</a></p>` : ""}`
        : `<p style="margin: 0; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; color: #6b7280; text-align: center;">No RFPs in this period.</p>`;

    sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px;">
      <h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 700; color: #111214; letter-spacing: -0.01em;">RFP Activity — ${escapeHtml(periodLabel)}</h3>
      ${body}
    </td></tr>`);
  }

  if (includeApprovalSummary) {
    sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px;">
      <h3 style="margin: 0 0 10px 0; font-size: 15px; font-weight: 700; color: #111214; letter-spacing: -0.01em;">Approval Summary</h3>
      ${statChip(`${approvalSummary.pending} Pending`, "#fef3c7", "#92400e")}${statChip(`${approvalSummary.approved} Approved`, "#dcfce7", "#166534")}${statChip(`${approvalSummary.rejected} Rejected`, "#fee2e2", "#991b1b")}
    </td></tr>`);
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>RFP Report — T-Rock Construction</title>
  <style>
    /* Mobile tightening — supported by Gmail/Apple Mail; ignored safely elsewhere. */
    @media only screen and (max-width: 480px) {
      .email-card { width: 100% !important; }
      .mobile-pad { padding-left: 16px !important; padding-right: 16px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: #f3f4f6;">
    <tr>
      <td style="padding: 24px 12px;">
        <table role="presentation" class="email-card" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; max-width: 600px; width: 100%; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td class="mobile-pad" style="background: #1e2024; padding: 20px 32px;">
              <span style="color: #fff; font-size: 13px; font-weight: 700; letter-spacing: 0.03em;">T-ROCK CONSTRUCTION</span>
              <div style="color: #9ca3af; font-size: 11px; margin-top: 2px;">Sync Hub</div>
            </td>
          </tr>
          <!-- Red stripe -->
          <tr>
            <td style="height: 3px; background: #d11921; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>
          <!-- Title -->
          <tr>
            <td class="mobile-pad" style="padding: 28px 32px 20px 32px;">
              <h1 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 700; color: #111214; letter-spacing: -0.02em;">RFP Report</h1>
              <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280;">${escapeHtml(periodLabel)}</p>
              <p style="margin: 0; font-size: 11px; color: #9ca3af;">${new Date().toLocaleString()}</p>
            </td>
          </tr>
          ${sections.join("")}
          <!-- Footer -->
          <tr>
            <td class="mobile-pad" style="padding: 20px 32px; border-top: 1px solid #d11921; font-size: 11px; color: #9ca3af;">
              T-Rock Construction &nbsp;|&nbsp; <a href="${escapeHtml(dashboardUrl)}" style="color: #d11921; text-decoration: none;">Open Dashboard</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Get RFPs and change data for a time period */
async function getRfpsForPeriod(
  dateFrom: Date,
  dateTo: Date
): Promise<{ rfps: RfpReportRow[]; changes: Array<{ rfpId: number; projectName: string; projectNumber: string; items: Array<{ field: string; oldVal: string; newVal: string; changedBy: string }> }>; approvalSummary: { pending: number; approved: number; rejected: number } }> {
  const { data: rfps } = await getRfpReportList({
    dateFrom: dateFrom.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10),
    limit: 500,
    page: 1,
  });

  const rfpIds = rfps.map((r) => r.id);
  const changeLogs =
    rfpIds.length > 0
      ? await db
          .select()
          .from(rfpChangeLog)
          .where(
            and(
              inArray(rfpChangeLog.rfpId, rfpIds),
              gte(rfpChangeLog.changedAt, dateFrom),
              lte(rfpChangeLog.changedAt, dateTo)
            )
          )
          .orderBy(desc(rfpChangeLog.changedAt))
      : [];

  const changesByRfp = new Map<
    number,
    Array<{ field: string; oldVal: string; newVal: string; changedBy: string }>
  >();
  const rfpById = new Map(rfps.map((r) => [r.id, r]));

  for (const c of changeLogs) {
    if (!changesByRfp.has(c.rfpId)) changesByRfp.set(c.rfpId, []);
    changesByRfp.get(c.rfpId)!.push({
      field: c.fieldChanged,
      oldVal: c.oldValue ?? "",
      newVal: c.newValue,
      changedBy: c.changedBy ?? "system",
    });
  }

  const changes = Array.from(changesByRfp.entries()).map(([rfpId, items]) => {
    const r = rfpById.get(rfpId);
    return {
      rfpId,
      projectName: r?.projectName ?? "—",
      projectNumber: r?.projectNumber ?? "—",
      items,
    };
  });

  const approvalSummary = {
    pending: rfps.filter((r) => r.approvalStatus === "pending").length,
    approved: rfps.filter((r) => r.approvalStatus === "approved").length,
    rejected: rfps.filter((r) => r.approvalStatus === "rejected").length,
  };

  return { rfps, changes, approvalSummary };
}

/** Send scheduled RFP report email */
export async function sendScheduledRfpReport(
  config?: { recipients?: string[]; includeRfpLog?: boolean; includeApprovalSummary?: boolean }
): Promise<{ sent: number; failed: number }> {
  const cfg = await storage.getReportScheduleConfig();
  if (!cfg?.enabled || !cfg.recipients?.length) {
    return { sent: 0, failed: 0 };
  }

  const now = new Date();
  let dateFrom: Date;
  const dateTo: Date = now;
  let periodLabel: string;

  switch (cfg.frequency) {
    case "daily":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 1);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 24 Hours";
      break;
    case "weekly":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 7);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 7 Days";
      break;
    case "biweekly":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 14);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 14 Days";
      break;
    case "monthly":
      dateFrom = new Date(now);
      dateFrom.setMonth(dateFrom.getMonth() - 1);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 30 Days";
      break;
    default:
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 7);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 7 Days";
  }

  const { rfps, changes, approvalSummary } = await getRfpsForPeriod(
    dateFrom,
    dateTo
  );

  const dashboardUrl = process.env.APP_URL || "http://localhost:5000";

  const html = await buildRfpReportEmailHtml({
    periodLabel,
    rfps,
    changes,
    approvalSummary,
    includeRfpLog: config?.includeRfpLog ?? cfg.includeRfpLog,
    includeApprovalSummary:
      config?.includeApprovalSummary ?? cfg.includeApprovalSummary,
    dashboardUrl: `${dashboardUrl}/settings`,
  });

  const recipients = config?.recipients?.length ? config.recipients : cfg.recipients;
  let sent = 0,
    failed = 0;

  for (const to of recipients) {
    try {
      const result = await sendEmail({
        to,
        subject: `T-Rock RFP Report — ${periodLabel}`,
        htmlBody: html,
        fromName: "T-Rock Sync Hub",
      });
      if (result.success) sent++;
      else failed++;
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}

/** Send a one-off test email to a specific address using current config */
export async function sendTestRfpReportEmail(to: string): Promise<{ success: boolean; error?: string }> {
  const cfg = await storage.getReportScheduleConfig();
  const now = new Date();
  const dateFrom = new Date(now);
  dateFrom.setDate(dateFrom.getDate() - 7);
  dateFrom.setHours(0, 0, 0, 0);

  const { rfps, changes, approvalSummary } = await getRfpsForPeriod(dateFrom, now);
  const dashboardUrl = process.env.APP_URL || "http://localhost:5000";

  const html = await buildRfpReportEmailHtml({
    periodLabel: "Test Report (Last 7 Days)",
    rfps,
    changes,
    approvalSummary,
    includeRfpLog: cfg?.includeRfpLog ?? true,
    includeApprovalSummary: cfg?.includeApprovalSummary ?? true,
    dashboardUrl: `${dashboardUrl}/settings`,
  });

  const result = await sendEmail({
    to,
    subject: "T-Rock RFP Report — Test",
    htmlBody: html,
    fromName: "T-Rock Sync Hub",
  });

  return result.success ? { success: true } : { success: false, error: result.error };
}
