// Bid Board → CRM push FAILURE alert.
//
// SyncHub pushes the scraped Bid Board export to the CRM ingest endpoint and retries 3x. The CRM
// ingest runs in one transaction and ROLLS BACK on error, so a failed push leaves NO record in the
// CRM — SyncHub is the only observer of the failure (it sits OUTSIDE that transaction). The
// 2026-06-18 outage (a $16 type-inference 500 on every push) therefore ran ~24h silently. This module
// emails when a push fails after retry-exhaustion, debounced so a sustained outage doesn't spam, and
// sends one recovery email when pushes resume.
//
// Pairs with the CRM-side heartbeat (absence-of-success), which runs in a separate process and so
// also catches the case where SyncHub itself is down.
import { pool } from "../db";
import { sendEmail } from "../email-service";
import { log } from "../index";

export type PushAlertState = "ok" | "failing";
export type PushAlertAction = "alert_failure" | "alert_recovered" | "none";

export interface PushAlertDecisionInput {
  pushOk: boolean;
  prevState: PushAlertState | null;
  lastAlertedAt: Date | null;
  now: Date;
  realertMinutes: number;
}

export interface PushAlertDecision {
  action: PushAlertAction;
  nextState: PushAlertState;
}

/**
 * Pure debounce decision. Alert on the transition INTO failing, then at most once per re-alert window
 * while still failing; one recovery alert on the transition back to ok.
 */
export function decidePushAlert(i: PushAlertDecisionInput): PushAlertDecision {
  if (!i.pushOk) {
    if (i.prevState !== "failing") return { action: "alert_failure", nextState: "failing" };
    const dueForRealert =
      i.lastAlertedAt === null || i.now.getTime() - i.lastAlertedAt.getTime() >= i.realertMinutes * 60_000;
    return { action: dueForRealert ? "alert_failure" : "none", nextState: "failing" };
  }
  return { action: i.prevState === "failing" ? "alert_recovered" : "none", nextState: "ok" };
}

export interface PushAlertEmailInput {
  kind: "failure" | "recovered";
  office: string;
  attempts?: number;
  status?: number;
  error?: string;
  sourceFilename?: string;
  now: Date;
}

/** Pure email renderer — separate from sending so it is unit-testable without a transport. */
export function renderPushAlertEmail(e: PushAlertEmailInput): { subject: string; htmlBody: string } {
  const office = escapeHtml(e.office); // env-controlled, but escape defensively like the other body fields
  if (e.kind === "failure") {
    const subject = `⚠️ Bid Board → CRM push FAILED — office ${e.office}`;
    const htmlBody = `
      <h2>Bid Board → CRM ingestion push failed</h2>
      <p><strong>Office:</strong> ${office}</p>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Attempts before giving up:</strong> ${e.attempts ?? "—"}</p>
      <p><strong>HTTP status:</strong> ${e.status ?? "—"}</p>
      <p><strong>Error:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Export file:</strong> ${escapeHtml(e.sourceFilename ?? "—")}</p>
      <p>The scrape succeeded but the CRM rejected the push. Because a failed CRM ingest rolls back its
      own run record, this alert (raised by SyncHub, outside that transaction) is the primary failure
      signal. Further failures are throttled to roughly hourly until the push recovers.</p>
    `;
    return { subject, htmlBody };
  }

  const subject = `✅ Bid Board → CRM push RECOVERED — office ${e.office}`;
  const htmlBody = `
    <h2>Bid Board → CRM ingestion push has recovered</h2>
    <p><strong>Office:</strong> ${office}</p>
    <p><strong>When:</strong> ${e.now.toISOString()}</p>
    <p>A push has succeeded again; the prior failure has cleared.</p>
  `;
  return { subject, htmlBody };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// ── DB I/O ──────────────────────────────────────────────────────────────────

export interface Querier {
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>;
}

/**
 * Idempotent table creation, co-located with its reader/writer. Called both from the startup migration
 * (web boot) AND at the top of recordPushOutcomeAndMaybeAlert, so a STANDALONE entrypoint (e.g. the
 * `bidboard:stage-sync` script / cron, which imports runBidBoardStageSync directly and never runs the
 * web-server boot migrations) can't hit "relation does not exist" and silently swallow the first alert
 * (Codex). TIMESTAMPTZ because the debounce compares instants across runs/processes.
 */
export async function ensurePushAlertStateTable(db: Querier = pool): Promise<void> {
  // No CHECK constraint: kept byte-aligned with the drizzle definition (shared/schema.ts) so
  // drizzle-kit push --force doesn't see drift — matches the bidboard_stage_sync_runs convention.
  // State values are constrained by the PushAlertState type + the writers (only 'ok'/'failing').
  await db.query(`
    CREATE TABLE IF NOT EXISTS bidboard_crm_push_alert_state (
      office_slug TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'ok',
      last_alerted_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

interface PersistedPushAlertState {
  state: PushAlertState;
  last_alerted_at: Date | null;
  last_success_at: Date | null;
}

export async function readPushAlertState(officeSlug: string, db: Querier = pool): Promise<PersistedPushAlertState | null> {
  const { rows } = await db.query(
    `SELECT state, last_alerted_at, last_success_at FROM bidboard_crm_push_alert_state WHERE office_slug = $1`,
    [officeSlug]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    state: r.state as PushAlertState,
    last_alerted_at: r.last_alerted_at ? new Date(r.last_alerted_at) : null,
    last_success_at: r.last_success_at ? new Date(r.last_success_at) : null,
  };
}

export async function upsertPushAlertState(
  officeSlug: string,
  fields: { state: PushAlertState; lastAlertedAt: Date | null; lastSuccessAt: Date | null; lastError: string | null; now: Date },
  db: Querier = pool
): Promise<void> {
  await db.query(
    `INSERT INTO bidboard_crm_push_alert_state (office_slug, state, last_alerted_at, last_success_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (office_slug) DO UPDATE
       SET state = EXCLUDED.state,
           last_alerted_at = EXCLUDED.last_alerted_at,
           last_success_at = EXCLUDED.last_success_at,
           last_error = EXCLUDED.last_error,
           updated_at = EXCLUDED.updated_at`,
    [officeSlug, fields.state, fields.lastAlertedAt, fields.lastSuccessAt, fields.lastError, fields.now]
  );
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface PushResultLike {
  ok: boolean;
  skipped?: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export interface RecordPushDeps {
  db?: Querier;
  send?: typeof sendEmail;
}

function realertMinutesFromEnv(): number {
  const n = Number(process.env.BIDBOARD_CRM_ALERT_REALERT_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Recipient is env-driven with NO hardcoded fallback: unset/empty → null → the alert is a no-op.
 *  This matches the CRM heartbeat's "ships inert until configured" posture so a deploy never emails a
 *  surprise address. Set BIDBOARD_CRM_ALERT_RECIPIENT to activate. */
function recipientFromEnv(): string | null {
  const v = (process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim();
  return v || null;
}

/**
 * Record a push outcome and emit a failure/recovery email when warranted. NEVER throws — alerting must
 * never crash the sync cycle (a wrapped catch around everything, plus an inner catch around the send).
 * A 'skipped' push (CRM sync not configured) is ignored so disabling the integration can't spam.
 *
 * Concurrency: deliberately NO cross-run locking. The scheduled stage-sync cycle is already serialized
 * by `bidboardStageSyncRunning`, so the only way two runs overlap is a manual POST /api/bidboard/stage-sync
 * firing during a scheduled cycle. In that rare case the worst outcome is ONE duplicate or slightly-stale
 * ops email — which the per-office re-alert throttle bounds and the independent CRM-side heartbeat
 * (absence-of-success) backstops. We chose this over advisory-lock coordination, whose machinery added
 * deadlock / lock-leak / TOCTOU risk that is strictly worse than a rare duplicate email (Adnaan's call).
 */
export async function recordPushOutcomeAndMaybeAlert(
  args: {
    pushResult: PushResultLike;
    officeSlug: string;
    sourceFilename?: string;
    now?: Date;
    realertMinutes?: number;
    recipient?: string;
  },
  deps: RecordPushDeps = {}
): Promise<{ action: PushAlertAction } | { skipped: true }> {
  try {
    if (args.pushResult.skipped) return { skipped: true };

    const recipient = args.recipient ?? recipientFromEnv();
    // Inert until configured (parity with the CRM heartbeat): no recipient → no send, no state write.
    if (!recipient) {
      log("[BidBoardCRM] BIDBOARD_CRM_ALERT_RECIPIENT is empty — push alert is a no-op", "sync");
      return { action: "none" };
    }

    const db = deps.db ?? pool;
    const send = deps.send ?? sendEmail;
    const now = args.now ?? new Date();
    const realertMinutes = args.realertMinutes ?? realertMinutesFromEnv();

    // Self-heal the table so a standalone sync entrypoint (no web-boot migration) can't throw here.
    await ensurePushAlertStateTable(db);
    const prior = await readPushAlertState(args.officeSlug, db);
    const decision = decidePushAlert({
      pushOk: args.pushResult.ok,
      prevState: prior?.state ?? null,
      lastAlertedAt: prior?.last_alerted_at ?? null,
      now,
      realertMinutes,
    });

    // Send first so the throttle anchor / state flip can be gated on a SUCCESSFUL send: a failed first
    // send must re-alert next cycle, not stay quiet for a whole window. A thrown/false send is swallowed.
    let sent = false;
    if (decision.action !== "none") {
      const { subject, htmlBody } = renderPushAlertEmail({
        kind: decision.action === "alert_recovered" ? "recovered" : "failure",
        office: args.officeSlug,
        attempts: args.pushResult.attempts,
        status: args.pushResult.status,
        error: args.pushResult.error,
        sourceFilename: args.sourceFilename,
        now,
      });
      try {
        // Ops alert → only the configured recipient; skip the customer-facing GLOBAL_CC.
        const res = await send({ to: recipient, subject, htmlBody, bypassGlobalCc: true });
        sent = Boolean(res?.success);
        // Log office/action, not the raw recipient address (PII should stay out of routine logs).
        log(`[BidBoardCRM] alert ${decision.action} email sent=${sent} office=${args.officeSlug}`, "sync");
      } catch (err) {
        log(`[BidBoardCRM] alert email send FAILED: ${err instanceof Error ? err.message : String(err)}`, "sync");
      }
    }

    // State + throttle anchor gated on a SUCCESSFUL send:
    //  - failure: advance last_alerted_at only when the email sent (else re-alert next cycle)
    //  - recovered: only flip to 'ok' when the recovery email sent; if it failed, stay 'failing' so the
    //    recovery notice is retried next successful cycle.
    let persistedState: PushAlertState = decision.nextState;
    let lastAlertedAt: Date | null;
    if (decision.action === "alert_failure") {
      lastAlertedAt = sent ? now : (prior?.last_alerted_at ?? null);
    } else if (decision.action === "alert_recovered") {
      if (sent) {
        lastAlertedAt = null;
      } else {
        persistedState = "failing";
        lastAlertedAt = prior?.last_alerted_at ?? null;
      }
    } else {
      lastAlertedAt = prior?.last_alerted_at ?? null;
    }

    await upsertPushAlertState(
      args.officeSlug,
      {
        state: persistedState,
        lastAlertedAt,
        // Record the success instant only when the push actually succeeded; preserve prior otherwise.
        lastSuccessAt: args.pushResult.ok ? now : (prior?.last_success_at ?? null),
        lastError: args.pushResult.ok ? null : (args.pushResult.error ?? null),
        now,
      },
      db
    );

    return { action: decision.action };
  } catch (err) {
    // Alerting must never crash the sync. Swallow and log (defensively, even logging is guarded).
    try {
      log(`[BidBoardCRM] push-alert handling failed: ${err instanceof Error ? err.message : String(err)}`, "sync");
    } catch {
      /* no-op */
    }
    return { action: "none" };
  }
}
