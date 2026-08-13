/**
 * RFP Reports API & Scheduled Email Engine
 * =========================================
 * Handles RFP reporting, change history, approval chain, export, and scheduled emails.
 */

import { eq, desc, and, gte, lte, sql, inArray } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { isOccurrenceDay, localOccurrenceDate, resolveScheduledSend } from "./cron/report-cadence";
import {
  rfpApprovalRequests,
  rfpChangeLog,
  rfpApprovals,
  reportScheduleConfig,
  syncMappings,
} from "@shared/schema";
import { sendEmail, type EmailAttachment } from "./email-service";
import { buildEstimatesSentPdf, estimatesSentPdfFilename } from "./estimates-sent-pdf";
import {
  fetchCrmEstimatesSent,
  formatEstimateAmount,
  resendLabel,
  MAX_ESTIMATES_SENT_ROWS,
  type CrmEstimatesSentResult,
} from "./crm-estimates-sent";
import { fetchCrmCurrentDealAmounts } from "./crm-deal-values";
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

/**
 * Fills in a CURRENT deal value for the rows whose send-time snapshot is blank.
 *
 * ~78% of report rows render "—" (252 of 325 over 90 days) and almost none of them are missing data:
 * the RFP goes out before the estimator writes the estimate, so SyncHub correctly stored nothing.
 * Rather than leave those rows valueless, ask the CRM what each deal is worth now.
 *
 * Rules this MUST preserve:
 *  - a reviewer's `edited_fields.amount` wins — resolveRfpAmount already applied it, and a row that
 *    carries a reviewer value is not null, so it never reaches the lookup at all;
 *  - a stored snapshot that has a value is never replaced — only nulls are filled;
 *  - the stored snapshot itself is not rewritten (display-time only);
 *  - ONE batch call for the whole report, and on any failure every row keeps its em-dash.
 *
 * A note on the reviewer case, because it was got wrong once. An earlier revision also skipped rows
 * whose `edited_fields` merely CARRIED an `amount` key, on the theory that a reviewer who cleared the
 * field to "" meant it. That guard is gone: it cannot tell a deliberate clear from the approval
 * form's own echo (processRfpApproval diffs every posted field against dealData with `!==`, so it
 * writes keys for type mismatches nobody typed), and it fails CLOSED — a false positive silently
 * suppresses exactly the backfill this function exists to perform. A blank is not a value; filling it
 * with a labelled current figure takes nothing away from the reviewer.
 *
 * Mutates `rows` in place and returns it.
 */
export async function resolveMissingAmountsFromCrm(
  rows: RfpReportRow[],
  options: {
    /** Injected in tests. */
    fetchAmounts?: typeof fetchCrmCurrentDealAmounts;
  } = {}
): Promise<RfpReportRow[]> {
  const fetchAmounts = options.fetchAmounts ?? fetchCrmCurrentDealAmounts;

  const needing = rows.filter(
    (row) => row.amount === null && row.sourceSystem === "trock_crm" && Boolean(row.sourceDealId)
  );
  if (needing.length === 0) return rows;

  // fetchCrmCurrentDealAmounts already swallows every failure it can name, but this runs on the
  // scheduled-email path: a lookup must not be able to stop the report going out, not even via a
  // failure mode nobody anticipated. Rows keep their em-dash and the email sends.
  // fetchCrmCurrentDealAmounts lower-cases every key it returns, so the READ below lower-cases too
  // and the two always meet. The request goes out with the id exactly as stored.
  let amounts: Map<string, number>;
  try {
    amounts = await fetchAmounts([...new Set(needing.map((row) => row.sourceDealId))]);
  } catch {
    return rows;
  }
  if (amounts.size === 0) return rows;

  for (const row of needing) {
    const current = amounts.get(row.sourceDealId.toLowerCase());
    if (current === undefined) continue;
    row.amount = current;
    row.amountIsCurrent = true;
  }
  return rows;
}

/**
 * How many detail cards the whole email may render, across BOTH sections.
 *
 * Gmail clips an HTML message at roughly 102 KB and this service sends through Gmail. A 30-card RFP
 * section is already about 98 KB; adding an independent 30 estimate cards took a measured build to about
 * 155 KB, so the busiest reports — precisely the ones worth reading — lost most of the estimates section,
 * the approval summary and the footer behind a "[Message clipped]" link.
 *
 * A SHARED budget rather than two independent ceilings, because the sections are not independent: it is
 * the SUM that gets clipped. Set to 30 — the ceiling the RFP section already had — so an email with no
 * estimates section renders exactly as it does today, and only the combined overflow is new.
 */
export const EMAIL_CARD_BUDGET = 30;

/**
 * Split the budget between the two sections.
 *
 * Each is guaranteed its half when it can fill it, and whatever the other does not need flows across —
 * so a quiet RFP day still shows more estimates rather than wasting the headroom, and neither section can
 * starve the other. Both sections state their own total, so a trimmed list is never mistaken for a
 * complete one.
 */
export function shareCardBudget(
  rfpCount: number,
  estimateCount: number,
  budget = EMAIL_CARD_BUDGET
): { rfp: number; estimates: number } {
  const half = Math.floor(budget / 2);
  let rfp = Math.min(rfpCount, half);
  let estimates = Math.min(estimateCount, half);

  let spare = budget - rfp - estimates;
  if (spare > 0) {
    const rfpExtra = Math.min(spare, rfpCount - rfp);
    rfp += rfpExtra;
    spare -= rfpExtra;
    estimates += Math.min(spare, estimateCount - estimates);
  }
  return { rfp, estimates };
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
  /** 'hubspot' | 'trock_crm' — which system the deal lives in. */
  sourceSystem: string;
  /** The deal id in `sourceSystem`. For trock_crm this is the CRM deal UUID. */
  sourceDealId: string;
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
  /**
   * True when `amount` is the deal's value AS OF NOW, looked up live from the CRM, rather than the
   * value captured when the RFP was sent. Rows are marked so the email can say which it is — a
   * present-tense number inside a report headed "Last 24 Hours" otherwise reads as "value at
   * request", which it is not. See resolveMissingAmountsFromCrm.
   */
  amountIsCurrent: boolean;
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

/**
 * Get paginated RFP list with filters.
 *
 * `resolveCurrentAmounts` opts into the live CRM backfill for blank amounts (see
 * resolveMissingAmountsFromCrm). It is OFF by default and on only for the scheduled email, which is
 * the sole surface that renders an amount — the dashboard table shows
 * project/recipient/date/stage/status/changes, and the CSV and PDF exports use those same columns.
 * Turning it on everywhere would make browsing and downloading the report wait on a live cross-service
 * call for a number those paths throw away. Any surface that starts rendering `amount` should pass
 * this flag rather than quietly diverge from the email.
 */
export async function getRfpReportList(
  filters: RfpReportFilters,
  options: { resolveCurrentAmounts?: boolean } = {}
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
      sourceSystem: rfp.sourceSystem ?? "hubspot",
      sourceDealId: rfp.sourceDealId ?? "",
      projectName,
      projectNumber,
      projectType,
      recipient,
      dateSent: rfp.createdAt ? new Date(rfp.createdAt).toISOString() : "",
      bidboardStage,
      approvalStatus,
      changeCount,
      amount,
      // Flipped by resolveMissingAmountsFromCrm below when a blank snapshot is backfilled live.
      amountIsCurrent: false,
      requestedBy,
      approvedBy,
      declinedBy,
      bidBoardUrl,
      crmUrl,
    };
  });

  // ONE batch call for the whole page, after the rows exist — never inside the map above.
  if (options.resolveCurrentAmounts) await resolveMissingAmountsFromCrm(data);

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
  /** Read so the preview can see an occurrence the scheduler still owes — see the catch-up branch below. */
  lastSentAt?: Date | string | null;
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

  // An OUTSTANDING occurrence is the next run, and saying otherwise misinforms the person reading it. The
  // scheduler catches up on any tick past the scheduled time that has not already sent, so after a missed
  // tick this preview would scan forward and answer "tomorrow" — moments before a catch-up email arrives.
  // Asked of the same function the scheduler uses, so the two cannot drift apart.
  const lastSent = config.lastSentAt ? new Date(config.lastSentAt) : null;
  const outstanding = resolveScheduledSend({
    now,
    lastSentAt: lastSent && !Number.isNaN(lastSent.getTime()) ? lastSent : null,
    frequency: freq,
    dayOfWeek: config.dayOfWeek ?? null,
    timeOfDay: timeStr,
    timezone: tz,
  });
  if (outstanding.send) {
    // Composed from the OUTCOME, never from `reason`. That string is an unlocalised log line carrying
    // diagnostics like "(65 min after 08:00)" — showing it to an admin makes the UI change whenever the
    // cadence module rewords a log.
    const lead = outstanding.outcome === "catch-up" ? "Overdue — sending shortly" : "Due now";
    return `${lead} (${tzLabel}) to ${recipientCount} recipient${recipientCount !== 1 ? "s" : ""}`;
  }
  // Today is SPENT once a send is recorded against this local date, and the forward scan below cannot see
  // that — it only matches slots. Without this, moving the time later on a day that already sent (sent at
  // 08:00, changed to 10:00 at 09:00) previewed today's 10:00 run, which the scheduler will suppress
  // because the date is already marked. The preview would have promised a run that cannot happen.
  const alreadySentToday =
    lastSent && !Number.isNaN(lastSent.getTime())
      ? localOccurrenceDate(lastSent, tz) === localOccurrenceDate(now, tz)
      : false;

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

    // WHICH DAYS the schedule fires on is the sender's question, so it is asked of the sender's own
    // predicate rather than reimplemented here. Two copies disagreed twice — on biweekly eligibility, then
    // on the parity anchor — each time because a fix landed on one of them. The slot check above stays
    // local, because that is this preview's own concern: finding the candidate instant to display.
    return isOccurrenceDay({
      instant: d,
      frequency: freq,
      dayOfWeek: config.dayOfWeek ?? null,
      timeOfDay: timeStr,
      timezone: tz,
    });
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
    if (alreadySentToday && localOccurrenceDate(candidate, tz) === localOccurrenceDate(now, tz)) continue;
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
  /** The span the estimates lookup actually asked for, so the section can caption itself honestly. */
  estimatesPeriod?: { from: Date; to: Date };
  /**
   * The estimates that went out to CLIENTS in the same window, from the CRM.
   *
   * A RESULT, not a list, so the email can tell a quiet day from a broken lookup. Omitted entirely by
   * callers that do not fetch it (the CSV/PDF exports), which is different again from either.
   */
  estimatesSent?: CrmEstimatesSentResult;
  /**
   * Filename of the attached full-list PDF, or null when there is none.
   *
   * Passed in rather than inferred, and the caller sets it only AFTER the PDF is actually built: the
   * overflow note tells the reader where the rest of the list is, and a body promising an attachment
   * that failed to generate is worse than one that never mentioned it.
   */
  estimatesPdfFilename?: string | null;
  dashboardUrl: string;
}): Promise<string> {
  const {
    periodLabel,
    rfps,
    changes,
    approvalSummary,
    includeRfpLog,
    includeApprovalSummary,
    estimatesSent,
    estimatesPeriod,
    estimatesPdfFilename,
    dashboardUrl,
  } = options;

  const totalRfps = rfps.length;
  const totalChanges = changes.reduce((s, c) => s + c.items.length, 0);

  // ONE budget across both card sections — it is their SUM that Gmail clips.
  //
  // A section that will NOT render contributes nothing: with includeRfpLog off no RFP cards exist, and
  // counting them anyway reserved half the budget for an invisible section, so a busy estimates list was
  // trimmed to 15 while all 30 slots were free.
  const cardBudget = shareCardBudget(
    includeRfpLog ? rfps.length : 0,
    estimatesSent?.ok === true ? estimatesSent.deals.length : 0
  );

  let sections: string[] = [];

  // Stat chips use inline-block so they sit side-by-side on desktop and wrap
  // cleanly on mobile instead of overflowing a fixed 3-column table.
  const statChip = (text: string, bg: string, color: string, accent = false) =>
    `<span style="display: inline-block; margin: 0 8px 8px 0; padding: 10px 16px; background: ${bg}; color: ${color}; border-radius: 6px; font-weight: 600; font-size: 13px;${accent ? " border-left: 3px solid #d11921;" : ""}">${text}</span>`;

  // The estimates chip appears only when the lookup SUCCEEDED. A chip reading "0 Estimates Sent" after a
  // failed call would be a confidently wrong number in an email to leadership; the section below says
  // plainly that it could not be loaded instead.
  const estimatesChip =
    estimatesSent?.ok === true
      ? statChip(
          // The PRE-CAP total, so the ceiling never turns into an exact-looking figure for a period that
          // held more.
          `${estimatesSent.total} ${estimatesSent.total === 1 ? "Estimate" : "Estimates"} Sent`,
          "#1e2024",
          "#ffffff",
          true
        )
      : "";

  sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px 12px 32px;">
      ${statChip(`${totalRfps} RFPs Sent`, "#1e2024", "#ffffff", true)}${estimatesChip}${statChip(`${totalChanges} ${totalChanges === 1 ? "Change" : "Changes"}`, "#1e2024", "#ffffff", true)}${statChip(`${approvalSummary.pending} Pending`, "#fef3c7", "#92400e")}
    </td></tr>`);

  // ONE label/value row helper for every card in this email. It was defined identically in the RFP
  // branch and again in the estimates branch; two copies in one function drift the moment the card
  // styling changes.
  const metaRow = (label: string, valueHtml: string) => `
              <tr>
                <td style="padding: 4px 0; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; width: 110px; vertical-align: top;">${label}</td>
                <td style="padding: 4px 0; font-size: 14px; color: #1e293b; vertical-align: top;">${valueHtml}</td>
              </tr>`;

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


    // Tappable link buttons — each rendered only when its URL exists (absolute URLs).
    const linkButton = (href: string, label: string, bg: string) =>
      `<a href="${escapeHtml(href)}" target="_blank" style="display: inline-block; margin: 0 8px 0 0; padding: 11px 20px; background: ${bg}; color: #ffffff; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 6px; white-space: nowrap;">${label}</a>`;

    // Amounts are normally the value captured when the RFP was SENT. A row whose snapshot was blank
    // carries the deal's value AS OF NOW instead, and those two are not the same claim — inside a
    // report headed "Last 24 Hours" an unmarked number reads as "value at request". Mark it.
    const amountCell = (r: RfpReportRow): string => {
      const text = escapeHtml(formatRfpAmount(r.amount));
      if (!r.amountIsCurrent || r.amount === null) return text;
      return `${text}<span style="font-size: 11px; font-weight: 600; color: #6b7280;">&nbsp;&dagger;</span>`;
    };

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
                  <td align="right" style="font-size: 16px; font-weight: 700; color: #111214; white-space: nowrap; padding-left: 10px; vertical-align: top;">${amountCell(r)}</td>
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

    const shown = rfps.slice(0, cardBudget.rfp);
    // Only footnote the marker if a marker was actually rendered.
    const currentAmountNote = shown.some((r) => r.amountIsCurrent && r.amount !== null)
      ? `<p style="margin: 10px 0 0 0; font-size: 12px; color: #6b7280;">&dagger; Deal value as of today — no estimate existed when the RFP was sent.</p>`
      : "";

    const body =
      rfps.length > 0
        ? `${shown.map(card).join("")}
      ${rfps.length > cardBudget.rfp ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Showing ${cardBudget.rfp} of ${rfps.length} RFPs. <a href="${escapeHtml(dashboardUrl)}" style="color: #d11921; text-decoration: none;">View full report</a></p>` : ""}${currentAmountNote}`
        : `<p style="margin: 0; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; color: #6b7280; text-align: center;">No RFPs in this period.</p>`;

    sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px;">
      <h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 700; color: #111214; letter-spacing: -0.01em;">RFP Activity — ${escapeHtml(periodLabel)}</h3>
      ${body}
    </td></tr>`);
  }

  // Estimates sent to CLIENTS — the other half of "what went out today", and the half SyncHub cannot
  // see on its own. Rendered whenever the caller supplied a result, including a failed one: silence
  // here would read as "nothing was sent", which is a false claim rather than a missing one.
  if (estimatesSent) {
    // The section states ITS OWN span, not the report's cadence label. After a pause or an outage the
    // estimates window is the whole catch-up interval, so a heading reading "Last 7 Days" over a
    // three-week count is simply a false caption.
    // Captioned with what was actually COVERED, which after an oldest-first catch-up stops short of the
    // period end. Naming the requested end would caption the section with a stretch it never queried.
    const estimatesPeriodLabel = estimatesCoverageLabel(estimatesSent, estimatesPeriod, periodLabel);
    const sectionHeading = `<h3 style="margin: 0 0 14px 0; font-size: 15px; font-weight: 700; color: #111214; letter-spacing: -0.01em;">Estimates Sent to Client — ${escapeHtml(estimatesPeriodLabel)}</h3>`;

    let body: string;
    if (!estimatesSent.ok) {
      // Says which of the two it is. "Not configured" is a deployment that never wired the CRM up and
      // is not news; a genuine failure is. Both state plainly that the number is UNKNOWN rather than
      // letting an absent section imply zero.
      const message =
        estimatesSent.reason === "not_configured"
          ? "Not available — this Sync Hub is not connected to the CRM."
          : "Could not be loaded from the CRM this run. The figure above covers RFPs only.";
      body = `<p style="margin: 0; padding: 16px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; font-size: 14px; color: #92400e;">${escapeHtml(message)}</p>`;
    } else if (estimatesSent.deals.length === 0) {
      // A zero from a PARTIALLY covered interval is not a whole-period zero. Without the reach note the
      // reader is told nothing went out over a span the report never actually queried.
      // The gap is at the NEWER end now. Oldest-first batching always starts exactly where it was asked
      // to, so coveredFrom can no longer reveal a shortfall — coveredThrough is what does.
      const emptyReach =
        estimatesPeriod && Date.parse(estimatesSent.coveredThrough) < estimatesPeriod.to.getTime()
          ? `<p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">Only estimates sent up to ${escapeHtml(
              formatRfpDateTime(estimatesSent.coveredThrough).date
            )} were checked — later ones in this interval were not, and will be covered by the next report.</p>`
          : "";
      body = `<p style="margin: 0; padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 14px; color: #6b7280; text-align: center;">No estimates sent to clients in this period.</p>${emptyReach}`;
    } else {
      const estimateCard = (deal: (typeof estimatesSent.deals)[number]): string => {
        const { date, time } = formatRfpDateTime(deal.enteredAt);
        const resend = resendLabel(deal.priorEntryCount);
        // Only on a re-send. A badge on every card would be noise; this one carries information
        // precisely because it is the exception — a revised estimate is not new business.
        const resendBadge = resend
          ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 600; white-space: nowrap;">${escapeHtml(resend)}</span>`
          : "";
        const identifier = deal.projectNumber || deal.dealNumber || "";
        const numberLine = [escapeHtml(identifier), resendBadge].filter(Boolean).join("&nbsp;&nbsp;");
        const owner = deal.ownerName || deal.ownerEmail || "—";

        return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; background: #ffffff;">
          <tr>
            <td style="padding: 16px 18px 0 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-size: 16px; font-weight: 700; color: #111214; line-height: 1.3; word-break: break-word;">${escapeHtml(deal.name || "(untitled deal)")}</td>
                  <td align="right" style="font-size: 16px; font-weight: 700; color: #111214; white-space: nowrap; padding-left: 10px; vertical-align: top;">${escapeHtml(formatEstimateAmount(deal.amount))}</td>
                </tr>
              </table>
              ${numberLine ? `<div style="margin-top: 5px; font-size: 12px; color: #6b7280;">${numberLine}</div>` : ""}
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 18px 16px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                ${metaRow("Owner", `<span style="word-break: break-word;">${escapeHtml(owner)}</span>`)}
                ${metaRow("Sent", `${escapeHtml(date)} · <span style="color: #6b7280;">${escapeHtml(time)}</span>`)}
              </table>
            </td>
          </tr>
        </table>`;
      };

      // Same 30-card ceiling as the RFP list, and the same honesty about it: the total is stated, so a
      // truncated list never reads as the whole picture.
      const shown = estimatesSent.deals.slice(0, cardBudget.estimates);
      // Stated against the TRUE total, not the capped list, so the "of N" is the real N.
      //
      // When the full list rode along as a PDF the note SAYS SO — the cap is what made the section look
      // like the whole picture when it was not, and naming the attachment is what turns a dead end into
      // somewhere to go. Conditional on the file having actually been produced, never on the intent to
      // produce one.
      const overflow =
        estimatesSent.total > cardBudget.estimates
          ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Showing ${cardBudget.estimates} of ${estimatesSent.total} estimates sent.</p>`
          : "";
      // Its OWN note, rendered whenever the file exists rather than only when the list was trimmed.
      // An attachment that appears silently on busy days and vanishes on quiet ones reads as a glitch;
      // the body should always account for what is clipped to the message. Conditional on the PDF having
      // been BUILT — see estimatesPdfFilename — so a failed generation never leaves a false promise.
      // "Full list" ONLY when the attachment really is one. The endpoint caps its rows at
      // MAX_ESTIMATES_SENT_ROWS while still reporting the true total, so past that the PDF holds the
      // newest N and saying otherwise would be a false claim printed next to an accurate count.
      const attachedCount = estimatesSent.deals.length;
      const attachmentNote = estimatesPdfFilename
        ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">${
            estimatesSent.total > attachedCount
              ? `Most recent ${attachedCount} of ${estimatesSent.total} attached as`
              : `Full list of ${estimatesSent.total} attached as`
          } <strong>${escapeHtml(estimatesPdfFilename)}</strong>.</p>`
        : "";
      // Only about the LIST. The count above is exact; what the cap limits is how many rows were carried
      // back, which matters only if someone expected to scroll all of them.
      const capNote =
        estimatesSent.total > MAX_ESTIMATES_SENT_ROWS
          ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Only the ${MAX_ESTIMATES_SENT_ROWS} most recent are listed.</p>`
          : "";
      // What this run covered. After a long gap the batching works forward from the checkpoint and stops
      // short of now, so the note names the end it reached and says the rest is coming.
      const reachNote =
        estimatesPeriod && Date.parse(estimatesSent.coveredThrough) < estimatesPeriod.to.getTime()
          ? `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Covering estimates sent up to ${escapeHtml(
              formatRfpDateTime(estimatesSent.coveredThrough).date
            )} — the remainder of this catch-up follows in the next report.</p>`
          : `<p style="margin: 4px 0 0 0; font-size: 12px; color: #6b7280;">Covering estimates sent since ${escapeHtml(
              formatRfpDateTime(estimatesSent.coveredFrom).date
            )}.</p>`;
      body = `${shown.map(estimateCard).join("")}${overflow}${attachmentNote}${capNote}${reachNote}`;
    }

    sections.push(`
    <tr><td class="mobile-pad" style="padding: 20px 32px;">
      ${sectionHeading}
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
  <title>RFP &amp; Estimates Sent to Client — T-Rock Construction</title>
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
              <h1 style="margin: 0 0 6px 0; font-size: 20px; font-weight: 700; color: #111214; letter-spacing: -0.02em;">RFP &amp; Estimates Sent to Client</h1>
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
  dateTo: Date,
  /**
   * Whether the email will actually render the RFP cards. Amounts appear ONLY inside those cards,
   * so with the log switched off a report of stat chips and an approval summary would otherwise
   * wait on the CRM — up to the full timeout, on a slow or unreachable one — for numbers it is
   * never going to print.
   */
  includeRfpLog: boolean
): Promise<{ rfps: RfpReportRow[]; changes: Array<{ rfpId: number; projectName: string; projectNumber: string; items: Array<{ field: string; oldVal: string; newVal: string; changedBy: string }> }>; approvalSummary: { pending: number; approved: number; rejected: number } }> {
  // The email is the ONE surface that renders an amount, so it is the one that opts into the live
  // CRM backfill for blank snapshots. See getRfpReportList.
  const { data: rfps } = await getRfpReportList(
    {
      dateFrom: dateFrom.toISOString().slice(0, 10),
      dateTo: dateTo.toISOString().slice(0, 10),
      limit: 500,
      page: 1,
    },
    { resolveCurrentAmounts: includeRfpLog }
  );

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

/**
 * The span the estimates actually cover, as both the section heading and the PDF caption print it.
 *
 * ONE definition for both surfaces. The cadence label ("Last 24 Hours") is only right when the lookup
 * covered exactly one cadence: after a pause or an outage the estimates window is the whole catch-up
 * interval, so captioning weeks of rows "Last 24 Hours" is a false statement, not a rounding. The email
 * already derived the real range; the attachment was handed the cadence label and printed it verbatim.
 */
export function estimatesCoverageLabel(
  estimatesSent: CrmEstimatesSentResult | undefined,
  estimatesPeriod: { from: Date; to: Date } | undefined,
  fallback: string
): string {
  if (!estimatesSent?.ok || !estimatesPeriod) return fallback;
  return `${formatRfpDateTime(estimatesPeriod.from.toISOString()).date} – ${
    formatRfpDateTime(estimatesSent.coveredThrough).date
  }`;
}

/**
 * Build the full-list PDF attachment, or null when there is nothing to attach.
 *
 * NEVER throws. The attachment is a convenience on top of a report that must go out regardless — a
 * pdfkit failure or a surprise row shape should cost the reader the appendix, not the whole email. The
 * null return is what the body keys its "attached as …" line off, so a failure here silently degrades to
 * the pre-attachment email rather than promising a file that is not there.
 */
export async function buildEstimatesAttachment(
  estimatesSent: CrmEstimatesSentResult,
  estimatesPeriod: { from: Date; to: Date } | undefined,
  fallbackLabel: string,
  runAt: Date,
  timezone?: string
): Promise<EmailAttachment | null> {
  if (!estimatesSent.ok || estimatesSent.deals.length === 0) return null;
  try {
    const content = await buildEstimatesSentPdf({
      deals: estimatesSent.deals,
      // The TRUE count, which is not deals.length once the endpoint's 500-row cap bites. The PDF says
      // so on its face rather than presenting the newest 500 as everything.
      total: estimatesSent.total,
      periodLabel: estimatesCoverageLabel(estimatesSent, estimatesPeriod, fallbackLabel),
    });
    return {
      filename: estimatesSentPdfFilename(runAt, timezone),
      content,
      contentType: "application/pdf",
    };
  } catch (error: any) {
    console.warn(
      `[rfp-reports] estimates PDF could not be generated, sending without it: ${error?.message ?? error}`
    );
    return null;
  }
}

/** Send scheduled RFP report email */
export async function sendScheduledRfpReport(
  config?: { recipients?: string[]; includeRfpLog?: boolean; includeApprovalSummary?: boolean },
  /**
   * The instant this run is FOR — the scheduler's own `now`, passed down rather than resampled here.
   *
   * One timestamp, used as the query's upper bound AND as the checkpoint the scheduler persists. Two
   * samples caused both of the problems this parameter closes: the earlier one re-reported anything
   * created between them, and sampling the LATER one for the checkpoint pushed lastSentAt forward by
   * the query duration on every run — enough for the next day's cadence guard
   * (`now - lastSentAt < windowMs`) to return early, and since the slot matches for only 15 minutes
   * there is no later retry, so a daily report would have sent every OTHER day.
   */
  runAt?: Date
): Promise<{
  sent: number;
  failed: number;
  windowEnd: Date;
  /**
   * How far the estimates lookup successfully covered, for the scheduler to checkpoint — or null when it
   * did not answer at all. On a catch-up too long for the request budget this is the end of the stretch
   * that WAS covered, so each run drains a little more of the backlog rather than repeating one window.
   */
  estimatesCoveredThrough: Date | null;
}> {
  // Resolved BEFORE the config read, so every exit reports the SAME instant this run is for — a fresh
  // sample on the early-return path would hand the scheduler a checkpoint later than the run it
  // describes, which is the drift this parameter exists to remove.
  const now = runAt ?? new Date();

  const cfg = await storage.getReportScheduleConfig();
  if (!cfg?.enabled || !cfg.recipients?.length) {
    return { sent: 0, failed: 0, windowEnd: now, estimatesCoveredThrough: null };
  }

  let dateFrom: Date;
  const dateTo: Date = now;
  let periodLabel: string;

  // The EXACT span the label promises, kept alongside the rounded one below. See estimatesFrom.
  let cadenceMs: number;

  switch (cfg.frequency) {
    case "daily":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 1);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 24 Hours";
      cadenceMs = 24 * 60 * 60 * 1000;
      break;
    case "weekly":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 7);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 7 Days";
      cadenceMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case "biweekly":
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 14);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 14 Days";
      cadenceMs = 14 * 24 * 60 * 60 * 1000;
      break;
    case "monthly":
      dateFrom = new Date(now);
      dateFrom.setMonth(dateFrom.getMonth() - 1);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 30 Days";
      cadenceMs = 30 * 24 * 60 * 60 * 1000;
      break;
    default:
      dateFrom = new Date(now);
      dateFrom.setDate(dateFrom.getDate() - 7);
      dateFrom.setHours(0, 0, 0, 0);
      periodLabel = "Last 7 Days";
      cadenceMs = 7 * 24 * 60 * 60 * 1000;
  }

  // Resolved BEFORE the query so getRfpsForPeriod can skip the CRM lookup when the cards — the only
  // place an amount is rendered — are switched off.
  const includeRfpLog = config?.includeRfpLog ?? cfg.includeRfpLog;

  const { rfps, changes, approvalSummary } = await getRfpsForPeriod(
    dateFrom,
    dateTo,
    includeRfpLog
  );

  const dashboardUrl = process.env.APP_URL || "http://localhost:5000";

  // The estimates that went out to CLIENTS — the CRM's answer, since SyncHub has no read path into
  // deal_stage_history.
  //
  // Asked for over the span SINCE THE LAST SUCCESSFUL SEND, not the rounded dateFrom the RFP half uses.
  //
  // That one moves back by the cadence and then rounds down to midnight while dateTo keeps the current
  // time, so consecutive runs OVERLAP from midnight until send time: at the scheduler's default 08:00
  // slot an estimate sent at 04:00 lands in today's "Last 24 Hours" email and again in tomorrow's.
  //
  // A fixed cadence duration fixes the overlap but is still wrong for MONTHLY, which fires on the first
  // of each calendar month — so consecutive runs sit 28 to 31 days apart while a fixed 30 days omits a
  // day after a long month and recounts one or two after February. `lastSentAt` is the boundary the
  // scheduler itself keeps, so using it makes consecutive reports exactly contiguous for every cadence:
  // no gap, no double count. The cadence duration remains the fallback for the first ever send, and for
  // a stored value that is not usable.
  // The ESTIMATES checkpoint, not lastSentAt. They answer different questions and fail differently:
  // lastSentAt records a delivery and drives the cadence guard, while this records how far the CRM
  // lookup has successfully reached. Sharing one column meant either duplicate emails (gating it on the
  // lookup) or permanently skipped intervals (advancing it regardless) — see the schema comment.
  const coveredThrough = cfg.estimatesCoveredThrough ? new Date(cfg.estimatesCoveredThrough) : null;
  const estimatesFrom =
    coveredThrough && !Number.isNaN(coveredThrough.getTime()) && coveredThrough.getTime() < dateTo.getTime()
      ? coveredThrough
      : new Date(dateTo.getTime() - cadenceMs);
  const estimatesSent = await fetchCrmEstimatesSent(estimatesFrom, dateTo);

  // BEFORE the HTML: the body names the attachment, so the file has to exist before the sentence
  // claiming it does. Built once and reused for every recipient rather than per send.
  const estimatesAttachment = await buildEstimatesAttachment(
    estimatesSent,
    { from: estimatesFrom, to: dateTo },
    periodLabel,
    dateTo,
    cfg.timezone ?? undefined
  );

  const html = await buildRfpReportEmailHtml({
    periodLabel,
    rfps,
    changes,
    approvalSummary,
    includeRfpLog,
    includeApprovalSummary:
      config?.includeApprovalSummary ?? cfg.includeApprovalSummary,
    estimatesSent,
    estimatesPeriod: { from: estimatesFrom, to: dateTo },
    estimatesPdfFilename: estimatesAttachment?.filename ?? null,
    dashboardUrl: `${dashboardUrl}/settings`,
  });

  const recipients = config?.recipients?.length ? config.recipients : cfg.recipients;
  let sent = 0,
    failed = 0;

  for (const to of recipients) {
    try {
      const result = await sendEmail({
        to,
        subject: `T-Rock RFP & Estimates Sent to Client — ${periodLabel}`,
        htmlBody: html,
        fromName: "T-Rock Sync Hub",
        attachments: estimatesAttachment ? [estimatesAttachment] : undefined,
      });
      if (result.success) sent++;
      else failed++;
    } catch {
      failed++;
    }
  }

  // The EXACT upper bound this run queried, for the scheduler to persist as lastSentAt.
  //
  // The scheduler used to persist its own `now`, sampled BEFORE calling this — an earlier instant than
  // the dateTo used here. Every estimate entered between the two samples fell inside this report's window
  // AND inside the next run's, because the next run started from the earlier stored value. Milliseconds
  // usually, but a slow config read or a stalled event loop widens it. Handing back the real boundary is
  // what makes consecutive windows genuinely abut.
  // `estimatesOk` gates the checkpoint. lastSentAt is the lower bound of the NEXT estimates window, so
  // advancing it after a failed lookup permanently skips the interval the CRM did not answer for — the
  // email goes out, the section says "could not be loaded", and those estimates are never reported by
  // anything again. Leaving it where it is makes the next scheduled run cover both intervals.
  // The boundary this run actually reached, rather than a boolean. A catch-up too long for the request
  // budget covers its oldest stretch and stops; checkpointing THAT lets the next run start where this one
  // finished, so the backlog drains. A lookup that did not answer checkpoints nothing.
  return {
    sent,
    failed,
    windowEnd: dateTo,
    estimatesCoveredThrough: estimatesSent.ok ? new Date(estimatesSent.coveredThrough) : null,
  };
}

/** Send a one-off test email to a specific address using current config */
export async function sendTestRfpReportEmail(to: string): Promise<{ success: boolean; error?: string }> {
  const cfg = await storage.getReportScheduleConfig();
  const now = new Date();
  const dateFrom = new Date(now);
  dateFrom.setDate(dateFrom.getDate() - 7);
  dateFrom.setHours(0, 0, 0, 0);

  const includeRfpLog = cfg?.includeRfpLog ?? true;
  const { rfps, changes, approvalSummary } = await getRfpsForPeriod(dateFrom, now, includeRfpLog);
  const dashboardUrl = process.env.APP_URL || "http://localhost:5000";

  // The SAME lookup the scheduled path makes. Without it "Send Test Email" was the one route that omitted
  // the estimates section — so the Settings action could neither preview the cards nor reveal a broken CRM
  // connection, which is most of what a test send is FOR.
  //
  // Over an EXACT seven days, not the rounded dateFrom above. That one is set to midnight seven calendar
  // days back while `now` keeps the current time, so a test sent at 08:00 covered 7 days 8 hours under a
  // heading reading "Last 7 Days" — and could show estimates the corresponding production report, which
  // uses an exact boundary, would not.
  const estimatesFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const estimatesSent = await fetchCrmEstimatesSent(estimatesFrom, now);

  // The test send carries the attachment too — a test that omitted it could not reveal a broken PDF
  // build, which is now one of the things a test send is FOR.
  const estimatesAttachment = await buildEstimatesAttachment(
    estimatesSent,
    { from: estimatesFrom, to: now },
    "Test Report (Last 7 Days)",
    now,
    cfg?.timezone ?? undefined
  );

  const html = await buildRfpReportEmailHtml({
    periodLabel: "Test Report (Last 7 Days)",
    rfps,
    changes,
    approvalSummary,
    includeRfpLog,
    includeApprovalSummary: cfg?.includeApprovalSummary ?? true,
    estimatesSent,
    estimatesPeriod: { from: estimatesFrom, to: now },
    estimatesPdfFilename: estimatesAttachment?.filename ?? null,
    dashboardUrl: `${dashboardUrl}/settings`,
  });

  const result = await sendEmail({
    to,
    subject: "T-Rock RFP & Estimates Sent to Client — Test",
    htmlBody: html,
    fromName: "T-Rock Sync Hub",
    attachments: estimatesAttachment ? [estimatesAttachment] : undefined,
  });

  return result.success ? { success: true } : { success: false, error: result.error };
}
