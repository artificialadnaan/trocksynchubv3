/**
 * RFP approval auto-expiry (owner 2026-11-19, e28361c1: "30 days" — "Anything undecided for a month drops off quietly")
 * ===================================================================================================================
 * A pending rfp_approval_requests row stays 'pending' forever: nothing closes it, and the daily digest lists it every day.
 * This moves a pending request older than N days (PENDING_RFP_AUTO_EXPIRE_DAYS, default 30, counted from created_at = the
 * date it was sent) to 'expired' — SyncHub's existing terminal status (REQ 939: no route reads or moves an 'expired' row)
 * — and sets its link expired, so the review page shows its own "link expired" message and approve / decline both refuse it.
 * An earlier expiry is kept (LEAST), so a link that already died keeps its real date.
 *
 * QUIET: no email, no callback / outbox row, nothing pushed to HubSpot, the CRM or Core. One audit_logs row per request
 * (rfp_auto_expired, category system, status success — the alert job only reads 'error').
 *
 * NEVER touched (left for a person): a request with ANY rfp_approval_attempt audit row (an approval may be in flight —
 * the same rule as scripts/rfp-stale-pending-cleanup.ts), one with a Bid Board project, or one with an approving /
 * Bid Board callback / Core outbox row. A request with no created_at has no age and is skipped.
 *
 * ONE statement: the candidate rows are locked, re-checked as still pending, updated and audited together, so an
 * approval that claims a row first wins and the expiry skips it.
 *
 * Switch (a4, 2026-11-19): PENDING_RFP_AUTO_EXPIRE must be exactly "true" to write. Off, the daily run only logs how many
 * WOULD expire (same rule, read-only). A days value that is not a whole number from 1 to 3650 refuses to run at all.
 */
import { sql } from "drizzle-orm";
import { db } from "./db";

export const RFP_AUTO_EXPIRE_DEFAULT_DAYS = 30;
export const RFP_AUTO_EXPIRED_ACTION = "rfp_auto_expired";
/** At most this many requests per run; the next day's run takes the rest. */
export const RFP_AUTO_EXPIRE_BATCH_LIMIT = 500;

export type RfpAutoExpireOptions =
  | { ok: true; enabled: boolean; days: number }
  | { ok: false; enabled: false; error: string };

export function rfpAutoExpireOptions(env: NodeJS.ProcessEnv = process.env): RfpAutoExpireOptions {
  const enabled = env.PENDING_RFP_AUTO_EXPIRE === "true";
  const raw = env.PENDING_RFP_AUTO_EXPIRE_DAYS?.trim();
  if (raw === undefined || raw === "") return { ok: true, enabled, days: RFP_AUTO_EXPIRE_DEFAULT_DAYS };
  // Fail closed: a typo must never widen the window (e.g. "3" for "30") without someone noticing, so refuse instead.
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > 3650) {
    return { ok: false, enabled: false, error: `PENDING_RFP_AUTO_EXPIRE_DAYS must be a whole number from 1 to 3650, got "${raw}"` };
  }
  return { ok: true, enabled, days: Number(raw) };
}

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

function rowsOf(res: unknown): any[] {
  return Array.isArray(res) ? res : ((res as { rows?: any[] } | null)?.rows ?? []);
}

/** The rule, in one place: which pending requests are past the window and safe to expire. `r` is the request row. */
function staleRule(days: number) {
  return sql`r.status = 'pending'
     AND r.created_at IS NOT NULL
     AND r.created_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)
     AND r.bidboard_project_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'rfp_approval_attempt' AND a.details ->> 'requestId' = r.id::text)
     AND NOT EXISTS (SELECT 1 FROM rfp_approval_approving x WHERE x.request_id = r.id)
     AND NOT EXISTS (SELECT 1 FROM bidboard_callback_outbox x WHERE x.rfp_approval_request_id = r.id)
     AND NOT EXISTS (SELECT 1 FROM service_rfp_core_outbox x WHERE x.rfp_request_id = r.id)`;
}

/** Read-only: how many requests the expiry would move right now. */
export async function countStalePendingRfpRequests(days: number, exec: Executor = db): Promise<number> {
  const res = await exec.execute(sql`SELECT count(*)::int AS n FROM rfp_approval_requests r WHERE ${staleRule(days)}`);
  return Number(rowsOf(res)[0]?.n ?? 0);
}

export interface RfpAutoExpireResult {
  expired: number;
  audited: number;
  ids: number[];
}

/** Moves the stale pending requests to 'expired' with one audit row each, in ONE statement. */
export async function expireStalePendingRfpRequests(
  days: number,
  exec: Executor = db,
  limit: number = RFP_AUTO_EXPIRE_BATCH_LIMIT,
): Promise<RfpAutoExpireResult> {
  const res = await exec.execute(sql`
    WITH cand AS (
      SELECT r.id, r.token_expires_at AS old_expiry
        FROM rfp_approval_requests r
       WHERE ${staleRule(days)}
       ORDER BY r.id
       LIMIT ${limit}::int
         FOR UPDATE OF r SKIP LOCKED
    ),
    upd AS (
      UPDATE rfp_approval_requests r
         SET status = 'expired', token_expires_at = LEAST(c.old_expiry, (now() AT TIME ZONE 'UTC'))
        FROM cand c
       WHERE r.id = c.id AND r.status = 'pending'
      RETURNING r.id, r.source_deal_id, r.created_at, c.old_expiry, r.token_expires_at
    ),
    ins AS (
      INSERT INTO audit_logs (action, entity_type, entity_id, source, status, category, idempotency_key, details)
      SELECT ${RFP_AUTO_EXPIRED_ACTION}::text, 'deal', u.source_deal_id, 'rfp-auto-expire', 'success', 'system',
             ${RFP_AUTO_EXPIRED_ACTION}::text || ':' || u.id::text,
             jsonb_build_object('requestId', u.id, 'days', ${days}::int, 'sentAt', u.created_at,
               'from', jsonb_build_object('status', 'pending', 'token_expires_at', u.old_expiry),
               'to', jsonb_build_object('status', 'expired', 'token_expires_at', u.token_expires_at))
        FROM upd u
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM upd) AS expired,
           (SELECT count(*)::int FROM ins) AS audited,
           (SELECT coalesce(json_agg(u.id ORDER BY u.id), '[]'::json) FROM upd u) AS ids
  `);
  const row = rowsOf(res)[0] ?? {};
  const ids = typeof row.ids === "string" ? JSON.parse(row.ids) : (row.ids ?? []);
  return { expired: Number(row.expired ?? 0), audited: Number(row.audited ?? 0), ids: ids.map(Number) };
}

/** The daily run: expire when switched on, else log the would-expire count only. Never throws. */
export async function runRfpAutoExpire(
  env: NodeJS.ProcessEnv = process.env,
  exec: Executor = db,
  log: (line: string) => void = (line) => console.log(line),
): Promise<{ mode: "refused" | "dry-run" | "expired"; count: number }> {
  const opts = rfpAutoExpireOptions(env);
  try {
    if (!opts.ok) {
      log(`[rfp-auto-expire] NOT RUN: ${opts.error}`);
      return { mode: "refused", count: 0 };
    }
    if (!opts.enabled) {
      const n = await countStalePendingRfpRequests(opts.days, exec);
      log(`[rfp-auto-expire] OFF (PENDING_RFP_AUTO_EXPIRE is not "true"): ${n} pending request(s) older than ${opts.days} days would expire`);
      return { mode: "dry-run", count: n };
    }
    const r = await expireStalePendingRfpRequests(opts.days, exec);
    log(`[rfp-auto-expire] expired=${r.expired} audited=${r.audited} days=${opts.days} ids=${r.ids.join(",") || "-"}`);
    return { mode: "expired", count: r.expired };
  } catch (e: unknown) {
    log(`[rfp-auto-expire] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return { mode: "refused", count: 0 };
  }
}
