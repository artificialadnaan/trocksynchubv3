import { sql, type SQL } from "drizzle-orm";
import {
  FAILED_IDS_MAX,
  isoOrNull,
  safeCode,
  safeMessage,
  SNAPSHOT_SCHEMA,
  validateSnapshot,
  type DeliveryMeasure,
  type HealthError,
  type Snapshot,
  type SnapshotConnection,
} from "./snapshot-contract";

/**
 * SYNCHUB'S HEALTH SNAPSHOT (integration-health S2; CONTRACT r1 + ADDENDUM-1..-4; plan
 * lanes/integration-health/S2-SYNCHUB-SNAPSHOT-PLAN.r1.md). MEASUREMENTS only: T-Rock Core judges Healthy / Degraded /
 * Failed. Every read runs in ONE read-only transaction with a 5 s statement timeout, so the request path writes nothing and a
 * slow table can't hold it. Timestamps are formatted in SQL (UTC, the stored `timestamp` columns' convention), and `null`
 * ("not measured") is never written as `0` ("measured zero").
 *
 * No secret is ever selected: an OAuth row's token presence is a boolean computed in SQL, a review link's token is compared in
 * SQL only, and every stored error text goes through the contract's safeMessage on the way out.
 *
 * Not emitted (ADDENDUM-4, #136, #137; Core lists them as Retired): synchub.outbox.bidboard_create, synchub.rfp.bidboard_create
 * and synchub.bidboard.crm_push (the Bid Board → CRM push ran only inside the retired stage sync).
 */

const ISO = "YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"";
/** A `timestamp` (stored as UTC wall-clock, like every NOW() default here) as ISO text. */
const iso = (col: string) => sql.raw(`to_char(${col}, '${ISO}')`);
/** A `timestamptz` as ISO text. */
const isoTz = (col: string) => sql.raw(`to_char((${col}) AT TIME ZONE 'UTC', '${ISO}')`);
const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * #136's DEPLOY INSTANT (2026-11-13T22:55:42Z, UTC wall-clock like the stored `timestamp` columns): from here the approval
 * itself enqueues the CRM `approved` callback (d9, 11-14). A request approved before it is the reconcile's
 * (scripts/rfp-reconcile-approved-callbacks.ts), never pending on this leg.
 */
export const CRM_CALLBACK_SINCE = "2026-11-13 22:55:42";
export const CRM_CALLBACK_SINCE_ISO = "2026-11-13T22:55:42.000Z";
/**
 * The first live service hand-off; #74 shipped it inert 2026-08-28 (no row while SERVICE_RFP_INGRESS_SECRET_CURRENT /
 * CORE_INGRESS_BASE_URL were unset); provisioning turned it on (d9, 11-14). The service-handover leg counts approvals from
 * here, never from the outbox's own rows: an empty outbox would hide every approval, and since #137 the approval is written
 * before its hand-off row (before it, after), so the earliest row can post-date its own approval.
 */
export const SERVICE_HANDOFF_LIVE_AT = "2026-08-31T18:13:20.711Z";
/** trockcrm-relay.ts MAX_ATTEMPTS. */
export const RELAY_MAX_ATTEMPTS = 20;
/** procore-token-keepalive.ts: every 10 minutes. */
const PROCORE_KEEPALIVE_SECONDS = 600;
const RECORD_LIMIT = 20;

const TABLES = [
  "automation_config",
  "email_send_log",
  "rfp_approval_requests",
  "rfp_core_create_outbox",
  "rfp_core_followup_outbox",
  "service_rfp_core_outbox",
  "bidboard_callback_outbox",
  "trockcrm_relay_outbox",
  "oauth_tokens",
  "procore_login_alert_state",
] as const;
type Table = (typeof TABLES)[number];

type Querier = { execute(query: SQL): Promise<unknown> };

function rowsOf(result: unknown): any[] {
  return Array.isArray(result) ? result : ((result as any)?.rows ?? []);
}

async function rows(q: Querier, query: SQL): Promise<any[]> {
  return rowsOf(await q.execute(query));
}

async function one(q: Querier, query: SQL): Promise<any> {
  return (await rows(q, query))[0] ?? {};
}

/**
 * ADDENDUM-5 (owner e69e6f71): the stable ids of EVERY failed item, the same ids as records[].id, so Core can alert on a new
 * failed id even when the total is flat. Capped at FAILED_IDS_MAX (lowest ids first); `total` is the true count, reported
 * beside it, so a truncated list can never pass for a complete one.
 */
async function failedIdSet(q: Querier, idQuery: SQL): Promise<{ ids: string[]; total: number }> {
  const found = await rows(
    q,
    sql`SELECT id, (count(*) OVER ())::int AS total FROM (${idQuery}) failed ORDER BY id ASC LIMIT ${FAILED_IDS_MAX}`,
  );
  return { ids: found.map((r) => String(r.id)), total: found.length > 0 ? Number(found[0].total) : 0 };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** An `extra` key in the contract's form: lower-case, [a-z0-9_.:-], ≤ 60. */
function extraKey(prefix: string, raw: string): string {
  return `${prefix}${raw.toLowerCase().replace(/[^a-z0-9_.:-]/g, "_")}`.slice(0, 60);
}

/** An `extra` string value in the contract's form, or null. */
function extraText(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : "";
  return s !== "" && s.length <= 60 && /^[A-Za-z0-9_.:-]*$/.test(s) ? s : null;
}

/** SyncHub's own settings screen, when APP_URL is an https origin. */
function settingsUrl(env: NodeJS.ProcessEnv): string | null {
  try {
    const url = new URL(env.APP_URL ?? "");
    return url.protocol === "https:" ? `${url.origin}/settings` : null;
  } catch {
    return null;
  }
}

function base(
  key: string,
  label: string,
  peer: string,
  direction: SnapshotConnection["direction"],
  purpose: string,
  impact: string,
): SnapshotConnection {
  return {
    key,
    label,
    peer,
    direction,
    purpose,
    impact,
    paused: null,
    connection: { credential_present: null, expires_at: null, last_auth_ok_at: null, last_auth_error: null },
    processing: { last_attempt_at: null, last_success_at: null, cadence_seconds: null, next_run_at: null, last_error: null },
    delivery: [],
    records: [],
    correction_url: null,
    extra: {},
  };
}

const noDelivery = (): DeliveryMeasure => ({
  direction: "out",
  pending: null,
  oldest_pending_at: null,
  failed_24h: null,
  failed_7d: null,
  exhausted: null,
  last_delivered_at: null,
});

function storedError(raw: unknown): HealthError | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { code?: unknown; at?: unknown; message_safe?: unknown };
  return {
    code: safeCode(typeof e.code === "string" ? e.code : null, "refresh_failed"),
    at: isoOrNull(typeof e.at === "string" ? e.at : null),
    message_safe: safeMessage(typeof e.message_safe === "string" ? e.message_safe : null),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mail: the two mailboxes and what was sent
// ---------------------------------------------------------------------------------------------------------------------

async function collectMail(q: Querier, env: NodeJS.ProcessEnv, installed: Record<Table, boolean>): Promise<SnapshotConnection[]> {
  const outlook = base(
    "synchub.mail.outlook",
    "SyncHub outgoing mail (Outlook)",
    "microsoft-graph",
    "outbound",
    "Sends RFP-approval, stage and alert emails",
    "Approvers get no RFP review links; SyncHub's own alerts don't arrive",
  );
  const gmail = base(
    "synchub.mail.gmail",
    "SyncHub fallback mail (Gmail)",
    "gmail",
    "outbound",
    "Fallback sender when Outlook is down",
    "No fallback when Outlook fails",
  );
  const delivery = base(
    "synchub.mail.delivery",
    "SyncHub email delivery",
    "email",
    "outbound",
    "Every email SyncHub sends, by result",
    "Emails SyncHub should have sent did not go out",
  );
  const correction = settingsUrl(env);
  outlook.correction_url = correction;
  gmail.correction_url = correction;

  // automation_config: the token rows yield booleans and an expiry only; their tokens are never selected.
  const config = new Map<string, any>();
  if (installed.automation_config) {
    for (const row of await rows(
      q,
      sql`
        SELECT key,
               ${iso("updated_at")} AS updated_at,
               CASE WHEN key IN ('microsoft_oauth', 'gmail_oauth') THEN COALESCE(value ->> 'refreshToken', '') <> '' END AS credential_present,
               CASE WHEN key IN ('microsoft_oauth', 'gmail_oauth') AND jsonb_typeof(value -> 'expiresAt') = 'number'
                    THEN (value ->> 'expiresAt')::numeric END AS expires_ms,
               CASE WHEN key = 'email_config' THEN value ->> 'activeProvider' END AS active_provider,
               CASE WHEN key = 'testing_mode' THEN (value -> 'enabled') = 'true'::jsonb END AS testing_enabled,
               CASE WHEN key = 'mail_auth_health' THEN value END AS auth_health
          FROM automation_config
         WHERE key IN ('microsoft_oauth', 'gmail_oauth', 'email_config', 'testing_mode', 'mail_auth_health')
      `,
    )) {
      config.set(row.key, row);
    }
  }
  // email-service.ts getEmailConfig: Gmail unless email_config says otherwise.
  const activeProvider = text(config.get("email_config")?.active_provider) === "outlook" ? "outlook" : "gmail";
  const health = (config.get("mail_auth_health")?.auth_health ?? {}) as Record<string, any>;

  let sends: any = {};
  let lastFailure: any = null;
  let byTemplate: any[] = [];
  if (installed.email_send_log) {
    sends = await one(
      q,
      sql`
        SELECT count(*) FILTER (WHERE status = 'failed' AND sent_at > NOW() - interval '24 hours')::int AS failed_24h,
               count(*) FILTER (WHERE status = 'failed' AND sent_at > NOW() - interval '7 days')::int AS failed_7d,
               count(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - interval '24 hours')::int AS sent_24h,
               ${iso("max(sent_at) FILTER (WHERE status IN ('sent', 'failed'))")} AS last_attempt_at,
               ${iso("max(sent_at) FILTER (WHERE status = 'sent')")} AS last_success_at
          FROM email_send_log
      `,
    );
    lastFailure = (
      await rows(
        q,
        sql`SELECT ${iso("sent_at")} AS failed_at, error_message FROM email_send_log WHERE status = 'failed' ORDER BY sent_at DESC NULLS LAST, id DESC LIMIT 1`,
      )
    )[0] ?? null;
    byTemplate = await rows(
      q,
      sql`
        SELECT template_key, count(*)::int AS n
          FROM email_send_log
         WHERE status = 'failed' AND sent_at > NOW() - interval '7 days'
         GROUP BY template_key
         ORDER BY n DESC, template_key
         LIMIT 15
      `,
    );
  }

  for (const [connection, key, provider] of [
    [outlook, "microsoft_oauth", "outlook"],
    [gmail, "gmail_oauth", "gmail"],
  ] as const) {
    const row = config.get(key);
    const present = row ? row.credential_present === true : installed.automation_config ? false : null;
    const record = (health[provider] ?? {}) as { last_ok_at?: unknown; last_error?: unknown };
    const recordedOk = isoOrNull(typeof record.last_ok_at === "string" ? record.last_ok_at : null);
    connection.connection = {
      credential_present: present,
      expires_at: row?.expires_ms === null || row?.expires_ms === undefined ? null : isoOrNull(Number(row.expires_ms)),
      // ADDENDUM-1 #1: the recorded refresh success; before the first record, the token row's own write time.
      last_auth_ok_at: recordedOk ?? (present ? isoOrNull(row?.updated_at) : null),
      last_auth_error: storedError(record.last_error),
    };
    const active = activeProvider === provider;
    // Sends go through the active provider, so only its row carries the send log's times (ADDENDUM-1 #4).
    if (active && installed.email_send_log) {
      connection.processing.last_attempt_at = text(sends.last_attempt_at);
      connection.processing.last_success_at = text(sends.last_success_at);
    }
    connection.extra = {
      active,
      active_provider: activeProvider,
      auth_ok_source: recordedOk ? "mail_auth_health" : present ? "automation_config.updated_at" : null,
      // Where processing's times come from: the send log, which doesn't record the provider (only the active one sends).
      send_times: "email_send_log_active_provider",
    };
  }

  if (installed.email_send_log) {
    delivery.delivery = [
      {
        direction: "out",
        pending: null, // sends are synchronous: there is no queue to measure
        oldest_pending_at: null,
        failed_24h: num(sends.failed_24h),
        failed_7d: num(sends.failed_7d),
        exhausted: null,
        last_delivered_at: text(sends.last_success_at),
      },
    ];
    delivery.processing.last_attempt_at = text(sends.last_attempt_at);
    delivery.processing.last_success_at = text(sends.last_success_at);
    delivery.processing.last_error = lastFailure
      ? { code: "send_failed", at: text(lastFailure.failed_at), message_safe: safeMessage(lastFailure.error_message) }
      : null;
    const extra: SnapshotConnection["extra"] = { sent_24h: num(sends.sent_24h) };
    for (const t of byTemplate) extra[extraKey("failed_7d.", String(t.template_key ?? ""))] = num(t.n);
    delivery.extra = extra;
  } else {
    delivery.delivery = [noDelivery()];
    delivery.extra = { installed: false };
  }
  // Testing mode redirects every email to one test address: a deliberate switch-off of real delivery.
  const testing = config.get("testing_mode");
  if (testing?.testing_enabled === true) delivery.paused = { reason: "testing_mode", since: isoOrNull(testing.updated_at) };

  return [outlook, gmail, delivery];
}

// ---------------------------------------------------------------------------------------------------------------------
// RFP approval requests waiting on a reviewer
// ---------------------------------------------------------------------------------------------------------------------

async function collectApprovals(q: Querier, installed: Record<Table, boolean>): Promise<SnapshotConnection> {
  const c = base(
    "synchub.rfp.approvals",
    "RFP approval requests",
    "approvers",
    "outbound",
    "RFP review links waiting on an approver",
    "RFPs wait unreviewed and their links expire",
  );
  if (!installed.rfp_approval_requests) {
    c.delivery = [noDelivery()];
    c.extra = { installed: false };
    return c;
  }
  // A request "has an email" when a review email to it was SENT: the token is compared here, in SQL, and never read out.
  const emailed = installed.email_send_log
    ? sql`EXISTS (SELECT 1 FROM email_send_log l WHERE l.template_key = 'rfp_review' AND l.status = 'sent' AND l.metadata ->> 'token' = r.token)`
    : sql`FALSE`;
  const s = await one(
    q,
    sql`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
             ${iso("min(created_at) FILTER (WHERE status = 'pending')")} AS oldest_pending_at,
             count(*) FILTER (WHERE status = 'pending' AND token_expires_at > NOW() AND token_expires_at <= NOW() + interval '48 hours')::int AS expiring_48h,
             count(*) FILTER (WHERE status = 'pending' AND token_expires_at <= NOW())::int AS expired_pending,
             count(*) FILTER (WHERE status = 'pending' AND NOT ${emailed})::int AS no_email_sent,
             count(*) FILTER (WHERE status IN ('approving', 'override_approving'))::int AS approving,
             count(*) FILTER (WHERE status = 'held_cross_destination')::int AS held,
             ${iso("GREATEST(max(approved_at), max(declined_at))")} AS last_decided_at,
             ${iso("max(created_at)")} AS last_created_at
        FROM rfp_approval_requests r
    `,
  );
  c.delivery = [
    {
      direction: "out",
      pending: num(s.pending),
      oldest_pending_at: text(s.oldest_pending_at),
      failed_24h: null,
      failed_7d: null,
      exhausted: null,
      last_delivered_at: text(s.last_decided_at),
    },
  ];
  c.processing.last_attempt_at = text(s.last_created_at);
  c.processing.last_success_at = text(s.last_decided_at);
  // Requests mid-approval or held for a person are on no other row: counted here so they never drop out of sight.
  c.extra = {
    no_email_sent: num(s.no_email_sent),
    expiring_48h: num(s.expiring_48h),
    expired_pending: num(s.expired_pending),
    approving: num(s.approving),
    held: num(s.held),
  };
  c.records = (
    await rows(
      q,
      sql`
        SELECT r.id::text AS id,
               CASE WHEN r.token_expires_at <= NOW() THEN 'pending:expired'
                    WHEN NOT ${emailed} THEN 'pending:no_email'
                    ELSE 'pending' END AS state
          FROM rfp_approval_requests r
         WHERE r.status = 'pending'
         ORDER BY r.created_at ASC NULLS LAST, r.id ASC
         LIMIT ${RECORD_LIMIT}
      `,
    )
  ).map((r) => ({ kind: "rfp_approval_request", id: String(r.id), state: String(r.state), url: null }));
  return c;
}

// ---------------------------------------------------------------------------------------------------------------------
// Outboxes (ADDENDUM-1 #6): pending = queued + retrying; failed = failed + dead + needs_manual, windowed on the last attempt
// ---------------------------------------------------------------------------------------------------------------------

interface OutboxSpec {
  key: string;
  table: Table;
  label: string;
  peer: string;
  purpose: string;
  impact: string;
  kind: string;
  pending: readonly string[];
  delivered: readonly string[];
  failed: readonly string[];
  /** The attempts column and the ceiling (a column, or a number for an outbox without one). */
  attempts: string;
  max: string | number;
  /** Whether its failures are individually identifiable (ADDENDUM-5): then every failed row id is reported. */
  failedIds?: boolean;
}

export const OUTBOXES: readonly OutboxSpec[] = [
  {
    key: "synchub.outbox.rfp_core_create",
    table: "rfp_core_create_outbox",
    label: "SyncHub → Core RFP create",
    peer: "trock-core",
    purpose: "Creates the Core bid for an approved RFP",
    impact: "Approved RFPs don't reach Core",
    kind: "rfp_core_create",
    pending: ["pending", "sending"],
    delivered: ["sent"],
    // held_cross_destination: the deal already has the other destination's footprint; a person resolves it.
    failed: ["failed", "dead", "refused", "held_cross_destination"],
    failedIds: true,
    attempts: "attempt_count",
    max: "max_attempts",
  },
  {
    key: "synchub.outbox.rfp_core_followup",
    table: "rfp_core_followup_outbox",
    label: "SyncHub RFP follow-ups (CRM link, Core confirm, notices)",
    peer: "trock-crm",
    purpose: "Links the CRM deal to its Core bid and confirms it",
    impact: "CRM deals and Core bids stay unlinked",
    kind: "rfp_core_followup",
    pending: ["pending", "sending"],
    delivered: ["sent"],
    // link_refused: the CRM refused the link; never requeued, a person resolves it (rfp-requeue-dead.ts).
    failed: ["failed", "dead", "orphan_stale", "link_refused"],
    failedIds: true,
    attempts: "attempt_count",
    max: "max_attempts",
  },
  {
    key: "synchub.outbox.service_rfp_core",
    table: "service_rfp_core_outbox",
    label: "SyncHub → Core service RFP hand-off",
    peer: "trock-core",
    purpose: "Hands an approved service RFP to Core as a card",
    impact: "Approved service RFPs never become Core cards",
    kind: "service_rfp_core",
    pending: ["pending"],
    delivered: ["sent", "crm_notify_accepted"],
    failed: ["failed", "dead", "crm_notify_refused"],
    attempts: "attempt_count",
    max: "max_attempts",
  },
  {
    key: "synchub.outbox.bidboard_callback",
    table: "bidboard_callback_outbox",
    label: "SyncHub → CRM RFP outcome callback",
    peer: "trock-crm",
    purpose: "Tells the CRM an RFP was approved",
    impact: "The CRM never learns its RFP was approved",
    kind: "bidboard_callback",
    pending: ["pending"],
    delivered: ["sent"],
    failed: ["failed", "dead"],
    attempts: "attempt_count",
    max: "max_attempts",
  },
  {
    key: "synchub.relay.trockcrm",
    table: "trockcrm_relay_outbox",
    label: "SyncHub → CRM relay",
    peer: "trock-crm",
    purpose: "Relays Bid Board and RFP events to the CRM",
    impact: "The CRM misses Bid Board and RFP events",
    kind: "trockcrm_relay",
    // trockcrm-relay.ts: 'failed' is held for retry (next_retry_at), 'abandoned' is the ceiling.
    pending: ["pending", "processing", "failed"],
    delivered: ["sent"],
    failed: ["failed", "abandoned"],
    attempts: "attempts",
    max: RELAY_MAX_ATTEMPTS,
  },
];

async function collectOutbox(q: Querier, spec: OutboxSpec, env: NodeJS.ProcessEnv, installed: Record<Table, boolean>): Promise<SnapshotConnection> {
  const c = base(spec.key, spec.label, spec.peer, "outbound", spec.purpose, spec.impact);
  if (spec.table === "trockcrm_relay_outbox" && env.TROCKCRM_RELAY_ENABLED === "false") {
    c.paused = { reason: "flag TROCKCRM_RELAY_ENABLED=false", since: null };
  }
  if (!installed[spec.table]) {
    c.delivery = [noDelivery()];
    c.extra = { installed: false };
    return c;
  }
  const t = sql.raw(spec.table);
  const attempts = sql.raw(spec.attempts);
  const max = typeof spec.max === "number" ? sql`${spec.max}` : sql.raw(spec.max);
  const lastAt = sql.raw("COALESCE(last_attempt_at, created_at)");
  const s = await one(
    q,
    sql`
      SELECT count(*) FILTER (WHERE status IN (${inList(spec.pending)}))::int AS pending,
             ${iso(`min(created_at) FILTER (WHERE status IN (${spec.pending.map((p) => `'${p}'`).join(", ")}))`)} AS oldest_pending_at,
             count(*) FILTER (WHERE status IN (${inList(spec.failed)}) AND ${lastAt} > NOW() - interval '24 hours')::int AS failed_24h,
             count(*) FILTER (WHERE status IN (${inList(spec.failed)}) AND ${lastAt} > NOW() - interval '7 days')::int AS failed_7d,
             count(*) FILTER (WHERE ${attempts} >= ${max} AND status NOT IN (${inList(spec.delivered)}))::int AS exhausted,
             ${iso(`max(sent_at) FILTER (WHERE status IN (${spec.delivered.map((d) => `'${d}'`).join(", ")}))`)} AS last_delivered_at,
             ${iso("max(last_attempt_at)")} AS last_attempt_at
        FROM ${t}
    `,
  );
  c.delivery = [
    {
      direction: "out",
      pending: num(s.pending),
      oldest_pending_at: text(s.oldest_pending_at),
      failed_24h: num(s.failed_24h),
      failed_7d: num(s.failed_7d),
      exhausted: num(s.exhausted),
      last_delivered_at: text(s.last_delivered_at),
    },
  ];
  c.processing.last_attempt_at = text(s.last_attempt_at);
  c.processing.last_success_at = text(s.last_delivered_at);
  const failure = (
    await rows(
      q,
      sql`
        SELECT status, ${iso("COALESCE(last_attempt_at, created_at)")} AS failed_at, last_error
          FROM ${t}
         WHERE status IN (${inList(spec.failed)})
         ORDER BY ${lastAt} DESC NULLS LAST, id DESC
         LIMIT 1
      `,
    )
  )[0];
  c.processing.last_error = failure
    ? { code: safeCode(failure.status, "failed"), at: text(failure.failed_at), message_safe: safeMessage(failure.last_error) }
    : null;

  const extra: SnapshotConnection["extra"] = {};
  for (const r of await rows(q, sql`SELECT status, count(*)::int AS n FROM ${t} GROUP BY status ORDER BY status LIMIT 19`)) {
    extra[extraKey("status.", String(r.status ?? ""))] = num(r.n);
  }
  c.extra = extra;
  c.records = (
    await rows(
      q,
      sql`
        SELECT id::text AS id, status
          FROM ${t}
         WHERE (status IN (${inList(spec.failed)}) AND ${lastAt} > NOW() - interval '7 days')
            OR status IN (${inList(spec.pending)})
         ORDER BY (status IN (${inList(spec.failed)})) DESC, created_at ASC NULLS LAST, id ASC
         LIMIT ${RECORD_LIMIT}
      `,
    )
  ).map((r) => ({ kind: spec.kind, id: String(r.id), state: safeCode(r.status, "unknown"), url: null }));
  if (spec.failedIds) {
    // Every row still in a failure status, however old: it waits until a person or a re-arm moves it.
    const failed = await failedIdSet(q, sql`SELECT id FROM ${t} WHERE status IN (${inList(spec.failed)})`);
    c.failed_ids = failed.ids;
    c.extra = { ...c.extra, failed_total: failed.total };
  }
  return c;
}

// ---------------------------------------------------------------------------------------------------------------------
// Procore: the shared API token and the browser sign-in
// ---------------------------------------------------------------------------------------------------------------------

async function collectProcore(q: Querier, env: NodeJS.ProcessEnv, installed: Record<Table, boolean>): Promise<SnapshotConnection[]> {
  const token = base(
    "synchub.procore.token",
    "Procore sign-in (SyncHub)",
    "procore",
    "pull",
    "The Procore token Core's WIP pull and SyncHub use",
    "Procore reads stop, including Core's WIP pull",
  );
  token.correction_url = settingsUrl(env);
  token.processing.cadence_seconds = PROCORE_KEEPALIVE_SECONDS;
  if (installed.oauth_tokens) {
    const row = (
      await rows(
        q,
        sql`
          SELECT (refresh_token IS NOT NULL AND refresh_token <> '') AS credential_present,
                 ${iso("expires_at")} AS expires_at,
                 ${iso("updated_at")} AS updated_at
            FROM oauth_tokens
           WHERE provider = 'procore'
        `,
      )
    )[0];
    token.connection = {
      credential_present: row ? row.credential_present === true : false,
      expires_at: text(row?.expires_at),
      // ADDENDUM-1 #5: the token row's write time is the last successful refresh; the keepalive's own success is in memory only.
      last_auth_ok_at: text(row?.updated_at),
      last_auth_error: null,
    };
    token.extra = { auth_ok_source: "oauth_tokens.updated_at" };
  } else {
    token.extra = { installed: false };
  }

  const browser = base(
    "synchub.procore.browser_login",
    "Procore browser sign-in (SyncHub)",
    "procore",
    "pull",
    "The Procore browser session SyncHub's Playwright automations use",
    "Browser-driven Procore work stops",
  );
  browser.correction_url = settingsUrl(env);
  if (installed.procore_login_alert_state) {
    const states = new Map<string, any>();
    for (const row of await rows(
      q,
      sql`
        SELECT scope, state, last_reason, last_error,
               ${isoTz("last_success_at")} AS last_success_at,
               ${isoTz("updated_at")} AS updated_at
          FROM procore_login_alert_state
         WHERE scope IN ('procore-browser-login', 'procore-bidboard-export-page')
      `,
    )) {
      states.set(row.scope, row);
    }
    const login = states.get("procore-browser-login");
    const failing = login?.state === "failing";
    browser.connection = {
      credential_present: null, // the browser password is not read here
      expires_at: null,
      last_auth_ok_at: text(login?.last_success_at),
      last_auth_error: failing
        ? { code: safeCode(login.last_reason, "login_failed"), at: text(login.updated_at), message_safe: safeMessage(login.last_error) }
        : null,
    };
    browser.extra = {
      state: extraText(login?.state) ?? null,
      export_page_failing: states.get("procore-bidboard-export-page")?.state === "failing",
    };
  } else {
    browser.extra = { installed: false };
  }
  return [token, browser];
}

// ---------------------------------------------------------------------------------------------------------------------
// ADDENDUM-3: each leg of an approved RFP, measured from the approval (a leg that never enqueued anything still counts)
// ---------------------------------------------------------------------------------------------------------------------

async function collectLegs(q: Querier, installed: Record<Table, boolean>): Promise<SnapshotConnection[]> {
  const handover = base(
    "synchub.rfp.service_handover",
    "Approved service RFP → Core card",
    "trock-core",
    "outbound",
    "Each approved service RFP becomes a Core card",
    "An approved service RFP has no Core card",
  );
  const callback = base(
    "synchub.rfp.crm_callback",
    "Approved RFP → CRM told",
    "trock-crm",
    "outbound",
    "The CRM is told each of its RFPs was approved",
    "The CRM deal never shows its RFP as approved",
  );

  if (installed.rfp_approval_requests && installed.service_rfp_core_outbox) {
    // From the first live hand-off (SERVICE_HANDOFF_LIVE_AT): approvals before it could not have one.
    const match = sql.raw("o.source_system = r.source_system AND o.source_deal_id = r.source_deal_id AND o.rfp_request_id = r.id");
    const legs = sql`
      WITH reqs AS (
        SELECT r.id, r.approved_at,
               (SELECT o.status FROM service_rfp_core_outbox o WHERE ${match} ORDER BY o.id DESC LIMIT 1) AS leg_status,
               (SELECT max(o.sent_at) FROM service_rfp_core_outbox o
                 WHERE ${match} AND o.status IN ('sent', 'crm_notify_accepted') AND o.core_bid_id IS NOT NULL) AS confirmed_at,
               (SELECT max(COALESCE(o.last_attempt_at, o.created_at)) FROM service_rfp_core_outbox o
                 WHERE ${match} AND o.status IN ('failed', 'dead', 'crm_notify_refused')) AS failed_at,
               EXISTS (SELECT 1 FROM service_rfp_core_outbox o
                        WHERE ${match} AND o.status IN ('sent', 'crm_notify_accepted') AND o.core_bid_id IS NOT NULL) AS confirmed
          FROM rfp_approval_requests r
         -- A Z-suffixed literal cast to timestamp keeps its UTC wall-clock, the stored columns' convention.
         WHERE r.status = 'approved' AND r.approved_at IS NOT NULL AND r.approved_at >= ${SERVICE_HANDOFF_LIVE_AT}::timestamp
           AND (split_part(r.project_number, '-', 2) = '4' OR EXISTS (SELECT 1 FROM service_rfp_core_outbox o WHERE ${match}))
      )
    `;
    const s = await one(
      q,
      sql`
        ${legs}
        SELECT count(*) FILTER (WHERE NOT confirmed)::int AS pending,
               ${iso("min(approved_at) FILTER (WHERE NOT confirmed)")} AS oldest_pending_at,
               count(*) FILTER (WHERE NOT confirmed AND failed_at > NOW() - interval '24 hours')::int AS failed_24h,
               count(*) FILTER (WHERE NOT confirmed AND failed_at > NOW() - interval '7 days')::int AS failed_7d,
               count(*) FILTER (WHERE NOT confirmed AND leg_status IS NULL)::int AS not_enqueued,
               ${iso("max(confirmed_at)")} AS last_delivered_at
          FROM reqs
      `,
    );
    handover.delivery = [
      {
        direction: "out",
        pending: num(s.pending),
        oldest_pending_at: text(s.oldest_pending_at),
        failed_24h: num(s.failed_24h),
        failed_7d: num(s.failed_7d),
        exhausted: null,
        last_delivered_at: text(s.last_delivered_at),
      },
    ];
    handover.processing.last_success_at = text(s.last_delivered_at);
    // The failing set: unconfirmed requests whose hand-off reached a failure status (the failed_24h / 7d population, unwindowed).
    const failed = await failedIdSet(q, sql`${legs} SELECT id FROM reqs WHERE NOT confirmed AND failed_at IS NOT NULL`);
    handover.failed_ids = failed.ids;
    handover.extra = { not_enqueued: num(s.not_enqueued), since: SERVICE_HANDOFF_LIVE_AT, failed_total: failed.total };
    handover.records = (
      await rows(
        q,
        sql`
          ${legs}
          SELECT id::text AS id, COALESCE(leg_status, 'not_enqueued') AS state
            FROM reqs WHERE NOT confirmed
           ORDER BY approved_at ASC, id ASC
           LIMIT ${RECORD_LIMIT}
        `,
      )
    ).map((r) => ({ kind: "rfp_approval_request", id: String(r.id), state: safeCode(r.state, "unknown"), url: null }));
  } else {
    handover.delivery = [noDelivery()];
    handover.extra = { installed: false };
  }

  if (installed.rfp_approval_requests && installed.bidboard_callback_outbox && installed.service_rfp_core_outbox) {
    const legs = sql`
      WITH reqs AS (
        SELECT r.id, r.approved_at, b.status AS leg_status,
               CASE WHEN b.status = 'sent' THEN b.sent_at END AS confirmed_at,
               CASE WHEN b.status IN ('failed', 'dead') THEN COALESCE(b.last_attempt_at, b.created_at) END AS failed_at
          FROM rfp_approval_requests r
          LEFT JOIN LATERAL (
            SELECT status, sent_at, last_attempt_at, created_at FROM bidboard_callback_outbox b
             WHERE b.rfp_approval_request_id = r.id ORDER BY b.id DESC LIMIT 1
          ) b ON TRUE
         WHERE r.source_system = 'trock_crm' AND r.status = 'approved' AND r.approved_at >= ${CRM_CALLBACK_SINCE}::timestamp
           -- SERVICE RFPs whose Core card is CONFIRMED, by enqueueRfpApprovedCallbackIfCoreConfirmed's exact join
           -- (sync/rfp-approved-callback.ts): only those are ever told 'approved'. A non-service approval reaches the CRM
           -- through Core's bid link, and an unconfirmed hand-off is the service_handover leg's (d9, 11-14).
           AND EXISTS (SELECT 1 FROM service_rfp_core_outbox o
                        WHERE o.source_system = r.source_system AND o.source_deal_id = r.source_deal_id AND o.rfp_request_id = r.id
                          AND o.status IN ('crm_notify_accepted', 'sent') AND o.core_bid_id IS NOT NULL)
      )
    `;
    const s = await one(
      q,
      sql`
        ${legs}
        SELECT count(*) FILTER (WHERE leg_status IS DISTINCT FROM 'sent')::int AS pending,
               ${iso("min(approved_at) FILTER (WHERE leg_status IS DISTINCT FROM 'sent')")} AS oldest_pending_at,
               count(*) FILTER (WHERE failed_at > NOW() - interval '24 hours')::int AS failed_24h,
               count(*) FILTER (WHERE failed_at > NOW() - interval '7 days')::int AS failed_7d,
               count(*) FILTER (WHERE leg_status IS NULL)::int AS not_enqueued,
               ${iso("max(confirmed_at)")} AS last_delivered_at
          FROM reqs
      `,
    );
    callback.delivery = [
      {
        direction: "out",
        pending: num(s.pending),
        oldest_pending_at: text(s.oldest_pending_at),
        failed_24h: num(s.failed_24h),
        failed_7d: num(s.failed_7d),
        exhausted: null,
        last_delivered_at: text(s.last_delivered_at),
      },
    ];
    callback.processing.last_success_at = text(s.last_delivered_at);
    // The failing set: requests whose CRM callback failed or died (the failed_24h / 7d population, unwindowed).
    const failed = await failedIdSet(q, sql`${legs} SELECT id FROM reqs WHERE failed_at IS NOT NULL`);
    callback.failed_ids = failed.ids;
    callback.extra = { not_enqueued: num(s.not_enqueued), since: CRM_CALLBACK_SINCE_ISO, failed_total: failed.total };
    callback.records = (
      await rows(
        q,
        sql`
          ${legs}
          SELECT id::text AS id, COALESCE(leg_status, 'not_enqueued') AS state
            FROM reqs WHERE leg_status IS DISTINCT FROM 'sent'
           ORDER BY approved_at ASC, id ASC
           LIMIT ${RECORD_LIMIT}
        `,
      )
    ).map((r) => ({ kind: "rfp_approval_request", id: String(r.id), state: safeCode(r.state, "unknown"), url: null }));
  } else {
    callback.delivery = [noDelivery()];
    callback.extra = { installed: false };
  }
  return [handover, callback];
}

// ---------------------------------------------------------------------------------------------------------------------

/** Every connection, read on one querier (a read-only transaction in the route). */
export async function collectConnections(q: Querier, env: NodeJS.ProcessEnv = process.env): Promise<SnapshotConnection[]> {
  const presence = await one(
    q,
    sql.raw(`SELECT ${TABLES.map((t) => `to_regclass('${t}') IS NOT NULL AS "${t}"`).join(", ")}`),
  );
  const installed = Object.fromEntries(TABLES.map((t) => [t, presence[t] === true])) as Record<Table, boolean>;

  const out: SnapshotConnection[] = [];
  out.push(...(await collectMail(q, env, installed)));
  out.push(await collectApprovals(q, installed));
  for (const spec of OUTBOXES) out.push(await collectOutbox(q, spec, env, installed));
  out.push(...(await collectProcore(q, env, installed)));
  out.push(...(await collectLegs(q, installed)));
  return out;
}

/** RAILWAY_GIT_COMMIT_SHA when it is 7-40 hex, else null (ADDENDUM-1 #7). */
export function producerCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

export const SNAPSHOT_STATEMENT_TIMEOUT = "5s";

/**
 * The whole snapshot: every read in ONE read-only transaction (5 s per statement), then checked against the contract
 * before it leaves. A snapshot that fails its own check throws, so the route answers 503 rather than a broken document.
 */
export async function collectSynchubSnapshot(options: { db?: any; env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<Snapshot> {
  const env = options.env ?? process.env;
  const db = options.db ?? (await import("../db")).db;
  const connections: SnapshotConnection[] = await db.transaction(
    async (tx: Querier) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${SNAPSHOT_STATEMENT_TIMEOUT}'`));
      return collectConnections(tx, env);
    },
    { accessMode: "read only" },
  );
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    system: "synchub" as const,
    generated_at: (options.now ?? new Date()).toISOString(),
    producer_commit: producerCommit(env),
    connections,
  };
  const checked = validateSnapshot(snapshot);
  if (!checked.ok) throw new Error(`the snapshot failed its own contract check (${checked.errors.length} error(s))`);
  return checked.snapshot;
}
