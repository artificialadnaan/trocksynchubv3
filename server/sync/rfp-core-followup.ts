/**
 * RFP Phase 2, S1a: the follow-ups of a created Core bid (CONTRACT v2.4 §6 / §7 / §10), one row at a time from
 * `rfp_core_followup_outbox`:
 *   crm_link (E4)    → CRM POST /api/internal/core-bid-created (bid-board-created's HMAC). result "linked" | "replay"
 *                      (incl. a link-only `claimed:false`) ⇒ sent + the E5 core_confirm; "stale" ⇒ orphan_stale + alert + N1
 *                      core_bid_orphan; 409 ⇒ link_refused + alert + N1 core_bid_link_refused with the reason, NEVER
 *                      auto-retried (a person resolves it); 408 / 429 / 5xx / transport / an unknown result ⇒ retry on the
 *                      schedule with an alert, the 6th failure ⇒ dead + alert + F1 (the rep's Retry re-arms it, §2);
 *                      any other status ⇒ failed + alert.
 *   core_confirm (E5) → Core POST /webhooks/crm/<office>/rfp-bid-create/v1/linked (the office E2 went to; domain
 *                      trock.crm.rfp-bid-create-linked.v1). NEVER dead:
 *                      every failure is retried, on the schedule and then every 2 h; at the first post-schedule failure an
 *                      ops alert + ONE N1 core_link_confirm_pending, then a daily alert; confirmed after that notice ⇒ N1
 *                      core_link_confirmed (the CLEAR).
 *   crm_notice (N1)  → CRM POST /api/internal/rfp-core-notice, the strict body STORED at enqueue (noticeId =
 *                      rfp-core-notice:rfp_core_followup_outbox:<its row id>:<kind>, built once, identical on every
 *                      redelivery). Dead after the schedule ⇒ alert only.
 * Drains by data like the sender (§12, d9 ruling, S1a r2): NOT gated on RFP_NONSERVICE_DESTINATION, so a follow-up of
 * a core-stamped create drains under any setting (a rollback to procore still links and confirms it); the 0027 tables
 * absent is silent unless the setting is core; a kind whose secret or base URL is missing sends nothing, its rows stay
 * pending, and ONE alert is raised only when such a follow-up is DUE. E4 / N1 carry the create's office (dallas |
 * atlanta, d9 ruling 5). Outcomes are recorded under the per-deal lock (advisory first, row after), so they serialise
 * with the S0 re-arm of a dead follow-up.
 */
import { sql } from "drizzle-orm";
import { log } from "../index";
import type { CreateFromRfpInput } from "../routes/rfp-requests";
import { enqueueF1InTx } from "./bidboard-create-worker";
import { raiseRfpCoreAlert, type RfpCoreAlertCode } from "./rfp-core-alert";
import { validCoreIngressBase } from "./core-ingress-client";
import { postCoreSigned, postCrmSigned, type PostResult } from "./rfp-core-http";
import { preflightRfpCoreTables } from "./rfp-core-preflight";
import type { RfpCoreDrainDeps } from "./rfp-core-sender";
import {
  CRM_CORE_BID_CREATED_PATH,
  CRM_RFP_CORE_NOTICE_PATH,
  RFP_BID_CREATE_LINKED_DOMAIN,
  RFP_CORE_MAX_ATTEMPTS,
  RFP_CORE_NOTICE_TABLE,
  buildCoreConfirmBody,
  buildCrmInternalTargetUrl,
  buildRfpCoreNoticeBody,
  classifyCoreConfirmResponse,
  classifyCrmLinkResponse,
  classifyCrmNoticeResponse,
  coreConfirmDisposition,
  resolveRfpBidCreateIngressSecret,
  resolveRfpBidCreateOffice,
  buildRfpBidCreateLinkedOfficeTargetUrl,
  retryDisposition,
  rfpCoreNoticeId,
  type RfpCoreNoticeKind,
} from "./rfp-core-wire";
import { crmSecretUsable, crmUrlAllowed } from "../crm-signing-v2";
import { lockRfpCreateDeal, readCoreCreateContext } from "./rfp-create-lock";
import { operatorRedriveOf } from "./rfp-operator-redrive";
import { rfpNonserviceDestinationSetting } from "./rfp-destination";

export interface RfpCoreFollowupDrainResult {
  processed: number;
  sent: number;
  retried: number;
  dead: number;
  failed: number;
  orphaned: number;
  linkRefused: number;
  skipped?: "running" | "tables_missing" | "tables_inconclusive" | "unconfigured";
}

type FollowupKind = "crm_link" | "core_confirm" | "crm_notice";
type AlertList = Array<[RfpCoreAlertCode, Record<string, unknown>]>;
type Counted = "sent" | "retried" | "dead" | "failed" | "orphaned" | "linkRefused";

const STALE_SENDING_INTERVAL = "10 minutes";
const DEFAULT_LIMIT = 20;

let followupRunning = false;
const latched = new Set<string>();

/** Test seam: forget the running guard and the alert latch. */
export function resetRfpCoreFollowupStateForTests(): void {
  followupRunning = false;
  latched.clear();
}

async function getDb(): Promise<any> {
  return (await import("../db")).db;
}

function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

function firstRow(res: any): any | undefined {
  return rowsOf(res)[0];
}

function emptyResult(): RfpCoreFollowupDrainResult {
  return { processed: 0, sent: 0, retried: 0, dead: 0, failed: 0, orphaned: 0, linkRefused: 0 };
}

async function alertOnce(key: string, code: RfpCoreAlertCode, detail: Record<string, unknown>): Promise<void> {
  if (latched.has(key)) return;
  latched.add(key);
  await raiseRfpCoreAlert(code, detail);
}

function clearLatched(prefix: string): void {
  for (const key of Array.from(latched)) if (key.startsWith(prefix)) latched.delete(key);
}

interface FollowupConfig {
  ready: FollowupKind[];
  missing: string[];
  crmSecret: string | null;
  crmLinkUrl: string | null;
  noticeUrl: string | null;
  coreSecret: string | null;
  /** The validated Core base; E5's path is per office (/webhooks/crm/<office>/rfp-bid-create/v1/linked). */
  coreBase: string | null;
}

function followupConfig(env: NodeJS.ProcessEnv = process.env): FollowupConfig {
  const missing: string[] = [];
  // SIGNING-HARDENING r1 (first use, never boot): the CRM secret ≥ 32 bytes and an https CRM base (localhost / 127.0.0.1
  // excepted); either short of that and E4 / N1 are not sent, exactly like an unset value.
  const crmSecret = crmSecretUsable(env.RFP_REQUEST_SYNC_SECRET) ? env.RFP_REQUEST_SYNC_SECRET! : null;
  const crmBaseOk = crmUrlAllowed(env.TROCK_CRM_BASE_URL);
  const crmLinkUrl = crmBaseOk ? buildCrmInternalTargetUrl(CRM_CORE_BID_CREATED_PATH, env.TROCK_CRM_BASE_URL) : null;
  const noticeUrl = crmBaseOk ? buildCrmInternalTargetUrl(CRM_RFP_CORE_NOTICE_PATH, env.TROCK_CRM_BASE_URL) : null;
  const coreSecret = resolveRfpBidCreateIngressSecret(env);
  const coreBase = validCoreIngressBase(env.CORE_INGRESS_BASE_URL);
  if (!crmSecret) missing.push("RFP_REQUEST_SYNC_SECRET (unset or shorter than 32 bytes): E4 / N1 are not sent");
  if (!crmLinkUrl) missing.push("TROCK_CRM_BASE_URL (unset, or not https outside localhost / 127.0.0.1): E4 / N1 are not sent");
  if (!coreSecret) missing.push("RFP_BID_CREATE_INGRESS_SECRET_CURRENT (unset or shorter than 32 bytes): E5 is not sent");
  if (!coreBase) missing.push("CORE_INGRESS_BASE_URL (unset, not https, or carrying a query / fragment): E5 is not sent");
  const ready: FollowupKind[] = [];
  if (crmSecret && crmLinkUrl) ready.push("crm_link", "crm_notice");
  if (coreSecret && coreBase) ready.push("core_confirm");
  return { ready, missing, crmSecret, crmLinkUrl, noticeUrl, coreSecret, coreBase };
}

/**
 * The create's office (d9 ruling 5): E1's office on the command row, when dallas | atlanta; for an operator re-drive row
 * whose E1 predates PR-B (no office), the office its GO attested (d9 Q1, S1b r2).
 */
function officeOf(ctx: any): string | null {
  return resolveRfpBidCreateOffice(ctx?.command_payload?.office)
    ?? resolveRfpBidCreateOffice(operatorRedriveOf(ctx?.core_payload)?.office ?? null);
}

/**
 * N1 (§10), INSIDE the caller's transaction: ONE row per (create, kind) by the unique index; the noticeId is built from
 * the row's own id ONCE and stored with the whole strict body, so every redelivery is byte-identical.
 */
async function enqueueNoticeInTx(
  tx: any, ctx: any, kind: RfpCoreNoticeKind, reason: string | null, now: Date,
): Promise<string | null> {
  const base = {
    sourceDealId: String(ctx.source_deal_id),
    sourceEventId: String(ctx.source_event_id),
    office: officeOf(ctx),
    kind,
    reason,
    coreBidId: ctx.core_bid_id ?? null,
    occurredAt: now.toISOString(),
  };
  const inserted = firstRow(await tx.execute(sql`
    INSERT INTO rfp_core_followup_outbox (create_id, kind, notice_kind, payload, status)
    VALUES (${ctx.create_id}, 'crm_notice', ${kind}, ${JSON.stringify(base)}::jsonb, 'pending')
    ON CONFLICT (create_id, kind, notice_kind) DO NOTHING
    RETURNING id
  `));
  if (!inserted) return null; // already enqueued: ONE notice of each kind per create
  const noticeId = rfpCoreNoticeId(RFP_CORE_NOTICE_TABLE, Number(inserted.id), kind);
  const body = buildRfpCoreNoticeBody({ ...base, noticeId });
  await tx.execute(sql`
    UPDATE rfp_core_followup_outbox SET notice_id = ${noticeId}, payload = ${JSON.stringify(body)}::jsonb WHERE id = ${inserted.id}
  `);
  return noticeId;
}

function f1Input(ctx: any): CreateFromRfpInput {
  return { ...((ctx.command_payload ?? {}) as any), sourceSystem: String(ctx.source_system), sourceDealId: String(ctx.source_deal_id) } as CreateFromRfpInput;
}

const DUE_PREDICATE = sql.raw(
  `((status = 'pending' AND next_attempt_at <= NOW()) OR (status = 'sending' AND last_attempt_at < NOW() - interval '${STALE_SENDING_INTERVAL}'))`,
);

async function claimNext(db: any, kinds: FollowupKind[], seen: number[]): Promise<any | null> {
  const kindList = sql.raw(kinds.map((k) => `'${k}'`).join(", ")); // a fixed internal set, never input
  const exclude = seen.length > 0 ? sql.raw(`AND id NOT IN (${seen.join(",")})`) : sql``;
  return firstRow(await db.execute(sql`
    UPDATE rfp_core_followup_outbox
       SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = NOW()
     WHERE id = (
       SELECT id FROM rfp_core_followup_outbox
        WHERE ${DUE_PREDICATE} AND kind IN (${kindList}) ${exclude}
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *
  `)) ?? null;
}

async function send(row: any, ctx: any, config: FollowupConfig, deps: RfpCoreDrainDeps, now: Date): Promise<PostResult> {
  const kind = row.kind as FollowupKind;
  if (kind === "core_confirm") {
    const p = (row.payload ?? {}) as any;
    // The office E2 went to (stored on E5 at enqueue from E4's body), else the create's E1 office.
    const office = resolveRfpBidCreateOffice(p.office) ?? officeOf(ctx);
    const targetUrl = office ? buildRfpBidCreateLinkedOfficeTargetUrl(office, config.coreBase!) : null;
    // Never dead (§7): an office the Core path does not serve is retried like any failure, and alerted.
    if (!targetUrl) return { kind: "transport", error: `office_not_supported: ${JSON.stringify(p.office ?? ctx.command_payload?.office ?? null)}` };
    const body = buildCoreConfirmBody({
      occurredAt: now.toISOString(),
      sourceEventId: p.sourceEventId,
      crmDealId: p.crmDealId,
      coreBidId: p.coreBidId,
      crmResult: p.crmResult === "replay" ? "replay" : "linked",
    });
    return postCoreSigned(
      { targetUrl, domain: RFP_BID_CREATE_LINKED_DOMAIN, rawBody: JSON.stringify(body), secret: config.coreSecret! },
      { fetchImpl: deps.fetchImpl },
    );
  }
  // E4 / N1 are static: the stored body is sent as stored, so a redelivery is byte-identical.
  const targetUrl = kind === "crm_link" ? config.crmLinkUrl! : config.noticeUrl!;
  return postCrmSigned({ targetUrl, rawBody: JSON.stringify(row.payload), secret: config.crmSecret! }, { fetchImpl: deps.fetchImpl, now: () => now });
}

/** Record one attempt's answer under the per-deal lock, only while the row is still OUR `sending` attempt. */
async function record(db: any, row: any, ctx: any, response: PostResult, now: Date): Promise<Counted | null> {
  const alerts: AlertList = [];
  let counted: Counted | null = null;
  const attempt = Number(row.attempt_count);
  const maxAttempts = Number(row.max_attempts ?? RFP_CORE_MAX_ATTEMPTS);
  const status = response.kind === "response" ? response.status : null;
  const body = response.kind === "response" ? response.body : {};
  const transportError = response.kind === "transport" ? `transport failure: ${response.error}` : null;
  const ids = {
    followupId: row.id, kind: row.kind, noticeKind: row.notice_kind || null, createId: ctx.create_id,
    sourceDealId: ctx.source_deal_id, sourceEventId: ctx.source_event_id, coreBidId: ctx.core_bid_id ?? null,
  };

  const setRetry = async (tx: any, delay: string, error: string) => {
    await tx.execute(sql`
      UPDATE rfp_core_followup_outbox
         SET status = 'pending', last_status_code = ${status}, last_attempt_at = NOW(),
             next_attempt_at = NOW() + ${delay}::interval, last_error = ${error}
       WHERE id = ${row.id}
    `);
  };
  const setFinal = async (tx: any, final: string, result: string | null, error: string | null) => {
    const sentAt = final === "sent" ? sql`NOW()` : sql`sent_at`;
    await tx.execute(sql`
      UPDATE rfp_core_followup_outbox
         SET status = ${final}, result = ${result}, last_status_code = ${status}, last_attempt_at = NOW(), last_error = ${error},
             sent_at = ${sentAt}
       WHERE id = ${row.id}
    `);
  };

  await db.transaction(async (tx: any) => {
    await lockRfpCreateDeal(tx, String(ctx.source_deal_id));
    const current = firstRow(await tx.execute(sql`
      SELECT id FROM rfp_core_followup_outbox WHERE id = ${row.id} AND status = 'sending' AND attempt_count = ${attempt} FOR UPDATE
    `));
    if (!current) return;

    if (row.kind === "crm_link") {
      const outcome = transportError ? { kind: "retry" as const, error: transportError } : classifyCrmLinkResponse(status!, body);
      if (outcome.kind === "linked") {
        await setFinal(tx, "sent", outcome.result, null);
        const e4 = (row.payload ?? {}) as any;
        const e5 = {
          sourceEventId: e4.sourceEventId, crmDealId: e4.sourceDealId, coreBidId: e4.coreBidId, crmResult: outcome.crmResult,
          office: e4.office ?? null, // the office E2 went to: E5 goes to the same office's …/linked
        };
        await tx.execute(sql`
          INSERT INTO rfp_core_followup_outbox (create_id, kind, notice_kind, payload, status)
          VALUES (${row.create_id}, 'core_confirm', '', ${JSON.stringify(e5)}::jsonb, 'pending')
          ON CONFLICT (create_id, kind, notice_kind) DO NOTHING
        `);
        counted = "sent";
      } else if (outcome.kind === "stale") {
        await setFinal(tx, "orphan_stale", "stale", "the CRM answered stale: the approval this bid was created for is no longer current");
        await enqueueNoticeInTx(tx, ctx, "core_bid_orphan", "stale", now);
        alerts.push(["core_bid_orphan", { result: "stale" }]);
        counted = "orphaned";
      } else if (outcome.kind === "link_refused") {
        await setFinal(tx, "link_refused", outcome.reason, `the CRM refused the link: ${outcome.reason}`);
        await enqueueNoticeInTx(tx, ctx, "core_bid_link_refused", outcome.reason, now);
        alerts.push(["core_bid_link_refused", { reason: outcome.reason, status: 409 }]);
        counted = "linkRefused";
      } else if (outcome.kind === "terminal") {
        await setFinal(tx, "failed", null, outcome.error);
        alerts.push(["crm_request_rejected", { status: outcome.status, error: outcome.error, attempt }]);
        counted = "failed";
      } else {
        const next = retryDisposition(attempt, maxAttempts);
        if (next.kind === "dead") {
          await setFinal(tx, "dead", null, outcome.error);
          await enqueueF1InTx(tx, f1Input(ctx), "crm_link_dead");
          alerts.push(["crm_link_dead", { status, error: outcome.error, attempts: attempt }]);
          counted = "dead";
        } else {
          await setRetry(tx, next.delay, outcome.error);
          alerts.push(["crm_link_retry", { status, error: outcome.error, attempt, nextIn: next.delay }]);
          counted = "retried";
        }
      }
      return;
    }

    if (row.kind === "core_confirm") {
      const outcome = transportError ? { kind: "retry" as const, error: transportError } : classifyCoreConfirmResponse(status!, body);
      if (outcome.kind === "confirmed") {
        await setFinal(tx, "sent", "confirmed", null);
        const pending = firstRow(await tx.execute(sql`
          SELECT id FROM rfp_core_followup_outbox
           WHERE create_id = ${row.create_id} AND kind = 'crm_notice' AND notice_kind = 'core_link_confirm_pending'
        `));
        if (pending) await enqueueNoticeInTx(tx, ctx, "core_link_confirmed", null, now);
        counted = "sent";
        return;
      }
      // NEVER dead (§7): the schedule, then every 2 h.
      const next = coreConfirmDisposition(attempt);
      await setRetry(tx, next.delay, outcome.error);
      if (next.pendingNotice) await enqueueNoticeInTx(tx, ctx, "core_link_confirm_pending", null, now);
      if (attempt < RFP_CORE_MAX_ATTEMPTS) {
        alerts.push(["core_confirm_retry", { status, error: outcome.error, attempt, nextIn: next.delay }]);
      } else if (next.delayedAlert) {
        alerts.push(["core_confirm_delayed", {
          status, error: outcome.error, attempt, nextIn: next.delay,
          note: "Core confirmation delayed; Core stage changes won't reach the CRM until it clears",
        }]);
      }
      counted = "retried";
      return;
    }

    // crm_notice (N1)
    const outcome = transportError ? { kind: "retry" as const, error: transportError } : classifyCrmNoticeResponse(status!, body);
    if (outcome.kind === "sent") {
      await setFinal(tx, "sent", outcome.result, null);
      counted = "sent";
    } else if (outcome.kind === "terminal") {
      await setFinal(tx, "failed", null, outcome.error);
      alerts.push(["crm_request_rejected", { status: outcome.status, error: outcome.error, attempt, noticeId: row.notice_id }]);
      counted = "failed";
    } else {
      const next = retryDisposition(attempt, maxAttempts);
      if (next.kind === "dead") {
        await setFinal(tx, "dead", null, outcome.error);
        alerts.push(["crm_notice_dead", { status, error: outcome.error, attempts: attempt, noticeId: row.notice_id }]);
        counted = "dead";
      } else {
        await setRetry(tx, next.delay, outcome.error);
        alerts.push(["crm_notice_retry", { status, error: outcome.error, attempt, nextIn: next.delay, noticeId: row.notice_id }]);
        counted = "retried";
      }
    }
  });
  for (const [code, detail] of alerts) await raiseRfpCoreAlert(code, { ...ids, ...detail });
  return counted;
}

/** One drain pass, without the in-process running guard. NOT gated on RFP_NONSERVICE_DESTINATION (§12, r2). */
export async function drainRfpCoreFollowupOutbox(deps: RfpCoreDrainDeps = {}): Promise<RfpCoreFollowupDrainResult> {
  const result = emptyResult();
  const activated = rfpNonserviceDestinationSetting() === "core";
  const db = await getDb();
  const tables = await preflightRfpCoreTables(db);
  if (tables !== "present") {
    // Not activated: 0027 not applied yet is the normal pre-activation state ⇒ silent.
    if (activated) {
      await alertOnce(
        `tables:${tables}`,
        tables === "missing" ? "core_tables_missing" : "core_preflight_error",
        { stage: "followup", preflight: tables, action: "HOLD: nothing is sent" },
      );
    } else if (tables === "inconclusive") {
      log("[rfp-core] follow-ups: the 0027 table probe failed; nothing drained this tick", "rfp-core");
    }
    return { ...result, skipped: tables === "missing" ? "tables_missing" : "tables_inconclusive" };
  }
  clearLatched("tables:");
  const config = followupConfig();
  if (config.missing.length > 0) {
    // ONE alert, and only when a follow-up of a kind that cannot be sent is actually due.
    const held = (["crm_link", "core_confirm", "crm_notice"] as FollowupKind[]).filter((k) => !config.ready.includes(k));
    const heldList = sql.raw(held.map((k) => `'${k}'`).join(", ")); // a fixed internal set, never input
    const due = held.length === 0 ? undefined : firstRow(await db.execute(sql`
      SELECT id FROM rfp_core_followup_outbox WHERE ${DUE_PREDICATE} AND kind IN (${heldList}) LIMIT 1
    `));
    if (due) {
      await alertOnce(`unconfigured:${config.missing.join("|")}`, "rfp_core_unconfigured", {
        stage: "followup", missing: config.missing, action: "the affected follow-ups are not sent and stay pending",
      });
    }
  } else {
    clearLatched("unconfigured:");
  }
  if (config.ready.length === 0) return { ...result, skipped: "unconfigured" };

  const limit = deps.limit ?? DEFAULT_LIMIT;
  const seen: number[] = [];
  while (result.processed < limit) {
    const row = await claimNext(db, config.ready, seen);
    if (!row) break;
    seen.push(Number(row.id));
    result.processed += 1;
    const now = (deps.now ?? (() => new Date()))();
    const ctx = (await readCoreCreateContext(db, Number(row.create_id))) ?? null;
    if (!ctx) {
      log(`[rfp-core] follow-up ${row.id}: its create row ${row.create_id} is gone; left sending for an operator`, "rfp-core");
      continue;
    }
    const response = await send(row, ctx, config, deps, now);
    const counted = await record(db, row, ctx, response, now);
    if (counted) result[counted] += 1;
    log(`[rfp-core] follow-up ${row.id} (${row.kind}${row.notice_kind ? `:${row.notice_kind}` : ""}) attempt ${row.attempt_count}: ${counted ?? "superseded"}`, "rfp-core");
  }
  return result;
}

export async function processRfpCoreFollowupOutbox(deps: RfpCoreDrainDeps = {}): Promise<RfpCoreFollowupDrainResult> {
  if (followupRunning) return { ...emptyResult(), skipped: "running" };
  followupRunning = true;
  try {
    return await drainRfpCoreFollowupOutbox(deps);
  } finally {
    followupRunning = false;
  }
}
