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
  /** Sign-in "went through" (or a saved session was reused) but the page then showed no signed-in
   *  Procore session — confirmed by a selector miss on a non-authenticated page (describeSelectorMiss). */
  | "session_not_established"
  /** SIGNED IN (an app route or session element is on the page), but a control the flow needs is not there:
   *  Procore changed the page. Recorded on PROCORE_PAGE_ALERT_SCOPE, never on the sign-in scope. */
  | "page_unrecognized"
  /** On a Procore app ROUTE (no sign-in form) but with no session element, and the control is missing: either the page
   *  changed or the session was lost. Recorded on PROCORE_PAGE_ALERT_SCOPE. */
  | "page_unconfirmed"
  | "unknown";

/** The single scope key for the one Procore browser account SyncHub automates with. Kept as a
 *  column (not a hardcoded WHERE) so a second account/region can be tracked without a migration. */
export const PROCORE_LOGIN_ALERT_SCOPE = "procore-browser-login";

/** A separate state row for "signed in, but the Bid Board page no longer has the export controls". Kept off
 *  the sign-in scope so a page change and a working sign-in can't alternate failure and recovery emails. */
export const PROCORE_PAGE_ALERT_SCOPE = "procore-bidboard-export-page";

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
  session_not_established:
    "the sign-in did not leave SyncHub with a usable Procore session (the Procore page shows no signed-in session)",
  page_unrecognized:
    "SyncHub is signed in to Procore, but the page no longer shows the control the automation needs (Procore probably changed the page)",
  page_unconfirmed:
    "SyncHub reached a Procore app page with no sign-in form, but the control the automation needs is not there and the session cannot be confirmed: either Procore changed the page or the session was lost",
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
  if (e.kind === "recovered" && (e.reason === "page_unrecognized" || e.reason === "page_unconfirmed")) {
    return {
      subject: "✅ Procore Bid Board export WORKING again — SyncHub",
      htmlBody: `
    <h2>The Procore Bid Board export is working again</h2>
    <p><strong>When:</strong> ${e.now.toISOString()}</p>
    <p>Procore delivered a Bid Board export; the earlier page problem has cleared.</p>
  `,
    };
  }
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
  if (reason === "page_unconfirmed") {
    return {
      subject: "⚠️ Procore Bid Board export BLOCKED (page or session not confirmed) — SyncHub",
      htmlBody: `
      <h2>SyncHub cannot run the Bid Board export, and cannot tell whether it is still signed in</h2>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Cause:</strong> ${escapeHtml(REASON_LABELS.page_unconfirmed)}</p>
      <p><strong>What it could not find:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Blocked right now:</strong> ${escapeHtml(e.blocking ?? "the Bid Board export")}</p>
      <p><strong>What to do:</strong> first click Test on SyncHub /testing → Procore Browser Login. If the SyncHub log then
      says "Successfully logged into Procore (session confirmed …)", or a Bid Board export is delivered, the sign-in is fine
      and Procore changed the page: SyncHub's selectors need updating from the "page fingerprint" log line. If it says
      "(app page reached; session not confirmed)", the page alone can't tell a lost session from a changed page; send the
      "page fingerprint" line to have the session check updated. If the Test fails, update the stored password there.</p>
      <p>At most one alert like this is sent a day while it continues; one email is sent when the export works again.</p>
    `,
    };
  }
  if (reason === "page_unrecognized") {
    return {
      subject: "⚠️ Procore Bid Board export BLOCKED (page not recognised) — SyncHub is signed in",
      htmlBody: `
      <h2>SyncHub is signed in to Procore, but cannot run the Bid Board export</h2>
      <p><strong>When:</strong> ${e.now.toISOString()}</p>
      <p><strong>Cause:</strong> ${escapeHtml(REASON_LABELS.page_unrecognized)}</p>
      <p><strong>What it could not find:</strong> ${escapeHtml(e.error ?? "(none captured)")}</p>
      <p><strong>Blocked right now:</strong> ${escapeHtml(e.blocking ?? "the Bid Board export")}</p>
      <p><strong>What to do:</strong> nothing on the password. SyncHub's page selectors need updating; the SyncHub
      log has a "page fingerprint" line for this page to work from.</p>
      <p>At most one alert like this is sent a day while it continues; one email is sent when the export works again.</p>
    `,
    };
  }
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
      transitions, document sync — is blocked until sign-in succeeds.</p>
      <p>While it stays failed, at most one alert is sent a day (even if the cause changes); one recovery email is sent when sign-in works again.</p>
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

/**
 * The ONLY address this alert may reach. Pinned in code on purpose: the alert used to read the shared
 * BIDBOARD_CRM_ALERT_RECIPIENT ops variable, which (a) made it a silent no-op whenever that variable
 * was unset, and (b) would send a credential-failure alert to whoever that variable is later pointed
 * at. Owner rule: system alerts go to the owner alone — never clients, never staff.
 */
export const PROCORE_LOGIN_ALERT_RECIPIENT = "aiqbal@trockgc.com";

/** Exactly one bare address — no lists, no display names. Anything else is refused, never widened. */
const SINGLE_ADDRESS_RE = /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/;

const LAST_ERROR_MAX = 500;

/**
 * Make a sign-in error safe to store (procore_login_alert_state.last_error) and to email:
 *  - every caller-supplied secret (the stored password, the account email) is replaced by [redacted];
 *  - URL query strings and fragments are dropped (a sign-in URL can carry the email or a token);
 *  - whitespace is collapsed and the result capped, so a Playwright call log can't bloat the row.
 */
export function sanitizeLoginError(error: string | undefined | null, redact: (string | undefined | null)[] = []): string | null {
  if (!error) return null;
  let out = String(error);
  for (const secret of redact) {
    if (secret && secret.length >= 3) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > LAST_ERROR_MAX ? `${out.slice(0, LAST_ERROR_MAX - 1)}…` : out;
}

/** Owner, 2026-10-15: at most one sign-in email a day while it stays failed. The env value can lengthen the window, never shorten it. */
export const PROCORE_LOGIN_ALERT_MIN_REALERT_MINUTES = 24 * 60;

function realertMinutesFromEnv(): number {
  const n = Number(process.env.PROCORE_LOGIN_ALERT_REALERT_MINUTES);
  return Number.isFinite(n) && n > PROCORE_LOGIN_ALERT_MIN_REALERT_MINUTES ? n : PROCORE_LOGIN_ALERT_MIN_REALERT_MINUTES;
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
    /** Test seam only — production callers never pass it, so the pinned owner address is used. */
    recipient?: string;
    /** Secrets to scrub from the error before it is stored or emailed (the stored password/email). */
    redact?: (string | undefined | null)[];
  },
  deps: RecordLoginDeps = {}
): Promise<{ action: PushAlertAction }> {
  try {
    const recipient = (args.recipient ?? PROCORE_LOGIN_ALERT_RECIPIENT).trim();
    // One bare address or nothing: a list would widen the audience of a credential alert.
    if (!SINGLE_ADDRESS_RE.test(recipient)) {
      log("[ProcoreLogin] refusing to alert: recipient is not a single address", "playwright");
      return { action: "none" };
    }
    const safeError = args.outcome.ok ? null : sanitizeLoginError(args.outcome.error, args.redact);

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
      // A changed reason is NOT a fresh email: the unverified-login and export sign-in checks can report
      // different reasons on alternate cycles, and each flip used to email (75 a day). The email names the
      // current reason; the window alone throttles while the state stays failed.
      signatureChanged: false,
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
        // A recovery names the failure it recovers from, so a page-change recovery is worded as one.
        reason: (reason ?? prior?.last_reason) ?? undefined,
        attempts: args.outcome.attempts,
        error: safeError ?? undefined,
        blocking: args.outcome.blocking,
        now,
      });
      try {
        // Ops alert → only the configured recipient; skip the customer-facing GLOBAL_CC.
        // Owner-pinned: past testing-mode redirection too, or a configured test address would get it instead.
        const res = await send({ to: recipient, subject, htmlBody, bypassGlobalCc: true, bypassTestingMode: true });
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
    // Nothing that an unsent email was supposed to communicate may be banked as communicated —
    // that applies to the failure SIGNATURE just as much as to the throttle anchor.
    let persistedState: PushAlertState = decision.nextState;
    let lastAlertedAt: Date | null;
    let persistedReason: LoginFailureReason | null = reason;
    if (decision.action === "alert_failure") {
      if (sent) {
        lastAlertedAt = now;
      } else {
        lastAlertedAt = prior?.last_alerted_at ?? null;
        // Keep the PRIOR reason. Banking the new one here would clear signatureChanged for the next
        // cycle, and the previous incident's still-live throttle window would then swallow the
        // retry — the changed failure would never be reported at all.
        persistedReason = prior?.last_reason ?? null;
      }
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
        lastError: safeError,
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
