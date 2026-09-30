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
//    job + disabledAt, and banked only after a SUCCESSFUL send.
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
}): { subject: string; htmlBody: string } {
  return {
    subject: `⚠️ SyncHub ${e.job.slug === "procore" ? "Procore" : "HubSpot"} polling DISABLED (auth expired) — mirrors are going stale`,
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
}

export interface PollingAuthExpiryResult {
  newEvent: boolean;
  disabledAt: string;
  alert: "sent" | "already_sent" | "no_recipient" | "send_failed";
}

export async function recordPollingAuthExpiry(
  args: { job: PollingJobKey; error: string },
  deps: PollingAuthExpiryDeps = {},
): Promise<PollingAuthExpiryResult> {
  const job = pollingJobByKey(args.job);
  const now = (deps.now ?? (() => new Date()))();
  let disabledAt = now.toISOString();
  let newEvent = true;

  try {
    let prior: any = null;
    try {
      prior = (await storage.getAutomationConfig(job.key))?.value ?? null;
    } catch (err) {
      console.warn(`[PollingAlert] Could not read ${job.key} before disabling:`, err instanceof Error ? err.message : err);
    }

    const alreadyDisabledForAuth =
      prior != null &&
      typeof prior === "object" &&
      prior.enabled !== true &&
      prior.disabledReason === "auth_expired" &&
      typeof prior.disabledAt === "string" &&
      prior.disabledAt !== "";

    if (alreadyDisabledForAuth) {
      newEvent = false;
      disabledAt = prior.disabledAt;
    } else {
      const priorInterval = Number(prior?.intervalMinutes);
      try {
        await storage.upsertAutomationConfig({
          key: job.key,
          value: {
            enabled: false,
            intervalMinutes: Number.isFinite(priorInterval) && priorInterval > 0 ? priorInterval : job.defaultIntervalMinutes,
            disabledReason: "auth_expired",
            disabledAt,
          },
          description: job.description,
        });
      } catch (err) {
        console.warn(`[PollingAlert] Failed to persist ${job.key} disable on auth expiry:`, err instanceof Error ? err.message : err);
      }
    }

    const recipient = deps.recipient !== undefined ? deps.recipient : recipientFromEnv();

    if (newEvent) {
      // The structured log and the audit row are written for EVERY new event: they are the record, and
      // with no recipient configured they are the whole alert.
      console.error(
        JSON.stringify({
          level: "error",
          event: "polling_auto_disabled",
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
          action: "polling_auto_disabled",
          entityType: job.key,
          source: "polling",
          status: "error",
          category: "system",
          errorMessage: args.error,
          details: { job: job.key, reason: "auth_expired", disabledAt, reenable: reenableInstructions(job) },
        });
      } catch (err) {
        console.warn(`[PollingAlert] Failed to write polling_auto_disabled audit row for ${job.key}:`, err instanceof Error ? err.message : err);
      }
    }

    if (!recipient) {
      if (newEvent) {
        console.warn(`[PollingAlert] ${job.key} auto-disabled but BIDBOARD_CRM_ALERT_RECIPIENT is empty — no email; see the audit row`);
      }
      return { newEvent, disabledAt, alert: "no_recipient" };
    }

    const dedupeKey = `polling_auto_disabled:${job.key}:${disabledAt}`;
    if (await storage.checkEmailDedupeKey(dedupeKey)) {
      return { newEvent, disabledAt, alert: "already_sent" };
    }

    const { subject, htmlBody } = renderPollingDisabledEmail({ job, disabledAt, error: args.error });
    const send: SendEmail = deps.send ?? (await import("./email-service")).sendEmail;
    let sent = false;
    try {
      // Ops alert → only the configured recipient; skip the customer-facing GLOBAL_CC.
      const res = await send({ to: recipient, subject, htmlBody, bypassGlobalCc: true, fromName: "T-Rock Sync Hub Alerts" });
      sent = Boolean(res?.success);
    } catch (err) {
      console.error(`[PollingAlert] ${job.key} alert email send FAILED:`, err instanceof Error ? err.message : err);
    }
    if (!sent) return { newEvent, disabledAt, alert: "send_failed" };

    await storage.createEmailSendLog({
      templateKey: "polling_auto_disabled_alert",
      recipientEmail: recipient,
      subject,
      dedupeKey,
      status: "sent",
      metadata: { job: job.key, disabledAt },
    });
    console.log(`[PollingAlert] ${job.key} auto-disable alert email sent (disabledAt=${disabledAt})`);
    return { newEvent, disabledAt, alert: "sent" };
  } catch (err) {
    try {
      console.error(`[PollingAlert] auth-expiry handling failed for ${job.key}:`, err instanceof Error ? err.message : err);
    } catch {
      /* no-op */
    }
    return { newEvent, disabledAt, alert: "send_failed" };
  }
}
