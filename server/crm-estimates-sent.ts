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
  | {
      ok: true;
      /** At most MAX_ESTIMATES_SENT_ROWS, newest first. */
      deals: CrmEstimateSent[];
      /**
       * How many were actually sent, BEFORE the row cap.
       *
       * Carried separately because `deals.length` stops being the answer the moment the cap bites: at
       * the ceiling the email would otherwise print an exact-looking "500 Estimates Sent" for a period
       * that held more. The CRM caps the WINDOW, not the row count, so this is the true figure.
       */
      total: number;
      /**
       * The earliest instant actually covered.
       *
       * Later than the requested `from` when the interval was too long to cover in
       * MAX_ESTIMATES_SENT_REQUESTS endpoint-sized requests. It matters because the scheduler advances
       * lastSentAt on a successful send: anything silently dropped here would never appear in ANY later
       * report, so the section states its real reach instead.
       */
      coveredFrom: string;
      /**
       * The newest instant this run actually covered.
       *
       * Equals the requested `to` for an ordinary window. For a catch-up too long for the request budget
       * it is the end of the oldest-first stretch that WAS covered, and it is what the scheduler
       * checkpoints — so each run drains a little more of the backlog instead of re-fetching the same
       * window forever.
       */
      coveredThrough: string;
    }
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

/**
 * How many endpoint-sized requests one run may make to cover a long catch-up interval.
 *
 * 4 x 31 days is about four months — generous for a scheduler that was disabled, a process that was
 * down, or a stretch where every delivery failed. Beyond that the email is not a catch-up tool, and the
 * section says how far back it actually reached rather than pretending.
 */
export const MAX_ESTIMATES_SENT_REQUESTS = 4;

/** The widest window the CRM will accept, ending at `to`. */
export function clampEstimatesSentWindow(from: Date, to: Date): { from: Date; to: Date } {
  const widest = MAX_ESTIMATES_SENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // Exactly 31 days is ACCEPTED — the CRM rejects only `> 31 days`, and the bounds travel as serialized
  // timestamps, so nothing drifts in transit. An earlier version shaved a second off as a margin against
  // clock skew that cannot occur, and so dropped the first second of every clamped window.
  if (to.getTime() - from.getTime() <= widest) return { from, to };
  return { from: new Date(to.getTime() - widest), to };
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

  const doFetch = deps.fetchImpl ?? fetch;

  // COVER THE WHOLE INTERVAL in endpoint-sized requests, OLDEST FIRST.
  //
  // A single clamped request silently dropped everything older than 31 days — and because the checkpoint
  // advances on a successful send, those estimates would never appear in any later report either. A
  // catch-up after a disabled schedule or a long outage simply lost them, while the email said ok.
  //
  // Oldest-first is what makes a long catch-up CONVERGE. Newest-first spent the whole request budget on
  // the most recent chunks, the run was then marked incomplete so the checkpoint stayed put, and the
  // next run fetched almost exactly the same recent window again — recent estimates repeating in every
  // email while the older ones were never reached at all. Working forward from the checkpoint means each
  // run covers a new stretch and `coveredThrough` can advance, so the backlog drains.
  const windows: Array<{ from: Date; to: Date }> = [];
  let cursorFrom = from;
  const chunkMs = MAX_ESTIMATES_SENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  while (cursorFrom.getTime() < to.getTime() && windows.length < MAX_ESTIMATES_SENT_REQUESTS) {
    const chunkTo = new Date(Math.min(cursorFrom.getTime() + chunkMs, to.getTime()));
    windows.push({ from: cursorFrom, to: chunkTo });
    cursorFrom = chunkTo;
  }
  if (windows.length === 0) windows.push(clampEstimatesSentWindow(from, to));

  const collected: CrmEstimateSent[] = [];
  let totalMalformed = 0;
  // Where this run's coverage STARTS (the oldest bound asked for) and where it ENDS — the latter is the
  // boundary the scheduler checkpoints, so a partial catch-up still moves forward.
  const coveredFrom = windows[0]!.from;
  const coveredThrough = windows[windows.length - 1]!.to;

  for (const window of windows) {
    const outcome = await fetchOneWindow(window, { baseUrl, secret, doFetch, deps, logger });
    if (!outcome.ok) return outcome;
    collected.push(...outcome.deals);
    totalMalformed += outcome.malformed;
  }

  if (totalMalformed > 0) {
    logger(`[rfp-reports] CRM estimates-sent returned ${totalMalformed} unusable row(s); reporting the section as unavailable`);
    return { ok: false, reason: "failed" };
  }

  // NEWEST FIRST, then capped — the email slices its budget off the front and states the total, which is
  // only meaningful for an ordered list. Sorted across chunks, since each covers its own span.
  collected.sort((a, b) => {
    const delta = Date.parse(b.enteredAt) - Date.parse(a.enteredAt);
    return delta !== 0 ? delta : a.dealId.localeCompare(b.dealId);
  });

  return {
    ok: true,
    deals: collected.slice(0, MAX_ESTIMATES_SENT_ROWS),
    total: collected.length,
    coveredFrom: coveredFrom.toISOString(),
    coveredThrough: coveredThrough.toISOString(),
  };
}

/** One endpoint-sized request. Returns the parsed rows, or the failure the caller should surface. */
async function fetchOneWindow(
  window: { from: Date; to: Date },
  ctx: {
    baseUrl: string;
    secret: string;
    doFetch: (url: string, init: RequestInit) => Promise<Response>;
    deps: CrmEstimatesSentDeps;
    logger: (message: string) => void;
  }
): Promise<{ ok: true; deals: CrmEstimateSent[]; malformed: number } | { ok: false; reason: "failed" }> {
  const { baseUrl, secret, doFetch, deps, logger } = ctx;
  const rawBody = JSON.stringify({ from: window.from.toISOString(), to: window.to.toISOString() });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

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
      // priorEntryCount is SEMANTICALLY REQUIRED: it drives the re-send badge, and coercing a missing or
      // malformed value to 0 does not degrade gracefully — it presents a revised estimate as new business,
      // which is the one thing the annotation exists to prevent. Treated as an unusable row, like a
      // missing id or timestamp.
      const priorEntryCount = entry?.priorEntryCount;
      const priorEntryCountValid =
        typeof priorEntryCount === "number" &&
        Number.isInteger(priorEntryCount) &&
        priorEntryCount >= 0;

      if (!dealId || !enteredAt || Number.isNaN(Date.parse(enteredAt)) || !priorEntryCountValid) {
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
        priorEntryCount,
      });
    }

    return { ok: true, deals: parsed, malformed };
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
  if (!Number.isFinite(value) || value === 0) return "—";
  // A NEGATIVE amount is a real number, not an absent one. Deductive change orders carry one — the CRM
  // resolves a change order's value from awarded_amount, which goes negative for a deduction — and the
  // old `value <= 0` test lumped them in with "no value set" and printed an em dash. The report then
  // showed a row with no amount while every total that included it moved by that amount: a document
  // that disagrees with itself. Zero keeps the em dash, because zero really does mean nothing is set.
  const rounded = Math.round(Math.abs(value)).toLocaleString("en-US");
  return value < 0 ? `-$${rounded}` : `$${rounded}`;
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
