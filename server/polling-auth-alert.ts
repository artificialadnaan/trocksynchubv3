// Polling auto-disable on auth expiry: record it ONCE and tell someone.
//
// Procore polling disabled itself on 2026-06-10 (disabledReason "auth_expired") and HubSpot polling on
// 06-05. The only trace was a console line and a flag in automation_config, so the vendor and user
// mirrors went stale for months before anyone looked. This module is the auth-expiry path for both
// pollers: it writes the disabled row, and on a NEW disable event it writes an audit_logs row, logs a
// structured error, and emails the ops recipient the other SyncHub alerts already use.
//
// One alert per disable event. A disable event is identified by its `disabledAt`:
//  - If the stored row is ALREADY disabled for auth_expired (a manual trigger or a stray start-up
//    cycle hit the same dead token again), it is the same event: the original disabledAt is kept, no
//    new audit row is written, and the email is only retried if the first one never went out.
//  - The email is deduped through email_send_log (checkEmailDedupeKey / createEmailSendLog), keyed on
//    job + disabledAt, and banked only after a SUCCESSFUL send. A failed send is retried (bounded, and once more
//    at boot); a delivered one never is. An existing event is only resent within POLLING_ALERT_RESEND_WINDOW_MS,
//    well inside the 90 days cleanupOldLogs keeps the dedupe row.
//  - A resend is bound to its event: it never writes the row, and it stops ("superseded") once the row no
//    longer describes that event.
// Re-enabling (POST /api/settings/polling/:job/enable, or the Settings toggle) rewrites the row without
// disabledReason, so the next expiry is a new event and alerts again.
//
// Recipient: BIDBOARD_CRM_ALERT_RECIPIENT, the same ops inbox as the Procore sign-in alert and the Bid
// Board → CRM push alert, with the same "inert until configured" posture. With no recipient the alert
// falls back to the structured error log plus the audit row (status "error", category "system"),
// which the system_alert_email digest also picks up when that is enabled.
//
// NEVER throws: alerting must not break the polling cycle that is reporting the failure.
import { storage } from "./storage";

export type PollingJobKey = "procore_polling" | "hubspot_polling";

interface PollingJobInfo {
  key: PollingJobKey;
  /** Path segment of POST /api/settings/polling/:job/enable. */
  slug: "procore" | "hubspot";
  label: string;
  reconnect: string;
  defaultIntervalMinutes: number;
  description: string;
}

/** Interval defaults match initPolling's boot fallbacks (coprime cadences). */
export const POLLING_JOBS: Readonly<Record<PollingJobInfo["slug"], PollingJobInfo>> = Object.freeze({
  procore: {
    key: "procore_polling",
    slug: "procore",
    label: "Procore polling (projects / vendors / users mirror)",
    reconnect: "Reconnect Procore OAuth in SyncHub (Settings → Procore configuration → OAuth, which calls /api/oauth/procore/authorize)",
    defaultIntervalMinutes: 17,
    description: "Automatic Procore data polling sync configuration",
  },
  hubspot: {
    key: "hubspot_polling",
    slug: "hubspot",
    label: "HubSpot polling (companies / contacts / deals mirror)",
    reconnect: "Restore HubSpot credentials (re-authorize via /api/oauth/hubspot/authorize, or rotate the HUBSPOT_ACCESS_TOKEN private-app token)",
    defaultIntervalMinutes: 11,
    description: "Automatic HubSpot polling sync configuration",
  },
});

export function pollingJobByKey(key: PollingJobKey): PollingJobInfo {
  return key === "procore_polling" ? POLLING_JOBS.procore : POLLING_JOBS.hubspot;
}

export function reenableInstructions(job: PollingJobInfo): string {
  return (
    `${job.reconnect}. Then an admin re-enables polling: POST /api/settings/polling/${job.slug}/enable ` +
    `(admin session; clears disabledReason, restarts the timer, writes an audit row).`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Pure renderer, so the copy is testable without a transport. Carries no token material. */
export function renderPollingDisabledEmail(e: {
  job: PollingJobInfo;
  disabledAt: string;
  error: string;
  /** false when the disabled row could not be saved: this process stopped, but a restart resumes polling. */
  persisted?: boolean;
}): { subject: string; htmlBody: string } {
  const name = e.job.slug === "procore" ? "Procore" : "HubSpot";
  if (e.persisted === false) {
    return {
      subject: `⚠️ SyncHub ${name} polling STOPPED (auth expired) but the disable was NOT saved`,
      htmlBody: `
      <h2>SyncHub stopped ${escapeHtml(e.job.label)}, but could not save that it is off</h2>
      <p><strong>Job:</strong> ${escapeHtml(e.job.key)}</p>
      <p><strong>When:</strong> ${escapeHtml(e.disabledAt)}</p>
      <p><strong>Reason:</strong> auth_expired — the stored credentials were rejected</p>
      <p><strong>Error:</strong> ${escapeHtml(e.error || "(none captured)")}</p>
      <p>The stored configuration still says enabled, so the next restart or deploy starts polling again against the
      same rejected credentials.</p>
      <p><strong>How to fix:</strong> ${escapeHtml(reenableInstructions(e.job))}</p>
    `,
    };
  }
  return {
    subject: `⚠️ SyncHub ${name} polling DISABLED (auth expired) — mirrors are going stale`,
    htmlBody: `
      <h2>SyncHub turned off ${escapeHtml(e.job.label)}</h2>
      <p><strong>Job:</strong> ${escapeHtml(e.job.key)}</p>
      <p><strong>When:</strong> ${escapeHtml(e.disabledAt)}</p>
      <p><strong>Reason:</strong> auth_expired — the stored credentials were rejected</p>
      <p><strong>Error:</strong> ${escapeHtml(e.error || "(none captured)")}</p>
      <p><strong>How to re-enable:</strong> ${escapeHtml(reenableInstructions(e.job))}</p>
      <p>Polling stays OFF until it is re-enabled; it does not retry on its own. This is sent once per
      disable event.</p>
    `,
  };
}

function recipientFromEnv(): string | null {
  const v = (process.env.BIDBOARD_CRM_ALERT_RECIPIENT ?? "").trim();
  return v || null;
}

type SendEmail = (params: {
  to: string;
  subject: string;
  htmlBody: string;
  bypassGlobalCc?: boolean;
  fromName?: string;
}) => Promise<{ success: boolean }>;

export interface PollingAuthExpiryDeps {
  send?: SendEmail;
  recipient?: string | null;
  now?: () => Date;
  /** Runs a retry later. Defaults to an unref'd setTimeout, so a pending retry never holds the process open. */
  scheduleRetry?: (fn: () => void, ms: number) => void;
  /**
   * Internal: a resend of one known event (a scheduled retry, or the boot check). It sends only while the stored row
   * still describes that event, and it never writes the row.
   */
  retry?: { attempt: number; disabledAt: string; persisted: boolean };
}

/**
 * Retries after a failed SEND, independent of any polling cycle: the pollers are stopped by the time this runs, so
 * waiting for "the next cycle" would wait forever. Bounded; a restart also re-checks once (resendPendingPollingAlerts).
 * A retry never writes the config row: if the disable was not saved, rewriting it minutes later could turn off a job
 * an admin has since re-enabled.
 */
export const POLLING_ALERT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]);

/** The saved disable keeps this much of the error, so a resend after a restart can still say what failed. */
const DISABLED_ERROR_MAX = 500;
const PERSIST_ATTEMPTS = 3;

/**
 * An EXISTING event (a repeat trigger, a scheduled retry, the boot check) is only (re)sent while it is younger than
 * this. The one-email dedupe row lives in email_send_log, which cleanupOldLogs deletes after 90 days; without this
 * bound, a job that stays auth-disabled past that would be emailed again by the next boot or manual trigger. 30 days
 * keeps every resend well inside the dedupe row's lifetime. A NEW event always has a fresh disabledAt, so this never
 * stops the first alert.
 */
export const POLLING_ALERT_RESEND_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * In-process guards against a second copy: a send of the same event already in flight (a repeat trigger racing a
 * scheduled retry), and an event delivered whose send-log row could not be banked.
 */
const inFlight = new Set<string>();
const delivered = new Set<string>();

export interface PollingAuthExpiryResult {
  newEvent: boolean;
  disabledAt: string;
  /** false when the disabled row could not be saved; the alert says so and names the manual fix. */
  persisted: boolean;
  /**
   * superseded: a resend found the event gone (re-enabled, or replaced by a newer disable), so it sent nothing.
   * too_old: an existing event older than POLLING_ALERT_RESEND_WINDOW_MS is never resent (its dedupe row may be gone).
   */
  alert: "sent" | "already_sent" | "no_recipient" | "send_failed" | "superseded" | "too_old";
}

function defaultScheduleRetry(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
}

export async function recordPollingAuthExpiry(
  args: { job: PollingJobKey; error: string },
  deps: PollingAuthExpiryDeps = {},
): Promise<PollingAuthExpiryResult> {
  const result = await recordOnce(args, deps);
  const attempt = deps.retry?.attempt ?? 0;
  if (result.alert === "send_failed" && attempt < POLLING_ALERT_RETRY_DELAYS_MS.length) {
    try {
      (deps.scheduleRetry ?? defaultScheduleRetry)(() => {
        void recordPollingAuthExpiry(args, {
          ...deps,
          retry: { attempt: attempt + 1, disabledAt: result.disabledAt, persisted: result.persisted },
        });
      }, POLLING_ALERT_RETRY_DELAYS_MS[attempt]!);
    } catch (err) {
      console.warn(`[PollingAlert] Could not schedule a retry for ${args.job}:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

/**
 * At boot: a disable that was saved but whose email never went out (a failed send, then a restart) gets one more
 * try. Polling stays off across the restart, so no cycle would ever reach recordPollingAuthExpiry again.
 * Never throws.
 */
export async function resendPendingPollingAlerts(deps: PollingAuthExpiryDeps = {}): Promise<void> {
  for (const job of [POLLING_JOBS.procore, POLLING_JOBS.hubspot]) {
    try {
      const prior: any = (await storage.getAutomationConfig(job.key))?.value ?? null;
      if (!prior || prior.enabled === true || prior.disabledReason !== "auth_expired" || typeof prior.disabledAt !== "string") continue;
      const recipient = deps.recipient !== undefined ? deps.recipient : recipientFromEnv();
      if (!recipient) continue;
      if (!withinResendWindow(prior.disabledAt, deps)) continue;
      if (await storage.checkEmailDedupeKey(`polling_auto_disabled:${job.key}:${prior.disabledAt}`)) continue;
      const error = typeof prior.disabledError === "string" ? prior.disabledError : "(recorded before a restart)";
      // Bound to THIS event: if an admin re-enables between the read above and the send, the resend finds the row
      // changed and stops, rather than treating the enabled row as a new expiry and disabling it again.
      await recordPollingAuthExpiry({ job: job.key, error }, { ...deps, retry: { attempt: 0, disabledAt: prior.disabledAt, persisted: true } });
    } catch (err) {
      console.warn(`[PollingAlert] Pending-alert check failed for ${job.key}:`, err instanceof Error ? err.message : err);
    }
  }
}

function withinResendWindow(disabledAt: string, deps: PollingAuthExpiryDeps): boolean {
  const at = Date.parse(disabledAt);
  // An unparseable timestamp cannot be placed inside the dedupe row's lifetime, so it is not resent.
  if (!Number.isFinite(at)) return false;
  return (deps.now ?? (() => new Date()))().getTime() - at < POLLING_ALERT_RESEND_WINDOW_MS;
}

async function recordOnce(
  args: { job: PollingJobKey; error: string },
  deps: PollingAuthExpiryDeps,
): Promise<PollingAuthExpiryResult> {
  const job = pollingJobByKey(args.job);
  const now = (deps.now ?? (() => new Date()))();
  // A retry belongs to the event it retries: same disabledAt, so the dedupe key and the audit trail stay one event.
  let disabledAt = deps.retry?.disabledAt ?? now.toISOString();
  let newEvent = true;
  let persisted = true;

  try {
    let prior: any = null;
    let readFailed = false;
    try {
      prior = (await storage.getAutomationConfig(job.key))?.value ?? null;
    } catch (err) {
      readFailed = true;
      console.warn(`[PollingAlert] Could not read ${job.key} before disabling:`, err instanceof Error ? err.message : err);
    }

    const alreadyDisabledForAuth =
      prior != null &&
      typeof prior === "object" &&
      prior.enabled !== true &&
      prior.disabledReason === "auth_expired" &&
      typeof prior.disabledAt === "string" &&
      prior.disabledAt !== "";

    if (deps.retry) {
      // A resend of a known event: never writes the row and never audits. A SAVED event is resent only while the row
      // still holds its disabledAt; an UNSAVED one only while no saved disable has taken its place. Anything else
      // means an admin re-enabled or a newer event exists, and this resend is stale.
      const r = deps.retry;
      // A failed read says nothing about the event: keep the bounded retries going rather than dropping the alert.
      if (readFailed) return { newEvent: false, disabledAt: r.disabledAt, persisted: r.persisted, alert: "send_failed" };
      // An unsaved event says "a restart resumes polling", which stops being true once the row is saved off, whether
      // by a newer auth disable or by someone turning the job off.
      const current = r.persisted
        ? alreadyDisabledForAuth && prior.disabledAt === r.disabledAt
        : !alreadyDisabledForAuth && prior?.enabled !== false;
      if (!current) return { newEvent: false, disabledAt: r.disabledAt, persisted: r.persisted, alert: "superseded" };
      newEvent = false;
      persisted = r.persisted;
    } else if (alreadyDisabledForAuth) {
      newEvent = false;
      disabledAt = prior.disabledAt;
    } else {
      const priorInterval = Number(prior?.intervalMinutes);
      persisted = false;
      for (let i = 0; i < PERSIST_ATTEMPTS && !persisted; i++) {
        try {
          await storage.upsertAutomationConfig({
            key: job.key,
            value: {
              enabled: false,
              intervalMinutes: Number.isFinite(priorInterval) && priorInterval > 0 ? priorInterval : job.defaultIntervalMinutes,
              disabledReason: "auth_expired",
              disabledAt,
              disabledError: String(args.error ?? "").slice(0, DISABLED_ERROR_MAX),
            },
            description: job.description,
          });
          persisted = true;
        } catch (err) {
          console.warn(`[PollingAlert] Failed to persist ${job.key} disable on auth expiry (attempt ${i + 1}):`, err instanceof Error ? err.message : err);
        }
      }
    }

    const recipient = deps.recipient !== undefined ? deps.recipient : recipientFromEnv();

    if (newEvent) {
      // The structured log and the audit row are written for EVERY new event: they are the record, and
      // with no recipient configured they are the whole alert.
      // Only a SAVED disable is "polling_auto_disabled": an unsaved one is a different fact (a restart resumes
      // polling), recorded under its own name so the audit trail never claims a durable state it does not have.
      const event = persisted ? "polling_auto_disabled" : "polling_auto_disable_not_saved";
      console.error(
        JSON.stringify({
          level: "error",
          event,
          persisted,
          job: job.key,
          reason: "auth_expired",
          disabledAt,
          error: args.error,
          reenable: reenableInstructions(job),
          emailRecipientConfigured: recipient !== null,
        }),
      );
      try {
        await storage.createAuditLog({
          action: event,
          entityType: job.key,
          source: "polling",
          status: "error",
          category: "system",
          errorMessage: args.error,
          details: { job: job.key, reason: "auth_expired", disabledAt, persisted, reenable: reenableInstructions(job) },
        });
      } catch (err) {
        console.warn(`[PollingAlert] Failed to write ${event} audit row for ${job.key}:`, err instanceof Error ? err.message : err);
      }
    }

    if (!recipient) {
      if (newEvent) {
        console.warn(`[PollingAlert] ${job.key} auto-disabled but BIDBOARD_CRM_ALERT_RECIPIENT is empty — no email; see the audit row`);
      }
      return { newEvent, disabledAt, persisted, alert: "no_recipient" };
    }

    if (!newEvent && !withinResendWindow(disabledAt, deps)) {
      return { newEvent, disabledAt, persisted, alert: "too_old" };
    }

    const dedupeKey = `${persisted ? "polling_auto_disabled" : "polling_auto_disable_not_saved"}:${job.key}:${disabledAt}`;
    if (inFlight.has(dedupeKey) || delivered.has(dedupeKey) || (await storage.checkEmailDedupeKey(dedupeKey))) {
      return { newEvent, disabledAt, persisted, alert: "already_sent" };
    }

    const { subject, htmlBody } = renderPollingDisabledEmail({ job, disabledAt, error: args.error, persisted });
    const send: SendEmail = deps.send ?? (await import("./email-service")).sendEmail;
    let sent = false;
    inFlight.add(dedupeKey);
    try {
      // Ops alert → only the configured recipient; skip the customer-facing GLOBAL_CC.
      const res = await send({ to: recipient, subject, htmlBody, bypassGlobalCc: true, fromName: "T-Rock Sync Hub Alerts" });
      sent = Boolean(res?.success);
    } catch (err) {
      console.error(`[PollingAlert] ${job.key} alert email send FAILED:`, err instanceof Error ? err.message : err);
    } finally {
      if (sent) delivered.add(dedupeKey);
      inFlight.delete(dedupeKey);
    }
    if (!sent) return { newEvent, disabledAt, persisted, alert: "send_failed" };

    // DELIVERED from here on. A failure to bank the dedupe row is not a failed send: retrying would email the recipient
    // again. It is logged instead; this process remembers the delivery, so only a restart's boot check could send one
    // more copy.
    let banked = false;
    for (let i = 0; i < PERSIST_ATTEMPTS && !banked; i++) {
      try {
        await storage.createEmailSendLog({
          templateKey: "polling_auto_disabled_alert",
          recipientEmail: recipient,
          subject,
          dedupeKey,
          status: "sent",
          metadata: { job: job.key, disabledAt, persisted },
        });
        banked = true;
      } catch (err) {
        console.warn(`[PollingAlert] ${job.key} alert delivered but its send log failed (attempt ${i + 1}):`, err instanceof Error ? err.message : err);
      }
    }
    if (!banked) console.error(`[PollingAlert] ${job.key} alert delivered but never logged; a restart may send it once more`);
    console.log(`[PollingAlert] ${job.key} auto-disable alert email sent (disabledAt=${disabledAt}, persisted=${persisted})`);
    return { newEvent, disabledAt, persisted, alert: "sent" };
  } catch (err) {
    try {
      console.error(`[PollingAlert] auth-expiry handling failed for ${job.key}:`, err instanceof Error ? err.message : err);
    } catch {
      /* no-op */
    }
    return { newEvent, disabledAt, persisted, alert: "send_failed" };
  }
}
