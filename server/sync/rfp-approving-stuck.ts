/**
 * Alert `rfp_request_approving_stuck` (S0b-2b; runbook r5 §1; d9 Q7). A request is STUCK when its status is `approving` and
 * rfp_approval_approving.started_at is more than 30 minutes old: the process that claimed it most likely died mid-create, and
 * the Procore project may or may not exist. A person resolves it with scripts/rfp-resolve-approving.ts under an a4 GO.
 *
 * - One debounce key PER REQUEST (`rfp-approving-stuck:<id>`) on bidboard-crm-alert's state machine, re-alerting every 24 h
 *   while the row stays stuck.
 * - It CLEARS only when the row reaches a terminal status (approved / declined / held_cross_destination), never on an attempt.
 * - The payload carries the request id, source system, source deal id, project number and age. No names, no deal payload.
 * - Age is read on the DATABASE clock (started_at is the database's own wall clock); `now` drives only the debounce.
 * - Inert without a recipient (BIDBOARD_CRM_ALERT_RECIPIENT), like every SyncHub ops alert. bidboard-crm-alert is imported
 *   DYNAMICALLY: its pool import throws without DATABASE_URL.
 */
import type { PushAlertEmailInput, Querier } from "./bidboard-crm-alert";

export const RFP_APPROVING_STUCK_ALERT_CODE = "rfp_request_approving_stuck";
export const RFP_APPROVING_STUCK_AFTER_MINUTES = 30;
export const RFP_APPROVING_STUCK_REALERT_MINUTES = 24 * 60;
export const RFP_APPROVING_STUCK_KEY_PREFIX = "rfp-approving-stuck:";
export const RFP_APPROVING_TERMINAL_STATUSES = ["approved", "declined", "held_cross_destination"] as const;

export type StuckApprovingRequest = {
  requestId: number;
  sourceSystem: string;
  sourceDealId: string;
  projectNumber: string | null;
  /** Minutes since rfp_approval_approving.started_at; null when the request has no side-table row (age unknown). */
  ageMinutes: number | null;
};

export type StuckAlertSend = (msg: { to: string; subject: string; htmlBody: string; bypassGlobalCc?: boolean }) => Promise<{ success: boolean }>;

export type StuckSweepOptions = { db: Querier; now?: Date; recipient?: string; send?: StuckAlertSend };

/** `alerted` / `cleared`: the request ids whose stuck / cleared email was SENT by this sweep. */
export type StuckSweepResult = { stuck: StuckApprovingRequest[]; alerted: number[]; cleared: number[] };

/** `approving` rows whose side-table row is older than 30 minutes, or that have NO side-table row (age unknown; d9 QB). */
export async function findStuckApprovingRequests(db: Querier, _now: Date): Promise<StuckApprovingRequest[]> {
  const { rows } = await db.query(
    `SELECT r.id, r.source_system, r.source_deal_id, r.project_number,
            CASE WHEN a.request_id IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM ((now() AT TIME ZONE 'UTC') - a.started_at)) / 60)::int END AS age_minutes
       FROM rfp_approval_requests r
       LEFT JOIN rfp_approval_approving a ON a.request_id = r.id
      WHERE r.status = 'approving'
        AND (a.request_id IS NULL OR a.started_at < (now() AT TIME ZONE 'UTC') - make_interval(mins => $1))
      ORDER BY r.id`,
    [RFP_APPROVING_STUCK_AFTER_MINUTES],
  );
  return rows.map((r) => ({
    requestId: Number(r.id),
    sourceSystem: String(r.source_system),
    sourceDealId: String(r.source_deal_id),
    projectNumber: r.project_number ?? null,
    ageMinutes: r.age_minutes == null ? null : Number(r.age_minutes),
  }));
}

function renderStuck(row: StuckApprovingRequest, escapeHtml: (s: string) => string) {
  return (input: PushAlertEmailInput) => ({
    subject: `[SyncHub] ${RFP_APPROVING_STUCK_ALERT_CODE}: RFP request ${row.requestId} stuck creating its Bid Board project`,
    htmlBody:
      `<p>SyncHub RFP request <b>${row.requestId}</b> has been <b>approving</b> (creating its Bid Board project) for ` +
      `${row.ageMinutes == null ? "an unknown time (no start record)" : `${row.ageMinutes} minutes`}, at ${escapeHtml(input.now.toISOString())}.</p>` +
      `<p>Source ${escapeHtml(row.sourceSystem)} deal ${escapeHtml(row.sourceDealId)}, project number ${escapeHtml(row.projectNumber ?? "—")}.</p>` +
      `<p>The Procore project may or may not exist. Resolve it ONLY with scripts/rfp-resolve-approving.ts (dry-run first) under an ` +
      `a4 GO naming this request id (runbook r5). Never re-approve through the review link.</p>`,
  });
}

function renderCleared(requestId: number, status: string, escapeHtml: (s: string) => string) {
  return (input: PushAlertEmailInput) => ({
    subject: `[SyncHub] ${RFP_APPROVING_STUCK_ALERT_CODE} cleared: RFP request ${requestId} is ${status}`,
    htmlBody: `<p>SyncHub RFP request <b>${requestId}</b> is no longer stuck: it reached <b>${escapeHtml(status)}</b> at ${escapeHtml(input.now.toISOString())}.</p>`,
  });
}

export async function runRfpApprovingStuckSweep(opts: StuckSweepOptions): Promise<StuckSweepResult> {
  const now = opts.now ?? new Date();
  const recipient = (opts.recipient ?? process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim();
  // 0027 not applied yet ⇒ no side table and no request can be approving: a quiet no-op, not an error every tick.
  const sideTable = (await opts.db.query(`SELECT to_regclass('public.rfp_approval_approving')::text AS t`)).rows[0]?.t;
  if (!sideTable) return { stuck: [], alerted: [], cleared: [] };
  const stuck = await findStuckApprovingRequests(opts.db, now);
  const alerted: number[] = [];
  const cleared: number[] = [];
  if (!recipient) return { stuck, alerted, cleared };
  const { recordPushOutcomeAndMaybeAlert, escapeHtml } = await import("./bidboard-crm-alert");
  const deps = { db: opts.db, ...(opts.send ? { send: opts.send as any } : {}) };

  for (const row of stuck) {
    const res = await recordPushOutcomeAndMaybeAlert(
      {
        pushResult: { ok: false, attempts: 1, error: `${RFP_APPROVING_STUCK_ALERT_CODE}: ${JSON.stringify(row)}` },
        officeSlug: `${RFP_APPROVING_STUCK_KEY_PREFIX}${row.requestId}`,
        now,
        realertMinutes: RFP_APPROVING_STUCK_REALERT_MINUTES,
        recipient,
      },
      { ...deps, render: renderStuck(row, escapeHtml) },
    );
    if ("action" in res && res.action === "alert_failure" && res.sent) alerted.push(row.requestId);
  }

  cleared.push(...(await clearTerminal(null, { db: opts.db, recipient, send: opts.send, now })));
  return { stuck, alerted, cleared };
}

/**
 * Clear: a key still FAILING whose request reached a TERMINAL status (approved / declined / held_cross_destination). Any other
 * status (still approving, or anything non-terminal) keeps it failing. `ids` null = every failing stuck key. No state table yet
 * ⇒ nothing was ever alerted. Returns the ids whose cleared email was SENT.
 */
async function clearTerminal(
  ids: number[] | null,
  opts: { db: Querier; recipient: string; send?: StuckAlertSend; now: Date },
): Promise<number[]> {
  const table = (await opts.db.query(`SELECT to_regclass('public.bidboard_crm_push_alert_state')::text AS t`)).rows[0]?.t;
  if (!table) return [];
  const failing = (await opts.db.query(
    `SELECT office_slug FROM bidboard_crm_push_alert_state WHERE state = 'failing' AND office_slug LIKE $1 ORDER BY office_slug`,
    [`${RFP_APPROVING_STUCK_KEY_PREFIX}%`],
  )).rows
    .map((r) => Number(String(r.office_slug).slice(RFP_APPROVING_STUCK_KEY_PREFIX.length)))
    .filter((id) => Number.isInteger(id) && id > 0 && (ids === null || ids.includes(id)));
  if (failing.length === 0) return [];
  const terminal = (await opts.db.query(
    `SELECT id, status FROM rfp_approval_requests WHERE id = ANY($1::int[]) AND status = ANY($2::text[]) ORDER BY id`,
    [failing, [...RFP_APPROVING_TERMINAL_STATUSES]],
  )).rows;
  if (terminal.length === 0) return [];
  const { recordPushOutcomeAndMaybeAlert, escapeHtml } = await import("./bidboard-crm-alert");
  const cleared: number[] = [];
  for (const r of terminal) {
    const id = Number(r.id);
    const res = await recordPushOutcomeAndMaybeAlert(
      {
        pushResult: { ok: true, attempts: 1 },
        officeSlug: `${RFP_APPROVING_STUCK_KEY_PREFIX}${id}`,
        now: opts.now,
        realertMinutes: RFP_APPROVING_STUCK_REALERT_MINUTES,
        recipient: opts.recipient,
      },
      { db: opts.db, ...(opts.send ? { send: opts.send as any } : {}), render: renderCleared(id, String(r.status), escapeHtml) },
    );
    if ("action" in res && res.action === "alert_recovered" && res.sent) cleared.push(id);
  }
  return cleared;
}

/** The resolve CLI's clear after an apply (runbook r5 §3): one request, and only once it is terminal. */
export async function clearRfpApprovingStuckAlert(
  requestId: number,
  opts: { db: Querier; recipient?: string; send?: StuckAlertSend; now?: Date },
): Promise<boolean> {
  const recipient = (opts.recipient ?? process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim();
  if (!recipient) return false;
  const cleared = await clearTerminal([requestId], { db: opts.db, recipient, send: opts.send, now: opts.now ?? new Date() });
  return cleared.includes(requestId);
}
