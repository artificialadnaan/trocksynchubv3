// Procore browser-login FAILURE alert.
//
// Every Playwright-driven flow in SyncHub (Bid Board stage sync, Bid Board project creation,
// portfolio transitions, document sync) funnels through ensureLoggedIn(). When the stored Procore
// password stops working, ALL of them die at once — and until now the only alarm was the CRM-side
// "no successful sync in 60 minutes" absence check, which by construction cannot fire for an hour.
// The 2026-08-03 outage ran ~73 minutes for exactly that reason, and the logs blamed a Procore UI
// change (see server/playwright/bidboard-export.ts) rather than the sign-in that had already failed.
//
// A login rejection is immediate and unambiguous, so it gets its own alert. Debounced through the
// SAME core as the Bid Board → CRM push alert (decideAlertTransition) so a failure repeating every
// 19 minutes sends one email per re-alert window, not three an hour, and sends one recovery email
// when logins start working again.
import { pool } from "../db";
import { sendEmail } from "../email-service";
import { log } from "../index";
import {
  decideAlertTransition,
  escapeHtml,
  type PushAlertAction,
  type PushAlertState,
  type Querier,
} from "./bidboard-crm-alert";

/** Why a login attempt failed. Set by performLogin at each failure site — never inferred from a
 *  message string, so re-wording a log line can't silently reclassify an outage. */
export type LoginFailureReason =
  | "credentials_rejected"
  | "mfa_required"
  | "timeout"
  | "login_form_unrecognized"
  | "not_configured"
  | "unknown";

/** The single scope key for the one Procore browser account SyncHub automates with. Kept as a
 *  column (not a hardcoded WHERE) so a second account/region can be tracked without a migration. */
export const PROCORE_LOGIN_ALERT_SCOPE = "procore-browser-login";

/**
 * The remediation nobody guesses on their own: rotating the password in Procore does NOT reach
 * SyncHub. The browser password lives encrypted in automation_config.procore_browser_credentials
 * and is only rewritten through SyncHub's own settings/testing UI (which calls testLogin →
 * saveProcoreCredentials). Worth more in the alert than any stack trace.
 */
export const PROCORE_CREDENTIAL_REMEDIATION =
  "Update the stored Procore browser password in SyncHub (Settings → Procore browser automation, " +
  "or the /testing login form). It is held encrypted in automation_config.procore_browser_credentials " +
  "and changing the password in Procore does NOT propagate to SyncHub.";

const REASON_LABELS: Record<LoginFailureReason, string> = {
  credentials_rejected: "Procore rejected the email/password",
  mfa_required: "Procore is asking for an MFA code",
  timeout: "the login never completed (timed out after submitting credentials)",
  login_form_unrecognized: "the login form did not look the way SyncHub expects",
  not_configured: "no Procore browser credentials are stored in SyncHub",
  unknown: "the login ended in an unrecognised state",
};

// ── Email rendering (pure) ───────────────────────────────────────────────────

export interface LoginAlertEmailInput {
  kind: "login_failed" | "recovered";
  reason?: LoginFailureReason;
  attempts?: number;
  error?: string;
  /** What the failure is currently blocking, e.g. "Bid Board stage sync". */
  blocking?: string;
  now: Date;
}

/** Pure renderer — separate from sending so it is unit-testable without a transport.
 *  Deliberately carries NO account identifier and NO credential material. */
export function renderLoginAlertEmail(e: LoginAlertEmailInput): { subject: string; htmlBody: string } {
  if (e.kind === "recovered") {
    return {
      subject: "✅ Procore browser sign-in RECOVERED — SyncHub automation resumed",
      htmlBody: `
    <h2>Procore browser sign-in is working again</h2>
    <p><strong>When:</strong> ${e.now.toISOString()}</p>
    <p>A Playwright automation signed into Procore successfully; the prior sign-in failure has cleared.</p>
  `,
    };
  }

  const reason = e.reason ?? "unknown";
  const subject = `⚠️ Procore browser sign-in FAILED (${reason.replace(/_/g, " ")}) — SyncHub automation blocked`;
  const htmlBody = `
      <h2>SyncHub cannot sign into Procore</h2>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Cause:</strong> ${escapeHtml(REASON_LABELS[reason] ?? REASON_LABELS.unknown)}</p>
      <p><strong>Sign-in attempts:</strong> ${e.attempts ?? "—"}</p>
      <p><strong>Procore said:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Blocked right now:</strong> ${escapeHtml(e.blocking ?? "all Playwright automation")}</p>
      <p><strong>What to do:</strong> ${escapeHtml(PROCORE_CREDENTIAL_REMEDIATION)}</p>
      <p>Every browser-driven flow — Bid Board stage sync, Bid Board project creation, portfolio
      transitions, document sync — is blocked until sign-in succeeds. Further alerts are throttled
      until the failure changes or the re-alert window elapses; one recovery email is sent when
      sign-in works again.</p>
    `;
  return { subject, htmlBody };
}

// ── DB I/O ───────────────────────────────────────────────────────────────────

/**
 * Idempotent table creation, co-located with its reader/writer — called from the boot migration AND
 * from recordLoginOutcomeAndMaybeAlert, so a STANDALONE entrypoint (the `bidboard:stage-sync`
 * script/cron, which never runs the web-server boot migrations) can't hit "relation does not exist"
 * and swallow the first alert. Same convention as bidboard_crm_push_alert_state; TIMESTAMPTZ because
 * the debounce compares instants across runs/processes.
 */
export async function ensureLoginAlertStateTable(db: Querier = pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS procore_login_alert_state (
      -- keep this column list byte-aligned with shared/schema.ts (procoreLoginAlertState)
      scope TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'ok',
      last_reason TEXT,
      last_alerted_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/** Queriers whose table has already been ensured this process. Keyed by the Querier so production
 *  (one `pool` singleton) pays the DDL once, while injected/test Queriers still initialise
 *  independently. Only recorded on SUCCESS, so a transient DB error retries on the next call. */
const ensuredQueriers = new WeakSet<Querier>();

/** Ensure-once wrapper: the self-heal still protects a standalone entrypoint on first use, without
 *  running DDL (and emitting a NOTICE) on every single sign-in check. */
async function ensureLoginAlertStateTableOnce(db: Querier): Promise<void> {
  if (ensuredQueriers.has(db)) return;
  await ensureLoginAlertStateTable(db);
  ensuredQueriers.add(db);
}

interface PersistedLoginAlertState {
  state: PushAlertState;
  last_reason: LoginFailureReason | null;
  last_alerted_at: Date | null;
  last_success_at: Date | null;
}

export async function readLoginAlertState(
  scope: string,
  db: Querier = pool
): Promise<PersistedLoginAlertState | null> {
  const { rows } = await db.query(
    `SELECT state, last_reason, last_alerted_at, last_success_at FROM procore_login_alert_state WHERE scope = $1`,
    [scope]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    state: r.state as PushAlertState,
    last_reason: (r.last_reason as LoginFailureReason | null) ?? null,
    last_alerted_at: r.last_alerted_at ? new Date(r.last_alerted_at) : null,
    last_success_at: r.last_success_at ? new Date(r.last_success_at) : null,
  };
}

export async function upsertLoginAlertState(
  scope: string,
  fields: {
    state: PushAlertState;
    lastReason: LoginFailureReason | null;
    lastAlertedAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
    now: Date;
  },
  db: Querier = pool
): Promise<void> {
  await db.query(
    `INSERT INTO procore_login_alert_state (scope, state, last_reason, last_alerted_at, last_success_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope) DO UPDATE
       SET state = EXCLUDED.state,
           last_reason = EXCLUDED.last_reason,
           last_alerted_at = EXCLUDED.last_alerted_at,
           last_success_at = EXCLUDED.last_success_at,
           last_error = EXCLUDED.last_error,
           updated_at = EXCLUDED.updated_at`,
    [scope, fields.state, fields.lastReason, fields.lastAlertedAt, fields.lastSuccessAt, fields.lastError, fields.now]
  );
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface LoginOutcome {
  ok: boolean;
  reason?: LoginFailureReason;
  attempts?: number;
  error?: string;
  blocking?: string;
}

export interface RecordLoginDeps {
  db?: Querier;
  send?: typeof sendEmail;
}

function realertMinutesFromEnv(): number {
  const n = Number(process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Reuses the Bid Board alert recipient — same ops inbox, same "ships inert until configured"
 *  posture, so a deploy never emails a surprise address. */
function recipientFromEnv(): string | null {
  const v = (process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim();
  return v || null;
}

/**
 * Record a Procore browser-login outcome and email on failure/recovery. NEVER throws — alerting must
 * never break an automation run that could otherwise still do useful work.
 *
 * The healthy path is deliberately cheap: when a login succeeds and the stored state is already 'ok'
 * (the overwhelmingly common case, since ensureLoggedIn runs on every automation) this does ONE
 * primary-key SELECT and no write.
 */
export async function recordLoginOutcomeAndMaybeAlert(
  args: {
    outcome: LoginOutcome;
    scope?: string;
    now?: Date;
    realertMinutes?: number;
    recipient?: string;
  },
  deps: RecordLoginDeps = {}
): Promise<{ action: PushAlertAction }> {
  try {
    const recipient = args.recipient ?? recipientFromEnv();
    // Inert until configured (parity with the CRM push alert): no recipient → no send, no state write.
    if (!recipient) {
      if (!args.outcome.ok) {
        log(
          "[ProcoreLogin] sign-in failed but BIDBOARD_CRM_ALERT_RECIPIENT is empty — alert is a no-op",
          "playwright"
        );
      }
      return { action: "none" };
    }

    const db = deps.db ?? pool;
    const send = deps.send ?? sendEmail;
    const now = args.now ?? new Date();
    const scope = args.scope ?? PROCORE_LOGIN_ALERT_SCOPE;
    const realertMinutes = args.realertMinutes ?? realertMinutesFromEnv();
    const reason = args.outcome.ok ? null : (args.outcome.reason ?? "unknown");

    // Self-heal the table so a standalone entrypoint (no web-boot migration) can't throw here.
    // Once per Querier per process, so the steady-state healthy path really is one PK read.
    await ensureLoginAlertStateTableOnce(db);
    const prior = await readLoginAlertState(scope, db);

    const decision = decideAlertTransition({
      healthy: args.outcome.ok,
      prevState: prior?.state ?? null,
      lastAlertedAt: prior?.last_alerted_at ?? null,
      now,
      realertMinutes,
      // A DIFFERENT failure is a new incident, not a repeat — the throttle only suppresses the
      // identical failure recurring every cycle.
      signatureChanged: !args.outcome.ok && prior?.last_reason != null && prior.last_reason !== reason,
    });

    // Nothing to say and nothing changed: skip the write entirely so the steady-state healthy path
    // (every automation, every cycle) costs one PK read.
    if (decision.action === "none" && args.outcome.ok && (prior?.state ?? "ok") === "ok") {
      return { action: "none" };
    }

    // Send first so the throttle anchor / state flip can be gated on a SUCCESSFUL send: a failed
    // first send must re-alert next cycle, not stay quiet for a whole window.
    let sent = false;
    if (decision.action !== "none") {
      const { subject, htmlBody } = renderLoginAlertEmail({
        kind: decision.action === "alert_recovered" ? "recovered" : "login_failed",
        reason: reason ?? undefined,
        attempts: args.outcome.attempts,
        error: args.outcome.error,
        blocking: args.outcome.blocking,
        now,
      });
      try {
        // Ops alert → only the configured recipient; skip the customer-facing GLOBAL_CC.
        const res = await send({ to: recipient, subject, htmlBody, bypassGlobalCc: true });
        sent = Boolean(res?.success);
        // Log the action, not the recipient address (PII stays out of routine logs).
        log(`[ProcoreLogin] alert ${decision.action} email sent=${sent} reason=${reason ?? "n/a"}`, "playwright");
      } catch (err) {
        log(`[ProcoreLogin] alert email send FAILED: ${err instanceof Error ? err.message : String(err)}`, "playwright");
      }
    }

    // State + throttle anchor gated on a SUCCESSFUL send (same rules as the CRM push alert):
    //  - failure: advance last_alerted_at only when the email sent, else re-alert next cycle
    //  - recovered: only flip to 'ok' when the recovery email sent, else stay 'failing' and retry
    let persistedState: PushAlertState = decision.nextState;
    let lastAlertedAt: Date | null;
    let persistedReason: LoginFailureReason | null = reason;
    if (decision.action === "alert_failure") {
      lastAlertedAt = sent ? now : (prior?.last_alerted_at ?? null);
    } else if (decision.action === "alert_recovered") {
      if (sent) {
        lastAlertedAt = null;
      } else {
        persistedState = "failing";
        lastAlertedAt = prior?.last_alerted_at ?? null;
        // Keep the failure signature so the retried recovery isn't mistaken for a new incident.
        persistedReason = prior?.last_reason ?? null;
      }
    } else {
      lastAlertedAt = prior?.last_alerted_at ?? null;
    }

    await upsertLoginAlertState(
      scope,
      {
        state: persistedState,
        lastReason: persistedReason,
        lastAlertedAt,
        lastSuccessAt: args.outcome.ok ? now : (prior?.last_success_at ?? null),
        lastError: args.outcome.ok ? null : (args.outcome.error ?? null),
        now,
      },
      db
    );

    return { action: decision.action };
  } catch (err) {
    // Alerting must never crash an automation run. Swallow and log (defensively, even the log).
    try {
      log(`[ProcoreLogin] login-alert handling failed: ${err instanceof Error ? err.message : String(err)}`, "playwright");
    } catch {
      /* no-op */
    }
    return { action: "none" };
  }
}
