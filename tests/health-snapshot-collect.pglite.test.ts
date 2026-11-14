import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

// SyncHub's health snapshot reads (integration-health S2; CONTRACT r1 + ADDENDUM-1..-4), run as written on PGlite with seeded
// synthetic rows: a contract-valid snapshot with every key under synchub.; the seeded Outlook AADSTS failure in
// last_auth_error; an exhausted outbox row counted; measured 0 kept apart from null; each approved-RFP leg measured from the
// approval (a leg that never enqueued still counts); the retired rows absent; no seeded token, review link or email address
// in the output; one READ ONLY transaction and 0 rows changed. Synthetic data only.

const { collectSynchubSnapshot } = await import("../server/health/collect-synchub.ts");
const { validateSnapshot } = await import("../server/health/snapshot-contract.ts");

const DDL = `
  CREATE TABLE automation_config (
    id serial PRIMARY KEY, key text NOT NULL UNIQUE, value jsonb NOT NULL, description text,
    is_active boolean NOT NULL DEFAULT true, updated_at timestamp DEFAULT now()
  );
  CREATE TABLE email_send_log (
    id serial PRIMARY KEY, template_key text NOT NULL, recipient_email text NOT NULL, recipient_name text, subject text NOT NULL,
    dedupe_key text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'sent', error_message text, metadata jsonb,
    sent_at timestamp DEFAULT now(), created_at timestamp DEFAULT now()
  );
  CREATE TABLE rfp_approval_requests (
    id serial PRIMARY KEY, source_system text NOT NULL DEFAULT 'hubspot', source_deal_id text NOT NULL, project_number text,
    token text NOT NULL UNIQUE, token_expires_at timestamp, status text NOT NULL DEFAULT 'pending',
    deal_data jsonb NOT NULL DEFAULT '{}'::jsonb, approved_at timestamp, declined_at timestamp, bidboard_project_id text,
    created_at timestamp DEFAULT now()
  );
  CREATE TABLE rfp_core_create_outbox (
    id serial PRIMARY KEY, command_id integer NOT NULL DEFAULT 1, source_system text NOT NULL, source_deal_id text NOT NULL,
    source_event_id text NOT NULL, status text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 6, last_error text, last_status_code integer, core_bid_id text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE TABLE rfp_core_followup_outbox (
    id serial PRIMARY KEY, create_id integer NOT NULL, kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 6,
    last_error text, last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(),
    created_at timestamp NOT NULL DEFAULT now(), sent_at timestamp
  );
  CREATE TABLE service_rfp_core_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_request_id integer NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb, target_url text, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 6, last_error text, core_bid_id text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE TABLE bidboard_callback_outbox (
    id serial PRIMARY KEY, source_system text NOT NULL, source_deal_id text NOT NULL, rfp_approval_request_id integer,
    payload jsonb NOT NULL, target_url text NOT NULL, status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, last_error text,
    last_attempt_at timestamp, next_attempt_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(),
    sent_at timestamp
  );
  CREATE TABLE trockcrm_relay_outbox (
    id serial PRIMARY KEY, procore_portfolio_project_id text NOT NULL, project_number text NOT NULL, payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_attempt_at timestamp, last_error text,
    created_at timestamp DEFAULT now(), sent_at timestamp, next_retry_at timestamp
  );
  CREATE TABLE oauth_tokens (
    id serial PRIMARY KEY, provider text NOT NULL UNIQUE, access_token text NOT NULL, refresh_token text,
    expires_at timestamp, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
  );
  CREATE TABLE procore_login_alert_state (
    scope text PRIMARY KEY, state text NOT NULL DEFAULT 'ok', last_reason text, last_alerted_at timestamptz,
    last_success_at timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
const TABLES = [
  "automation_config", "email_send_log", "rfp_approval_requests", "rfp_core_create_outbox", "rfp_core_followup_outbox",
  "service_rfp_core_outbox", "bidboard_callback_outbox", "trockcrm_relay_outbox", "oauth_tokens", "procore_login_alert_state",
];

// Seeded "secrets": none of these may ever leave in a snapshot.
const OUTLOOK_AT = "AT-SEEDED-SECRET-OUTLOOK";
const OUTLOOK_RT = "RT-SEEDED-SECRET-OUTLOOK";
const PROCORE_AT = "AT-SEEDED-SECRET-PROCORE";
const PROCORE_RT = "RT-SEEDED-SECRET-PROCORE";
const REVIEW_939 = "REVIEW-TOKEN-SEEDED-939";
const REVIEW_940 = "REVIEW-TOKEN-SEEDED-940";
const OUTLOOK_EXPIRES_MS = Date.parse("2026-11-14T04:00:00.000Z");

let pg: PGlite;
let db: any;

async function seed() {
  const q = (text: string, params: unknown[] = []) => pg.query(text, params);
  const config = (key: string, value: unknown) =>
    q(`INSERT INTO automation_config (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
  await config("microsoft_oauth", { accessToken: OUTLOOK_AT, refreshToken: OUTLOOK_RT, expiresAt: OUTLOOK_EXPIRES_MS, userEmail: "mailbox.owner@example.test" });
  await config("email_config", { activeProvider: "outlook" });
  await config("testing_mode", { enabled: false, testEmail: "tester@example.test" });
  await config("mail_auth_health", {
    outlook: {
      last_ok_at: "2026-11-14T01:00:00.000Z",
      last_error: { code: "AADSTS50079", at: "2026-11-13T16:32:00.000Z", message_safe: "AADSTS50079: MFA enrolment required" },
    },
  });

  // Mail: 939's review email went out; a stage email failed 2 h ago (its error names a person's address).
  await q(
    `INSERT INTO email_send_log (template_key, recipient_email, subject, dedupe_key, status, error_message, metadata, sent_at) VALUES
       ('rfp_review', 'approver@example.test', 'RFP 939', 'rfp_review:d939', 'sent', NULL, $1::jsonb, now() - interval '3 hours'),
       ('stage_change', 'pm@example.test', 'Stage', 'stage:1', 'sent', NULL, NULL, now() - interval '1 hour'),
       ('stage_change', 'pm@example.test', 'Stage', 'stage:2', 'failed', 'Graph 401 sending to pm@example.test', NULL, now() - interval '2 hours')`,
    [JSON.stringify({ token: REVIEW_939 })],
  );

  // RFP requests: 939 pending + emailed; 940 pending, never emailed, link expiring tomorrow; 941 approved service RFP whose
  // Core card was confirmed but the CRM was never told (the 11-13 shape); 942 approved service RFP never handed to Core.
  await q(
    `INSERT INTO rfp_approval_requests (id, source_system, source_deal_id, project_number, token, token_expires_at, status, approved_at, created_at) VALUES
       (939, 'trock_crm', 'deal-939', 'DFW-4-70939-aa', $1, now() + interval '5 days', 'pending', NULL, now() - interval '6 hours'),
       (940, 'trock_crm', 'deal-940', 'DFW-4-70940-aa', $2, now() + interval '1 day', 'pending', NULL, now() - interval '5 hours'),
       (941, 'trock_crm', 'deal-941', 'DFW-4-70941-aa', 'REVIEW-TOKEN-SEEDED-941', NULL, 'approved', now() - interval '3 hours', now() - interval '9 hours'),
       (942, 'trock_crm', 'deal-942', 'DFW-4-70942-aa', 'REVIEW-TOKEN-SEEDED-942', NULL, 'approved', now() - interval '2 hours', now() - interval '8 hours')`,
    [REVIEW_939, REVIEW_940],
  );
  await q(
    `INSERT INTO service_rfp_core_outbox (source_system, source_deal_id, rfp_request_id, status, attempt_count, core_bid_id, last_attempt_at, created_at, sent_at)
     VALUES ('trock_crm', 'deal-941', 941, 'sent', 1, 'bid-941', now() - interval '3 hours', now() - interval '4 hours', now() - interval '3 hours')`,
  );

  // An E2 create that hit its ceiling 1 h ago; its stored error carries a credential.
  await q(
    `INSERT INTO rfp_core_create_outbox (source_system, source_deal_id, source_event_id, status, attempt_count, max_attempts, last_error, last_attempt_at, created_at)
     VALUES ('trock_crm', 'deal-950', 'evt-950', 'dead', 6, 6, 'POST failed: Bearer abc.def.ghi rejected', now() - interval '1 hour', now() - interval '7 hours')`,
  );
  // The relay delivered one event; rfp_core_followup_outbox and bidboard_callback_outbox stay EMPTY (measured zero).
  await q(
    `INSERT INTO trockcrm_relay_outbox (procore_portfolio_project_id, project_number, payload, status, attempts, last_attempt_at, sent_at)
     VALUES ('pp-1', 'DFW-2-1-aa', '{}'::jsonb, 'sent', 1, now() - interval '30 minutes', now() - interval '30 minutes')`,
  );

  await q(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
     VALUES ('procore', $1, $2, now() + interval '80 minutes', now() - interval '10 minutes')`,
    [PROCORE_AT, PROCORE_RT],
  );
  await q(
    `INSERT INTO procore_login_alert_state (scope, state, last_reason, last_error, last_success_at, updated_at)
     VALUES ('procore-browser-login', 'failing', 'mfa_required', 'Procore asked ops@example.test for an MFA code', now() - interval '2 days', now() - interval '1 hour')`,
  );
}

/** One digest per table, to prove the snapshot wrote nothing. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const present = (await pg.query<{ p: boolean }>(`SELECT to_regclass('${t}') IS NOT NULL AS p`)).rows[0]!.p;
    out[t] = present
      ? (await pg.query<{ fp: string }>(`SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') AS fp FROM ${t} t`)).rows[0]!.fp
      : "absent";
  }
  return out;
}

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(DDL);
  await seed();
  db = drizzle(pg);
});

const byKey = (snapshot: any) => (key: string) => snapshot.connections.find((c: any) => c.key === key);

describe("collectSynchubSnapshot", () => {
  it("emits a contract-valid snapshot of every SyncHub connection in ONE read-only transaction, and writes nothing", async () => {
    const configs: unknown[] = [];
    const spy = { ...db, transaction: (fn: any, config: unknown) => (configs.push(config), db.transaction(fn, config)) };
    const before = await fingerprint();
    const snapshot = await collectSynchubSnapshot({ db: spy, env: { RAILWAY_GIT_COMMIT_SHA: "C5514255AB" } });
    expect(await fingerprint()).toEqual(before);
    expect(configs).toEqual([{ accessMode: "read only" }]);

    const checked = validateSnapshot(snapshot);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
    expect(snapshot.system).toBe("synchub");
    expect(snapshot.producer_commit).toBe("c5514255ab");
    expect(snapshot.connections.map((c) => c.key)).toEqual([
      "synchub.mail.outlook",
      "synchub.mail.gmail",
      "synchub.mail.delivery",
      "synchub.rfp.approvals",
      "synchub.outbox.rfp_core_create",
      "synchub.outbox.rfp_core_followup",
      "synchub.outbox.service_rfp_core",
      "synchub.outbox.bidboard_callback",
      "synchub.relay.trockcrm",
      "synchub.procore.token",
      "synchub.procore.browser_login",
      "synchub.rfp.service_handover",
      "synchub.rfp.crm_callback",
    ]);
  });

  it("never carries a seeded token, review link token or email address", async () => {
    const json = JSON.stringify(await collectSynchubSnapshot({ db, env: {} }));
    for (const secret of [OUTLOOK_AT, OUTLOOK_RT, PROCORE_AT, PROCORE_RT, REVIEW_939, REVIEW_940, "REVIEW-TOKEN-SEEDED", "abc.def.ghi"]) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toMatch(/@example\.test/);
    expect(json).not.toMatch(/refreshToken|accessToken/);
  });

  it("Outlook: the seeded AADSTS failure, the recorded last OK, the stored expiry; sends measured on the active provider only", async () => {
    const row = byKey(await collectSynchubSnapshot({ db, env: { APP_URL: "https://synchub.example.test/some/path?x=1" } }));
    const outlook = row("synchub.mail.outlook");
    expect(outlook.connection).toEqual({
      credential_present: true,
      expires_at: "2026-11-14T04:00:00.000Z",
      last_auth_ok_at: "2026-11-14T01:00:00.000Z",
      last_auth_error: { code: "AADSTS50079", at: "2026-11-13T16:32:00.000Z", message_safe: "AADSTS50079: MFA enrolment required" },
    });
    expect(outlook.processing.last_success_at).not.toBeNull();
    expect(outlook.extra).toEqual({ active: true, active_provider: "outlook", auth_ok_source: "mail_auth_health" });
    expect(outlook.correction_url).toBe("https://synchub.example.test/settings");

    const gmail = row("synchub.mail.gmail");
    expect(gmail.connection).toEqual({ credential_present: false, expires_at: null, last_auth_ok_at: null, last_auth_error: null });
    expect(gmail.processing.last_success_at).toBeNull();
    expect(gmail.extra.active).toBe(false);
  });

  it("mail delivery: failures counted, no queue reported as null (not 0), the error sanitised", async () => {
    const delivery = byKey(await collectSynchubSnapshot({ db, env: {} }))("synchub.mail.delivery");
    expect(delivery.delivery).toEqual([
      expect.objectContaining({ direction: "out", pending: null, oldest_pending_at: null, failed_24h: 1, failed_7d: 1, exhausted: null }),
    ]);
    expect(delivery.delivery[0].last_delivered_at).not.toBeNull();
    expect(delivery.processing.last_error).toMatchObject({ code: "send_failed", message_safe: "Graph 401 sending to [email]" });
    expect(delivery.extra).toEqual({ sent_24h: 2, "failed_7d.stage_change": 1 });
    expect(delivery.paused).toBeNull();
  });

  it("testing mode pauses mail delivery (deliberate), and a disabled relay reads as paused, never as failed", async () => {
    await pg.query(`UPDATE automation_config SET value = '{"enabled": true, "testEmail": "tester@example.test"}'::jsonb WHERE key = 'testing_mode'`);
    const row = byKey(await collectSynchubSnapshot({ db, env: { TROCKCRM_RELAY_ENABLED: "false" } }));
    expect(row("synchub.mail.delivery").paused).toMatchObject({ reason: "testing_mode" });
    expect(row("synchub.relay.trockcrm").paused).toEqual({ reason: "flag TROCKCRM_RELAY_ENABLED=false", since: null });
  });

  it("RFP approvals: pending, the one never emailed, the link expiring within 48 h; ids only", async () => {
    const approvals = byKey(await collectSynchubSnapshot({ db, env: {} }))("synchub.rfp.approvals");
    expect(approvals.delivery[0]).toMatchObject({ pending: 2, failed_24h: null, exhausted: null });
    expect(approvals.extra).toEqual({ no_email_sent: 1, expiring_48h: 1, expired_pending: 0 });
    expect(approvals.records).toEqual([
      { kind: "rfp_approval_request", id: "939", state: "pending", url: null },
      { kind: "rfp_approval_request", id: "940", state: "pending:no_email", url: null },
    ]);
  });

  it("outboxes: an exhausted row is counted with a sanitised error; an empty outbox is MEASURED zero, not null", async () => {
    const row = byKey(await collectSynchubSnapshot({ db, env: {} }));
    const create = row("synchub.outbox.rfp_core_create");
    expect(create.delivery[0]).toMatchObject({ pending: 0, failed_24h: 1, failed_7d: 1, exhausted: 1, last_delivered_at: null });
    expect(create.processing.last_error).toMatchObject({ code: "dead", message_safe: "POST failed: [credential] rejected" });
    expect(create.extra).toEqual({ "status.dead": 1 });
    expect(create.records).toEqual([{ kind: "rfp_core_create", id: "1", state: "dead", url: null }]);

    const followup = row("synchub.outbox.rfp_core_followup");
    expect(followup.delivery[0]).toEqual({
      direction: "out", pending: 0, oldest_pending_at: null, failed_24h: 0, failed_7d: 0, exhausted: 0, last_delivered_at: null,
    });
    expect(row("synchub.relay.trockcrm").delivery[0]).toMatchObject({ pending: 0, exhausted: 0 });
    expect(row("synchub.relay.trockcrm").delivery[0].last_delivered_at).not.toBeNull();
  });

  it("each approved-RFP leg is measured from the approval: a leg that never enqueued is pending (ADDENDUM-3)", async () => {
    const row = byKey(await collectSynchubSnapshot({ db, env: {} }));
    const handover = row("synchub.rfp.service_handover");
    expect(handover.delivery[0]).toMatchObject({ pending: 1, failed_24h: 0, exhausted: null });
    expect(handover.delivery[0].last_delivered_at).not.toBeNull();
    expect(handover.records).toEqual([{ kind: "rfp_approval_request", id: "942", state: "not_enqueued", url: null }]);
    expect(handover.extra.not_enqueued).toBe(1);

    // 941: Core confirmed the card, but no CRM callback row exists — still pending on the CRM leg. 942 was never handed to
    // Core, so it is not a service RFP this leg can see (service-only, d9 11-14).
    const callback = row("synchub.rfp.crm_callback");
    expect(callback.delivery[0]).toMatchObject({ pending: 1, last_delivered_at: null });
    expect(callback.records.map((r: any) => [r.id, r.state])).toEqual([["941", "not_enqueued"]]);
  });

  describe("the CRM `approved` callback leg (d9, 11-14)", () => {
    /** Only the requests below: the shared seed's approvals and hand-offs are cleared first. */
    async function only(requests: Array<{ id: number; approvedAt: string; service: boolean }>) {
      await pg.exec(`DELETE FROM service_rfp_core_outbox; DELETE FROM rfp_approval_requests WHERE status = 'approved';`);
      for (const r of requests) {
        await pg.query(
          `INSERT INTO rfp_approval_requests (id, source_system, source_deal_id, project_number, token, status, approved_at)
           VALUES ($1, 'trock_crm', $2, $3, $4, 'approved', $5::timestamp)`,
          [r.id, `deal-${r.id}`, `DFW-${r.service ? 4 : 2}-7${r.id}-aa`, `REVIEW-TOKEN-SEEDED-${r.id}`, r.approvedAt],
        );
        if (r.service) {
          await pg.query(
            `INSERT INTO service_rfp_core_outbox (source_system, source_deal_id, rfp_request_id, status, attempt_count, core_bid_id, last_attempt_at, created_at, sent_at)
             VALUES ('trock_crm', $1, $2, 'sent', 1, $3, $4::timestamp, $4::timestamp, $4::timestamp)`,
            [`deal-${r.id}`, r.id, `bid-${r.id}`, r.approvedAt],
          );
        }
      }
      return byKey(await collectSynchubSnapshot({ db, env: {} }))("synchub.rfp.crm_callback");
    }

    it("counts from #136's deploy instant (22:55:42Z): an approval one second before is the reconcile's, one second after is pending", async () => {
      const callback = await only([
        { id: 960, approvedAt: "2026-11-13 22:55:41", service: true },
        { id: 961, approvedAt: "2026-11-13 22:55:43", service: true },
      ]);
      expect(callback.delivery[0].pending).toBe(1);
      expect(callback.records.map((r: any) => r.id)).toEqual(["961"]);
      expect(callback.extra.since).toBe("2026-11-13T22:55:42.000Z");
    });

    it("never counts a non-service approval: it reaches the CRM through Core's bid link", async () => {
      const callback = await only([{ id: 970, approvedAt: "2026-11-13 23:30:00", service: false }]);
      expect(callback.delivery[0].pending).toBe(0);
      expect(callback.records).toEqual([]);
    });
  });

  describe("the service hand-off leg counts from the first live hand-off, never from the outbox's own rows (Codex P2, d9 11-14)", () => {
    /** A clean slate: the shared seed's approvals and hand-offs removed. */
    async function clear() {
      await pg.exec(`DELETE FROM service_rfp_core_outbox; DELETE FROM rfp_approval_requests WHERE status = 'approved';`);
    }
    async function approvedService(id: number, approvedAt: string) {
      await pg.query(
        `INSERT INTO rfp_approval_requests (id, source_system, source_deal_id, project_number, token, status, approved_at)
         VALUES ($1, 'trock_crm', $2, $3, $4, 'approved', $5::timestamp)`,
        [id, `deal-${id}`, `DFW-4-7${id}-aa`, `REVIEW-TOKEN-SEEDED-${id}`, approvedAt],
      );
    }
    const handover = async () => byKey(await collectSynchubSnapshot({ db, env: {} }))("synchub.rfp.service_handover");

    it("an EMPTY hand-off outbox still counts the approved service RFP that never got a row (no false measured 0)", async () => {
      await clear();
      await approvedService(980, "2026-11-14 01:00:00");
      const leg = await handover();
      expect(leg.delivery[0].pending).toBe(1);
      expect(leg.records).toEqual([{ kind: "rfp_approval_request", id: "980", state: "not_enqueued", url: null }]);
      expect(leg.extra).toEqual({ not_enqueued: 1, since: "2026-08-31T18:13:20.711Z" });
    });

    it("an approval written 1 ms before its own hand-off row (the earliest row, failed) is counted", async () => {
      await clear();
      await approvedService(981, "2026-11-14 01:00:00.000");
      await pg.query(
        `INSERT INTO service_rfp_core_outbox (source_system, source_deal_id, rfp_request_id, status, attempt_count, core_bid_id, last_error, last_attempt_at, created_at)
         VALUES ('trock_crm', 'deal-981', 981, 'failed', 1, NULL, 'Core 400', '2026-11-14 01:00:00.001', '2026-11-14 01:00:00.001')`,
      );
      const leg = await handover();
      expect(leg.delivery[0].pending).toBe(1);
      expect(leg.records).toEqual([{ kind: "rfp_approval_request", id: "981", state: "failed", url: null }]);
    });
  });

  it("Procore: the token's presence and expiry (never the token); the failing browser sign-in with its reason", async () => {
    const row = byKey(await collectSynchubSnapshot({ db, env: {} }));
    const token = row("synchub.procore.token");
    expect(token.connection.credential_present).toBe(true);
    expect(token.connection.expires_at).not.toBeNull();
    expect(token.connection.last_auth_ok_at).not.toBeNull();
    expect(token.processing).toMatchObject({ last_success_at: null, cadence_seconds: 600 });
    expect(token.extra).toEqual({ auth_ok_source: "oauth_tokens.updated_at" });

    const browser = row("synchub.procore.browser_login");
    expect(browser.connection.last_auth_error).toMatchObject({ code: "mfa_required", message_safe: "Procore asked [email] for an MFA code" });
    expect(browser.connection.last_auth_ok_at).not.toBeNull();
    expect(browser.extra).toEqual({ state: "failing", export_page_failing: false });
  });

  it("the retired rows are not emitted (ADDENDUM-4, #136, #137)", async () => {
    const keys = (await collectSynchubSnapshot({ db, env: {} })).connections.map((c) => c.key);
    for (const retired of ["synchub.outbox.bidboard_create", "synchub.rfp.bidboard_create", "synchub.bidboard.crm_push"]) {
      expect(keys).not.toContain(retired);
    }
  });

  it("a table that is not there yet gives that row `installed: false` and nulls, never a failed snapshot", async () => {
    await pg.exec(`DROP TABLE procore_login_alert_state; DROP TABLE rfp_core_followup_outbox;`);
    const snapshot = await collectSynchubSnapshot({ db, env: {} });
    expect(validateSnapshot(snapshot).ok).toBe(true);
    const row = byKey(snapshot);
    expect(row("synchub.procore.browser_login").extra).toEqual({ installed: false });
    expect(row("synchub.outbox.rfp_core_followup").delivery[0]).toMatchObject({ pending: null, failed_24h: null });
  });
});
