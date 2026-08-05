/**
 * Render-time lookup of a T-Rock CRM deal's CURRENT value.
 * ========================================================
 *
 * The RFP report shows `deal_data.amount` — the value SyncHub snapshotted when the CRM POSTed the
 * RFP request. That snapshot is routinely empty and legitimately so: reps send the RFP first and
 * the estimator writes the estimate afterwards (production: Bristol Creek sent 16:42Z / estimate
 * 17:05Z; Standard River District 15:46Z / 16:46Z; The Positano 15:40Z / 18:02Z — every audit row
 * shows `old: null`). Nothing was lost; the number simply did not exist yet.
 *
 * So instead of an em-dash, the report asks the CRM what the deal is worth NOW. This module is that
 * ask. It is READ-ONLY on both sides — the stored snapshot is never rewritten — and it is
 * FAIL-SOFT: any misconfiguration, error, timeout or malformed response yields an empty map and the
 * report falls back to the em-dash it renders today. This runs inside a scheduled email job; a
 * lookup must never be the reason the email does not go out.
 */

import crypto from "crypto";
import { fetchWithTimeout } from "./lib/fetch-with-timeout";

/**
 * Ids per request. Mirrors the CRM's own cap on POST /api/internal/deals/current-values
 * (MAX_CURRENT_VALUE_DEAL_IDS = 500), which is comfortably above the 100 rows getRfpReportList will
 * ever return in a page — so a full report always resolves in ONE call. Anything beyond the cap is
 * left as an em-dash rather than split into a second round trip.
 */
export const CRM_CURRENT_VALUES_MAX_DEAL_IDS = 500;

/**
 * Deliberately short. This hangs off getRfpReportList, which serves the interactive
 * GET /api/reports/rfps list and the CSV/PDF export as well as the scheduled email — so the ceiling
 * is set by what a user will sit through, not by what a cron job would tolerate. A CRM that has not
 * answered in five seconds is not going to improve the report; the rows fall back to an em-dash.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CrmCurrentValueDeps {
  /** Injected in tests. Defaults to the timeout-wrapped global fetch. */
  fetchImpl?: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  /** Injected in tests so a deliberate failure does not spam the suite output. */
  logger?: (message: string) => void;
}

/**
 * Current value for each requested CRM deal id, keyed by id.
 *
 * A deal is present ONLY when the CRM returned a finite number for it. Deals the CRM does not know
 * about, deals that exist but still have no value at all, and every failure mode alike are simply
 * absent — the caller cannot tell them apart and must not need to: all four render identically.
 *
 * Keys are always lower-cased, whatever the CRM sent — so a caller holding a differently-cased id
 * only has to lower-case its own lookup for the two to meet.
 */
export async function fetchCrmCurrentDealAmounts(
  dealIds: string[],
  deps: CrmCurrentValueDeps = {}
): Promise<Map<string, number>> {
  const empty = new Map<string, number>();

  const unique = [...new Set(dealIds.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0))];
  if (unique.length === 0) return empty;

  const baseUrl = (deps.baseUrl ?? process.env.TROCK_CRM_BASE_URL)?.trim().replace(/\/+$/, "");
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  // console rather than the app's `log()` helper: that lives in ./index, and importing it here
  // would close a cycle (rfp-reports -> crm-deal-values -> index -> routes -> rfp-reports).
  const logger = deps.logger ?? ((message: string) => console.warn(message));

  if (!baseUrl || !secret) {
    // Not an error — a deployment without the CRM wired up just keeps showing snapshot values.
    return empty;
  }

  // Over the cap the CRM answers 422 for the WHOLE batch, so trim here instead. Rows arrive
  // newest-first, and the email renders only the first 30 cards, so the trimmed tail is the part
  // least likely to be read.
  const requested = unique.slice(0, CRM_CURRENT_VALUES_MAX_DEAL_IDS);

  const rawBody = JSON.stringify({ dealIds: requested });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const doFetch = deps.fetchImpl ?? fetchWithTimeout;

  try {
    const response = await doFetch(
      `${baseUrl}/api/internal/deals/current-values`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rfp-request-signature": signature,
        },
        body: rawBody,
      },
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    if (!response.ok) {
      logger(`[rfp-reports] CRM current-value lookup returned ${response.status}; rendering stored amounts only`);
      return empty;
    }

    const body: any = await response.json();
    const values = Array.isArray(body?.values) ? body.values : null;
    if (!values) {
      logger("[rfp-reports] CRM current-value lookup returned an unexpected shape; rendering stored amounts only");
      return empty;
    }

    const resolved = new Map<string, number>();
    for (const entry of values) {
      // Lower-cased here, at the producer, so the invariant is local. The CRM keys its answer on
      // `deals.id` and Postgres always renders that lower-case — but that is a promise made by
      // another service across a network boundary, and if it ever stopped holding the only symptom
      // would be a silent em-dash. Normalizing costs nothing and makes the contract ours to keep.
      const dealId = String(entry?.dealId ?? "").trim().toLowerCase();
      if (!dealId) continue;

      // Type-check BEFORE coercing. `Number("")`, `Number([])` and `Number(false)` are all a finite
      // 0, so a lenient check would turn a blank or malformed amount into a "$0" marked as the deal's
      // current value — a confidently wrong number in an email to leadership, which is strictly worse
      // than the em-dash this exists to replace. `amount: null` (the CRM's "exists, worth nothing
      // yet") must land here too: for display it is indistinguishable from not knowing.
      const raw = entry?.amount;
      if (typeof raw !== "number" && !(typeof raw === "string" && raw.trim() !== "")) continue;
      const amount = Number(raw);
      if (!Number.isFinite(amount)) continue;
      resolved.set(dealId, amount);
    }
    return resolved;
  } catch (error: any) {
    logger(
      `[rfp-reports] CRM current-value lookup failed (${error?.message || error}); rendering stored amounts only`
    );
    return empty;
  }
}
