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
import type { Request, Response } from "express";

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
  recipient: string;
  dateSent: string;
  bidboardStage: string;
  approvalStatus: string;
  changeCount: number;
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
    conditions.push(
      sql`(
        COALESCE(${rfpApprovalRequests.dealData}->>'project_number', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'dealname', '') ILIKE ${pnPattern}
        OR COALESCE(${rfpApprovalRequests.dealData}->>'project_name', '') ILIKE ${pnPattern}
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

  const dealIds = [...new Set(rfps.map((r) => r.hubspotDealId))].filter(Boolean);
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
    const projectName = String(dealData.dealname || dealData.project_name || "—");
    const projectNumber = String(dealData.project_number || "—");
    const recipient = String(dealData.ownerEmail || dealData.ownerName || "—");
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
      hubspotDealId: rfp.hubspotDealId,
      projectName,
      projectNumber,
      recipient,
      dateSent: rfp.createdAt ? new Date(rfp.createdAt).toISOString() : "",
      bidboardStage,
      approvalStatus,
      changeCount,
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
  <title>RFP Report - SyncHub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; color: #1a1a2e; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .meta { color: #64748b; font-size: 12px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; font-size: 12px; }
  </style>
</head>
<body>
  <h1>RFP Report</h1>
  <p class="meta">Generated by SyncHub on ${new Date().toLocaleString()}</p>
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

/** Build HTML email body for scheduled RFP report */
export async function buildRfpReportEmailHtml(options: {
  periodLabel: string;
  rfps: RfpReportRow[];
  changes: Array<{ rfpId: number; projectName: string; projectNumber: string; items: Array<{ field: string; oldVal: string; newVal: string; changedBy: string }> }>;
  approvalSummary: { pending: number; approved: number; rejected: number };
  includeRfpLog: boolean;
  includeChangeHistory: boolean;
  includeApprovalSummary: boolean;
  dashboardUrl: string;
}): Promise<string> {
  const {
    periodLabel,
    rfps,
    changes,
    approvalSummary,
    includeRfpLog,
    includeChangeHistory,
    includeApprovalSummary,
    dashboardUrl,
  } = options;

  const totalRfps = rfps.length;
  const totalChanges = changes.reduce((s, c) => s + c.items.length, 0);

  let sections: string[] = [];

  sections.push(`
    <tr><td style="padding: 20px 24px; background: #f8fafc; border-radius: 8px; margin-bottom: 16px;">
      <table cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 8px 16px; background: #1a1a2e; color: #fff; border-radius: 6px; text-align: center; font-weight: 600;">
            ${totalRfps} RFPs Sent
          </td>
          <td width="16"></td>
          <td style="padding: 8px 16px; background: #1a1a2e; color: #fff; border-radius: 6px; text-align: center; font-weight: 600;">
            ${totalChanges} Changes
          </td>
          <td width="16"></td>
          <td style="padding: 8px 16px; background: #f59e0b; color: #fff; border-radius: 6px; text-align: center; font-weight: 600;">
            ${approvalSummary.pending} Pending
          </td>
        </tr>
      </table>
    </td></tr>`);

  if (includeRfpLog && rfps.length > 0) {
    const rows = rfps
      .slice(0, 30)
      .map(
        (r) => `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(r.projectName)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(r.projectNumber)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(r.recipient)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;">${r.dateSent ? new Date(r.dateSent).toLocaleDateString() : ""}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0;"><span style="padding: 2px 8px; border-radius: 999px; font-size: 11px; ${r.approvalStatus === "approved" ? "background: #dcfce7; color: #166534;" : r.approvalStatus === "rejected" ? "background: #fee2e2; color: #991b1b;" : "background: #fef3c7; color: #92400e;"}">${escapeHtml(r.approvalStatus)}</span></td>
        </tr>`
      )
      .join("");
    sections.push(`
    <tr><td style="padding: 20px 24px;">
      <h3 style="margin: 0 0 12px 0; font-size: 16px;">RFP Send Log — ${periodLabel}</h3>
      <table cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 10px 12px; text-align: left; font-size: 12px;">Project Name</th>
            <th style="padding: 10px 12px; text-align: left; font-size: 12px;">Project #</th>
            <th style="padding: 10px 12px; text-align: left; font-size: 12px;">Recipient</th>
            <th style="padding: 10px 12px; text-align: left; font-size: 12px;">Date</th>
            <th style="padding: 10px 12px; text-align: left; font-size: 12px;">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${rfps.length > 30 ? `<p style="margin: 8px 0 0 0; font-size: 12px; color: #64748b;">Showing 30 of ${rfps.length} RFPs. <a href="${dashboardUrl}" style="color: #d11921;">View full report</a></p>` : ""}
    </td></tr>`);
  }

  if (includeChangeHistory && changes.length > 0) {
    const changeBlocks = changes
      .slice(0, 10)
      .map(
        (c) => `
        <div style="margin-bottom: 12px; padding: 12px; background: #f8fafc; border-radius: 6px; border-left: 4px solid #3b82f6;">
          <strong>${escapeHtml(c.projectName)}</strong> (${escapeHtml(c.projectNumber)})
          ${c.items
            .slice(0, 5)
            .map(
              (i) => `
          <div style="font-size: 12px; margin-top: 6px; color: #475569;">
            <span style="color: #64748b;">${escapeHtml(i.field)}</span>:
            <del style="color: #dc2626;">${escapeHtml(String(i.oldVal || "").slice(0, 50))}</del> → <ins style="color: #16a34a;">${escapeHtml(String(i.newVal || "").slice(0, 50))}</ins>
            <span style="color: #94a3b8;">— ${escapeHtml(i.changedBy || "system")}</span>
          </div>`
            )
            .join("")}
        </div>`
      )
      .join("");
    sections.push(`
    <tr><td style="padding: 20px 24px;">
      <h3 style="margin: 0 0 12px 0; font-size: 16px;">Change Highlights</h3>
      ${changeBlocks}
    </td></tr>`);
  }

  if (includeApprovalSummary) {
    sections.push(`
    <tr><td style="padding: 20px 24px;">
      <h3 style="margin: 0 0 12px 0; font-size: 16px;">Approval Summary</h3>
      <table cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding: 8px 16px; background: #fef3c7; color: #92400e; border-radius: 6px; font-weight: 600;">${approvalSummary.pending} Pending</td>
          <td width="12"></td>
          <td style="padding: 8px 16px; background: #dcfce7; color: #166534; border-radius: 6px; font-weight: 600;">${approvalSummary.approved} Approved</td>
          <td width="12"></td>
          <td style="padding: 8px 16px; background: #fee2e2; color: #991b1b; border-radius: 6px; font-weight: 600;">${approvalSummary.rejected} Rejected</td>
        </tr>
      </table>
    </td></tr>`);
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RFP Report — SyncHub</title>
</head>
<body style="margin: 0; padding: 0; background: #f4f4f5; font-family: Arial, Helvetica, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: #f4f4f5;">
    <tr>
      <td style="padding: 32px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; max-width: 600px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
              <span style="color: #fff; font-size: 20px; font-weight: 700;">SyncHub</span>
              <div style="height: 4px; background: linear-gradient(90deg, #d11921, #e53935); margin-top: 12px;"></div>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 32px;">
              <h1 style="margin: 0 0 8px 0; font-size: 18px; color: #1a1a2e;">RFP Report — ${escapeHtml(periodLabel)}</h1>
              <p style="margin: 0 0 20px 0; font-size: 13px; color: #64748b;">${new Date().toLocaleString()}</p>
            </td>
          </tr>
          ${sections.join("")}
          <tr>
            <td style="padding: 24px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
              This report was generated by SyncHub. <a href="${dashboardUrl}" style="color: #d11921; text-decoration: none;">Open Dashboard</a>
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
  config?: { recipients?: string[]; includeRfpLog?: boolean; includeChangeHistory?: boolean; includeApprovalSummary?: boolean }
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
    includeChangeHistory: config?.includeChangeHistory ?? cfg.includeChangeHistory,
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
        subject: `SyncHub RFP Report — ${periodLabel}`,
        htmlBody: html,
        fromName: "SyncHub",
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
    includeChangeHistory: cfg?.includeChangeHistory ?? true,
    includeApprovalSummary: cfg?.includeApprovalSummary ?? true,
    dashboardUrl: `${dashboardUrl}/settings`,
  });

  const result = await sendEmail({
    to,
    subject: "SyncHub RFP Report — Test",
    htmlBody: html,
    fromName: "SyncHub",
  });

  return result.success ? { success: true } : { success: false, error: result.error };
}
