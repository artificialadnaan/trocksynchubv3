/**
 * The deals a rep sent to a client, fetched from the T-Rock CRM for the RFP Report email.
 * =====================================================================================
 *
 * Colby's ask: the report should not stop at RFPs going OUT to subs — it should also show the
 * estimates that went out to CLIENTS in the same period, with the amount and the owner, and say when
 * a deal has been sent before.
 *
 * SyncHub cannot answer that itself. `estimate_sent_to_client` is a CRM pipeline stage recorded in
 * deal_stage_history inside each office's tenant schema, and the two systems are joined by
 * HMAC-signed callbacks rather than a shared database — SyncHub knows about RFPs only because the CRM
 * pushed them. So the report asks, at compose time, over the same signed channel and with the same
 * shared secret as the current-values lookup (see crm-deal-values.ts, which this mirrors closely).
 *
 * FAIL-SOFT, BUT NOT SILENT — and that is the one place this deliberately differs from its sibling.
 * A failed amount lookup degrades to an em-dash: the reader sees a value is missing. A failed lookup
 * HERE, if it simply produced an empty list, would render as "no estimates were sent to clients" —
 * which is not a gap in the report, it is a false statement in it, and one nobody could distinguish
 * from a genuinely quiet day. So this returns an explicit outcome and the email says the section
 * could not be loaded. The report still goes out either way; a lookup must never be the reason it
 * does not.
 */

import crypto from "crypto";

/** One deal that entered a "sent to client" stage in the window. Mirrors the CRM's response shape. */
export interface CrmEstimateSent {
  dealId: string;
  officeSlug: string;
  name: string | null;
  dealNumber: string | null;
  projectNumber: string | null;
  stageSlug: string;
  enteredAt: string;
  /** Decimal STRING, not a number — the CRM sends numeric(12,2) verbatim so no cent is lost in a float. */
  amount: string;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Sends of this deal strictly before this one: 0 on a first send, 2 on a third. */
  priorEntryCount: number;
}

/**
 * Either the deals, or a stated failure. Never "an empty list because something broke" — the whole
 * point of the discriminator is that the email can tell a quiet day from a broken lookup.
 */
export type CrmEstimatesSentResult =
  | { ok: true; deals: CrmEstimateSent[] }
  | { ok: false; reason: "not_configured" | "failed" };

/** Same 5s whole-exchange deadline as the current-values lookup, and for the same reason. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Cap on rows the email will consider. The CRM caps the WINDOW at 31 days but not the row count, and
 * a monthly report on a busy month could return far more than anyone reads. Trimmed here, newest
 * first, with the email stating the total so the number is never quietly wrong.
 */
export const MAX_ESTIMATES_SENT_ROWS = 500;

/**
 * The CRM refuses a window longer than this, so the client clamps rather than letting the section fail.
 *
 * The monthly report is the case that made this necessary: dateFrom is set to MIDNIGHT one month back
 * while dateTo keeps the current time, so after a 31-day month the span is 31 days PLUS however long
 * the report has been running that morning — over the limit, a 422, and "could not be loaded" every
 * single month. Clamping keeps the most recent 31 days, which is the part of the month a daily-cadence
 * reader has not already seen.
 */
export const MAX_ESTIMATES_SENT_WINDOW_DAYS = 31;

/** The widest window the CRM will accept, ending at `to`. */
export function clampEstimatesSentWindow(from: Date, to: Date): { from: Date; to: Date } {
  const widest = MAX_ESTIMATES_SENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // Strictly inside the bound: the CRM rejects `> 31 days`, and an exactly-31-day window that gains a
  // millisecond to clock skew on the way over would be refused for a reason nobody could see.
  if (to.getTime() - from.getTime() <= widest - 1000) return { from, to };
  return { from: new Date(to.getTime() - (widest - 1000)), to };
}

export interface CrmEstimatesSentDeps {
  /** Injected in tests. Defaults to the global `fetch`. Not fetchWithTimeout — see crm-deal-values.ts. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export async function fetchCrmEstimatesSent(
  from: Date,
  to: Date,
  deps: CrmEstimatesSentDeps = {}
): Promise<CrmEstimatesSentResult> {
  const baseUrl = (deps.baseUrl ?? process.env.TROCK_CRM_BASE_URL)?.trim().replace(/\/+$/, "");
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  // console rather than the app's log() helper, to avoid the import cycle documented in crm-deal-values.
  const logger = deps.logger ?? ((message: string) => console.warn(message));

  if (!baseUrl || !secret) {
    // A deployment without the CRM wired up is a configuration state, not a failure — reported
    // separately so the email can stay quiet about it rather than claiming something broke.
    return { ok: false, reason: "not_configured" };
  }

  const window = clampEstimatesSentWindow(from, to);
  const rawBody = JSON.stringify({ from: window.from.toISOString(), to: window.to.toISOString() });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const doFetch = deps.fetchImpl ?? fetch;

  // One deadline covering the request, the response headers AND the body read — cleared only after
  // response.json() has settled, so a server that sends 200 and then stalls mid-JSON aborts into the
  // catch instead of hanging the scheduled email.
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(`${baseUrl}/api/internal/estimates-sent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rfp-request-signature": signature,
      },
      body: rawBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      logger(`[rfp-reports] CRM estimates-sent lookup returned ${response.status}`);
      return { ok: false, reason: "failed" };
    }

    const body: any = await response.json();
    const deals = Array.isArray(body?.deals) ? body.deals : null;
    if (!deals) {
      logger("[rfp-reports] CRM estimates-sent lookup returned an unexpected shape");
      return { ok: false, reason: "failed" };
    }

    const parsed: CrmEstimateSent[] = [];
    let malformed = 0;
    for (const entry of deals) {
      const dealId = String(entry?.dealId ?? "").trim();
      const enteredAt = String(entry?.enteredAt ?? "").trim();
      // A row with no id or no timestamp cannot be rendered or ordered — but it also cannot be quietly
      // dropped. Presenting the survivors as a complete answer is precisely what the result
      // discriminator exists to prevent: under schema drift or partial bad data leadership would read
      // an understated count, or "No estimates sent" when every row was malformed. Counted, and turned
      // into a stated failure below.
      if (!dealId || !enteredAt || Number.isNaN(Date.parse(enteredAt))) {
        malformed += 1;
        continue;
      }

      parsed.push({
        dealId,
        officeSlug: String(entry?.officeSlug ?? "").trim(),
        name: typeof entry?.name === "string" ? entry.name : null,
        dealNumber: typeof entry?.dealNumber === "string" ? entry.dealNumber : null,
        projectNumber: typeof entry?.projectNumber === "string" ? entry.projectNumber : null,
        stageSlug: String(entry?.stageSlug ?? "").trim(),
        enteredAt,
        // Kept as the string the CRM sent. Coercing to a number here would undo the exact-decimal
        // choice made on the other side of the wire for the sake of one cent.
        amount: typeof entry?.amount === "string" || typeof entry?.amount === "number"
          ? String(entry.amount)
          : "0",
        ownerName: typeof entry?.ownerName === "string" ? entry.ownerName : null,
        ownerEmail: typeof entry?.ownerEmail === "string" ? entry.ownerEmail : null,
        priorEntryCount: Number.isFinite(Number(entry?.priorEntryCount))
          ? Math.max(0, Math.trunc(Number(entry.priorEntryCount)))
          : 0,
      });
    }

    if (malformed > 0) {
      logger(`[rfp-reports] CRM estimates-sent returned ${malformed} unusable row(s); reporting the section as unavailable`);
      return { ok: false, reason: "failed" };
    }

    // NEWEST FIRST, then capped — the email slices the first 30 and prints "Showing 30 of N", which is
    // only true of an ordered list. The CRM already orders its response, but this module states the
    // guarantee the renderer relies on, so a change on the other side of the wire cannot quietly turn
    // "the 30 newest" into "30 arbitrary rows".
    parsed.sort((a, b) => {
      const delta = Date.parse(b.enteredAt) - Date.parse(a.enteredAt);
      return delta !== 0 ? delta : a.dealId.localeCompare(b.dealId);
    });

    return { ok: true, deals: parsed.slice(0, MAX_ESTIMATES_SENT_ROWS) };
  } catch (error: any) {
    const reason =
      error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error?.message || error;
    logger(`[rfp-reports] CRM estimates-sent lookup failed (${reason})`);
    return { ok: false, reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** "$1,235" from the CRM's exact decimal string. Mirrors formatRfpAmount, which takes a number. */
export function formatEstimateAmount(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * "2nd time sent", "3rd time sent" — or nothing at all on a first send.
 *
 * Returning empty for a first send is the point: a badge on every card would be noise, and the
 * annotation only carries information when the answer is "this has gone out before".
 */
export function resendLabel(priorEntryCount: number): string {
  if (!Number.isFinite(priorEntryCount) || priorEntryCount < 1) return "";
  const ordinal = priorEntryCount + 1;
  const suffix =
    ordinal % 100 >= 11 && ordinal % 100 <= 13
      ? "th"
      : ordinal % 10 === 1
        ? "st"
        : ordinal % 10 === 2
          ? "nd"
          : ordinal % 10 === 3
            ? "rd"
            : "th";
  return `${ordinal}${suffix} time sent`;
}
