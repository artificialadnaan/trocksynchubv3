/**
 * RFP Phase 2, S1a: the E2 sender (CONTRACT v2.4 §5 / §10). Drains due `rfp_core_create_outbox` rows to Core's
 * POST /webhooks/crm/<office>/rfp-bid-create/v1 (E1's office, dallas | atlanta; d9 ruling 5) and records E3.
 *
 * DRAINS BY DATA, NOT BY THE SETTING (§12, d9 ruling, S1a r2): RFP_NONSERVICE_DESTINATION governs only NEW stamping (S0).
 * A row already core-stamped drains to Core under ANY setting (core, procore, unset), so a rollback to procore still
 * delivers it; before activation there is nothing to drain, because no row can be core-stamped until the setting is core.
 *   - the 0027 tables absent: a silent no-op, unless the setting is core (then HOLD + one alert, never a Procore fallback);
 *   - a missing / short RFP_BID_CREATE_INGRESS_SECRET_CURRENT or an unset CORE_INGRESS_BASE_URL / TROCK_CRM_BASE_URL: nothing
 *     is sent, every row stays pending, and ONE alert is raised only when a row is DUE (an un-activated deploy is silent).
 *
 * ONE ROW AT A TIME, the DECISION + CLAIM under the per-deal lock `rfp_create:<sourceDealId>` (§10), advisory lock first,
 * row locks after (the S0 enqueue's order, so the two never deadlock):
 *   1. the row is re-read FOR UPDATE SKIP LOCKED under the lock (a second instance that lost the race sees it claimed);
 *   2. the same sourceEventId stored for another deal ⇒ refused `source_event_reused` + alert + F1, nothing sent (§4);
 *   3. the Procore footprint (readProcoreFootprint) ⇒ held_cross_destination + alert + F1, exactly as S0's paths do. The
 *      ONLY exception: an operator re-drive row (a non-empty `payload.operatorRedrive.go`) whose command is procore-done
 *      (re-drive design r2 001ab3ba, pending a4's final confirmation);
 *   4. the E2 body is built from the command row's stored E1 payload (§5): companyId null ⇒ refused `company_missing`
 *      + alert + F1, nothing sent;
 *   5. else the row is CLAIMED (`sending`, attempt_count + 1, e2_ever_sent, all in the lock's transaction, so the Core
 *      footprint is visible to every other create path before the lock is released) and E2 is POSTed outside it.
 * E3 (§10 classifier): 201 created / 200 replay | updated ⇒ sent + core_bid_id / core_created_at / warnings + the E4
 * crm_link follow-up; 409 ⇒ refused + F1 with Core's reason verbatim; 400 / 401 (and other deterministic 4xx) ⇒ failed +
 * alert; 404 / 408 / 429 / 5xx / transport ⇒ retry on 30 s / 2 m / 10 m / 30 m / 2 h with an alert; the 6th failure ⇒
 * dead + alert + F1. A row left `sending` by a crash is reclaimed after 10 minutes and re-sent: Core keys replay on the
 * sourceEventId + a digest that excludes occurredAt, so a re-delivery after a lost response creates no second bid.
 * Every retry / refused / held / terminal / dead path raises a visible alert (raiseRfpCoreAlert).
 */
import { sql } from "drizzle-orm";
import { log } from "../index";
import type { CreateFromRfpInput } from "../routes/rfp-requests";
import { buildBidBoardCreatedCallbackTargetUrl } from "./bidboard-callback-worker";
import { enqueueF1InTx, holdCrossDestination } from "./bidboard-create-worker";
import { raiseRfpCoreAlert, type RfpCoreAlertCode } from "./rfp-core-alert";
import { validCoreIngressBase } from "./core-ingress-client";
import { postCoreSigned, type FetchLike } from "./rfp-core-http";
import { preflightRfpCoreTables } from "./rfp-core-preflight";
import {
  RFP_BID_CREATE_DOMAIN,
  RFP_CORE_MAX_ATTEMPTS,
  buildCrmLinkBody,
  buildRfpBidCreateBody,
  buildRfpBidCreateOfficeTargetUrl,
  classifyCoreCreateResponse,
  isOperatorRedrive,
  resolveRfpBidCreateIngressSecret,
  retryDisposition,
  type CoreCreateOutcome,
  type RfpBidCreateBody,
} from "./rfp-core-wire";
import { lockRfpCreateDeal, readCreateCommandForUpdate, readProcoreFootprint } from "./rfp-create-lock";
import { operatorRedriveOf, type OperatorRedrive } from "./rfp-operator-redrive";
import { RFP_HELD_CROSS_DESTINATION_STATUS, rfpNonserviceDestinationSetting } from "./rfp-destination";

export interface RfpCoreDrainDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Rows handled per drain pass (each tick is bounded). */
  limit?: number;
}

export interface RfpCoreCreateDrainResult {
  processed: number;
  sent: number;
  refused: number;
  held: number;
  failed: number;
  retried: number;
  dead: number;
  skipped?: "running" | "tables_missing" | "tables_inconclusive" | "unconfigured";
}

/** A `sending` row older than this lost its worker (any E2 exchange ends within the 10 s deadline): reclaimed + re-sent. */
const STALE_SENDING_INTERVAL = "10 minutes";
const DEFAULT_LIMIT = 20;

type AlertList = Array<[RfpCoreAlertCode, Record<string, unknown>]>;

let senderRunning = false;
/** Config / table problems already alerted (ONE visible alert per distinct problem, cleared once it is fixed). */
const latched = new Set<string>();

/** Test seam: forget the running guard and the alert latch. */
export function resetRfpCoreSenderStateForTests(): void {
  senderRunning = false;
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

function emptyResult(): RfpCoreCreateDrainResult {
  return { processed: 0, sent: 0, refused: 0, held: 0, failed: 0, retried: 0, dead: 0 };
}

async function alertOnce(key: string, code: RfpCoreAlertCode, detail: Record<string, unknown>): Promise<void> {
  if (latched.has(key)) return;
  latched.add(key);
  await raiseRfpCoreAlert(code, detail);
}

function clearLatched(prefix: string): void {
  for (const key of Array.from(latched)) if (key.startsWith(prefix)) latched.delete(key);
}

async function raiseAll(alerts: AlertList, ids: Record<string, unknown>): Promise<void> {
  for (const [code, detail] of alerts) await raiseRfpCoreAlert(code, { ...ids, ...detail });
}

type SenderConfig = { ok: true; secret: string; coreBase: string } | { ok: false; missing: string[] };

function senderConfig(env: NodeJS.ProcessEnv = process.env): SenderConfig {
  const missing: string[] = [];
  const secret = resolveRfpBidCreateIngressSecret(env);
  if (!secret) missing.push("RFP_BID_CREATE_INGRESS_SECRET_CURRENT (unset or shorter than 32 bytes)");
  // The base only: the path is per office (/webhooks/crm/<office>/rfp-bid-create/v1), built per row.
  const coreBase = validCoreIngressBase(env.CORE_INGRESS_BASE_URL);
  if (!coreBase) missing.push("CORE_INGRESS_BASE_URL (unset, not https, or carrying a query / fragment)");
  // F1 (refused / held / dead) and the E4 follow-up both need the CRM.
  if (!buildBidBoardCreatedCallbackTargetUrl(env.TROCK_CRM_BASE_URL)) missing.push("TROCK_CRM_BASE_URL (unset)");
  if (!secret || !coreBase || missing.length > 0) return { ok: false, missing };
  return { ok: true, secret, coreBase };
}

/**
 * d9 Q1 (S1b r2) + ruling A (r3): an operator re-drive row's E1 may predate CRM PR-B (no office, no approvalKind, no
 * approval block). ONLY for such a row, the office / approvalKind / vote evidence the re-drive CLI recorded (checked, attested
 * by its GO) fill the gaps; a value the E1 HAS always wins. An ordinary row with no office stays office_not_supported, and
 * one with no approval block is sent with approval null, as before.
 */
function withRedriveAttestation(input: CreateFromRfpInput, redrive: OperatorRedrive): CreateFromRfpInput {
  const e1 = input as any;
  const filled = { ...e1 };
  if (!(typeof e1.office === "string" && e1.office.trim() !== "") && redrive.office) filled.office = redrive.office;
  if (e1.approvalKind !== "vote" && e1.approvalKind !== "override" && redrive.approvalKind) filled.approvalKind = redrive.approvalKind;
  // d9 ruling A (S1b r3): the attested vote evidence stands in for a missing approval block. Its `source` is recorded only:
  // Core's E2 approval has exactly five keys, so the body builder copies those five and nothing else.
  const hasBlock = e1.approval !== null && typeof e1.approval === "object" && !Array.isArray(e1.approval);
  if (!hasBlock && redrive.approval) {
    const { roundEventId, approvals, rejections, invitedVoterCount, decidedAt } = redrive.approval;
    filled.approval = { roundEventId, approvals, rejections, invitedVoterCount, decidedAt };
  }
  return filled as CreateFromRfpInput;
}

/** The E1 input F1 / the body read: the command row's stored payload, keyed by the Core row's own identity. */
function inputOf(row: any, command: any): CreateFromRfpInput {
  return { ...((command?.payload ?? {}) as any), sourceSystem: String(row.source_system), sourceDealId: String(row.source_deal_id) } as CreateFromRfpInput;
}

const DUE_PREDICATE = sql.raw(
  `((status = 'pending' AND next_attempt_at <= NOW()) OR (status = 'sending' AND last_attempt_at < NOW() - interval '${STALE_SENDING_INTERVAL}'))`,
);

type Claim =
  | { kind: "skip" }
  | { kind: "decided"; outcome: "refused" | "held"; ids: Record<string, unknown>; alerts: AlertList }
  | {
      kind: "send";
      id: number;
      dealId: string;
      attempt: number;
      maxAttempts: number;
      row: any;
      input: CreateFromRfpInput;
      body: RfpBidCreateBody;
      ids: Record<string, unknown>;
      alerts: AlertList;
    };

/** The decision + claim for one candidate, in ONE transaction under the per-deal lock. */
async function claimCandidate(db: any, candidate: { id: number; source_deal_id: string }, now: Date): Promise<Claim> {
  let claim: Claim = { kind: "skip" };
  await db.transaction(async (tx: any) => {
    await lockRfpCreateDeal(tx, String(candidate.source_deal_id));
    const row = firstRow(await tx.execute(sql`
      SELECT * FROM rfp_core_create_outbox WHERE id = ${candidate.id} AND ${DUE_PREDICATE} FOR UPDATE SKIP LOCKED
    `));
    if (!row) return; // another worker claimed it, or it changed under us
    const command = await readCreateCommandForUpdate(tx, Number(row.command_id));
    const input = inputOf(row, command);
    const ids = {
      coreId: row.id, commandId: row.command_id, sourceSystem: row.source_system, sourceDealId: row.source_deal_id,
      sourceEventId: row.source_event_id,
    };
    const alerts: AlertList = [];
    const payload = (command?.payload ?? {}) as any;

    // (2) The same sourceEventId for another deal (§4): refuse before sending.
    const otherDeal = firstRow(await tx.execute(sql`
      SELECT id FROM rfp_core_create_outbox
       WHERE source_event_id = ${row.source_event_id} AND source_deal_id <> ${row.source_deal_id} AND id <> ${row.id}
       LIMIT 1
    `));
    const reused =
      !command
      || String(command.source_event_id) !== String(row.source_event_id)
      || String(command.source_deal_id) !== String(row.source_deal_id)
      || (payload.sourceEventId !== undefined && String(payload.sourceEventId) !== String(row.source_event_id))
      || (payload.sourceDealId !== undefined && String(payload.sourceDealId) !== String(row.source_deal_id))
      || Boolean(otherDeal);
    if (reused) {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'refused', refusal_reason = 'source_event_reused',
               last_error = 'the same sourceEventId is stored for another deal: refused before sending'
         WHERE id = ${row.id}
      `);
      await enqueueF1InTx(tx, input, "source_event_reused");
      alerts.push(["source_event_reused", {
        commandDealId: command?.source_deal_id ?? null, payloadDealId: payload.sourceDealId ?? null, otherCoreId: otherDeal?.id ?? null,
      }]);
      claim = { kind: "decided", outcome: "refused", ids, alerts };
      return;
    }

    // (3) The Procore footprint, under the lock (§10). Only a procore-done operator re-drive row skips the hold.
    const footprint = await readProcoreFootprint(tx, String(row.source_system), String(row.source_deal_id));
    const redriveSkip = isOperatorRedrive(row.payload) && command.destination === "procore" && command.status === "done";
    if (footprint.length > 0 && !redriveSkip) {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = ${RFP_HELD_CROSS_DESTINATION_STATUS}, last_error = 'cross_destination_hold'
         WHERE id = ${row.id}
      `);
      await holdCrossDestination(tx, input, "core", footprint, alerts);
      claim = { kind: "decided", outcome: "held", ids, alerts };
      return;
    }

    // (4) The body (§5). An office other than dallas | atlanta (r2, d9 ruling 5) or a null companyId ⇒ SyncHub pre-refuses
    // (refused + alert + F1, re-armable per §2); nothing is sent.
    const redrive = operatorRedriveOf(row.payload);
    const bodyInput = redrive ? withRedriveAttestation(input, redrive) : input;
    const built = buildRfpBidCreateBody(bodyInput, { occurredAt: now.toISOString(), approvalKind: command.approval_kind ?? null });
    if (!built.ok) {
      const why = built.reason === "office_not_supported"
        ? `refused before sending: office ${JSON.stringify((input as any).office ?? null)} is not served by the Core path (dallas | atlanta)`
        : "refused before sending: the CRM deal has no company";
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'refused', refusal_reason = ${built.reason}, last_error = ${why}
         WHERE id = ${row.id}
      `);
      await enqueueF1InTx(tx, input, built.reason);
      alerts.push(["core_create_refused", { reason: built.reason, sent: false, office: (input as any).office ?? null }]);
      claim = { kind: "decided", outcome: "refused", ids, alerts };
      return;
    }

    // (5) Claim. e2_ever_sent is set BEFORE the send and never reset (0027): a dead E2 may have created a bid.
    const claimed = firstRow(await tx.execute(sql`
      UPDATE rfp_core_create_outbox
         SET status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = NOW(), e2_ever_sent = true
       WHERE id = ${row.id}
      RETURNING attempt_count, max_attempts
    `));
    if (redriveSkip && footprint.length > 0) alerts.push(["operator_redrive_sent", { footprint }]);
    claim = {
      kind: "send",
      id: Number(row.id),
      dealId: String(row.source_deal_id),
      attempt: Number(claimed.attempt_count),
      maxAttempts: Number(claimed.max_attempts ?? RFP_CORE_MAX_ATTEMPTS),
      row,
      input,
      body: built.body,
      ids,
      alerts,
    };
  });
  return claim;
}

/** Record E3 for a claimed attempt, under the lock, only while the row is still OUR `sending` attempt. */
type Counted = "sent" | "refused" | "failed" | "retried" | "dead";

async function recordOutcome(db: any, claim: Extract<Claim, { kind: "send" }>, outcome: CoreCreateOutcome): Promise<Counted | null> {
  const alerts: AlertList = [];
  let counted: Counted | null = null;
  await db.transaction(async (tx: any) => {
    await lockRfpCreateDeal(tx, claim.dealId);
    const current = firstRow(await tx.execute(sql`
      SELECT id FROM rfp_core_create_outbox
       WHERE id = ${claim.id} AND status = 'sending' AND attempt_count = ${claim.attempt}
       FOR UPDATE
    `));
    if (!current) return; // reclaimed after a stall: that attempt owns the row now
    const statusCode = "status" in outcome ? (outcome.status ?? null) : null;
    if (outcome.kind === "sent") {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'sent', sent_at = NOW(), last_attempt_at = NOW(), last_status_code = ${outcome.status},
               core_bid_id = ${outcome.coreBidId}, core_created_at = ${outcome.createdAt}::timestamptz,
               warnings = ${JSON.stringify(outcome.warnings)}::jsonb, last_error = NULL, refusal_reason = NULL
         WHERE id = ${claim.id}
      `);
      const e4 = buildCrmLinkBody({
        sourceDealId: String(claim.row.source_deal_id),
        sourceEventId: String(claim.row.source_event_id),
        approvalKind: claim.body.approvalKind,
        office: claim.body.office, // the same office E2 went to (d9 ruling 5)
        coreBidId: outcome.coreBidId,
        coreCreatedAt: outcome.createdAt,
        projectNumber: claim.body.deal.projectNumber,
        warnings: outcome.warnings,
      });
      await tx.execute(sql`
        INSERT INTO rfp_core_followup_outbox (create_id, kind, notice_kind, payload, status)
        VALUES (${claim.id}, 'crm_link', '', ${JSON.stringify(e4)}::jsonb, 'pending')
        ON CONFLICT (create_id, kind, notice_kind) DO NOTHING
      `);
      counted = "sent";
      return;
    }
    if (outcome.kind === "refused") {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'refused', refusal_reason = ${outcome.reason}, last_status_code = 409, last_attempt_at = NOW(),
               last_error = ${`Core refused the create: ${outcome.reason}`}
         WHERE id = ${claim.id}
      `);
      await enqueueF1InTx(tx, claim.input, outcome.reason);
      alerts.push(["core_create_refused", { reason: outcome.reason, status: 409, attempt: claim.attempt }]);
      counted = "refused";
      return;
    }
    if (outcome.kind === "terminal") {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'failed', last_status_code = ${outcome.status}, last_attempt_at = NOW(), last_error = ${outcome.error}
         WHERE id = ${claim.id}
      `);
      alerts.push(["core_request_rejected", { status: outcome.status, error: outcome.error, attempt: claim.attempt }]);
      counted = "failed";
      return;
    }
    const next = retryDisposition(claim.attempt, claim.maxAttempts);
    if (next.kind === "dead") {
      await tx.execute(sql`
        UPDATE rfp_core_create_outbox
           SET status = 'dead', last_status_code = ${statusCode}, last_attempt_at = NOW(), last_error = ${outcome.error}
         WHERE id = ${claim.id}
      `);
      await enqueueF1InTx(tx, claim.input, "core_create_dead");
      alerts.push(["core_create_dead", { status: statusCode, error: outcome.error, attempts: claim.attempt }]);
      counted = "dead";
      return;
    }
    await tx.execute(sql`
      UPDATE rfp_core_create_outbox
         SET status = 'pending', last_status_code = ${statusCode}, last_attempt_at = NOW(),
             next_attempt_at = NOW() + ${next.delay}::interval, last_error = ${outcome.error}
       WHERE id = ${claim.id}
    `);
    alerts.push(["core_create_retry", { status: statusCode, error: outcome.error, attempt: claim.attempt, nextIn: next.delay }]);
    counted = "retried";
  });
  await raiseAll(alerts, claim.ids);
  return counted;
}

/**
 * One drain pass, without the in-process running guard (two calls race exactly as two instances would). NOT gated on
 * RFP_NONSERVICE_DESTINATION (§12, r2): it drains whatever is already core-stamped; the setting only decides whether a
 * missing table is worth an alert.
 */
export async function drainRfpCoreCreateOutbox(deps: RfpCoreDrainDeps = {}): Promise<RfpCoreCreateDrainResult> {
  const result = emptyResult();
  const activated = rfpNonserviceDestinationSetting() === "core";
  const db = await getDb();
  const tables = await preflightRfpCoreTables(db);
  if (tables !== "present") {
    // Not activated: 0027 not applied yet is the normal pre-activation state ⇒ silent (no alert, no error).
    if (activated) {
      await alertOnce(
        `tables:${tables}`,
        tables === "missing" ? "core_tables_missing" : "core_preflight_error",
        { stage: "e2_sender", preflight: tables, action: "HOLD: nothing is sent and nothing falls back to Procore" },
      );
    } else if (tables === "inconclusive") {
      log("[rfp-core] E2 sender: the 0027 table probe failed; nothing drained this tick", "rfp-core");
    }
    return { ...result, skipped: tables === "missing" ? "tables_missing" : "tables_inconclusive" };
  }
  clearLatched("tables:");
  const config = senderConfig();
  if (!config.ok) {
    // ONE alert, and only when a row is actually due: an un-activated deploy with nothing to send stays silent.
    const due = firstRow(await db.execute(sql`SELECT id FROM rfp_core_create_outbox WHERE ${DUE_PREDICATE} LIMIT 1`));
    if (due) {
      await alertOnce(`unconfigured:${config.missing.join("|")}`, "rfp_core_unconfigured", {
        stage: "e2_sender", missing: config.missing, action: "nothing is sent; every row stays pending",
      });
    }
    return { ...result, skipped: "unconfigured" };
  }
  clearLatched("unconfigured:");

  const limit = deps.limit ?? DEFAULT_LIMIT;
  const seen: number[] = [];
  while (result.processed < limit) {
    const exclude = seen.length > 0 ? sql.raw(`AND id NOT IN (${seen.join(",")})`) : sql``;
    const candidate = firstRow(await db.execute(sql`
      SELECT id, source_deal_id FROM rfp_core_create_outbox WHERE ${DUE_PREDICATE} ${exclude} ORDER BY id LIMIT 1
    `));
    if (!candidate) break;
    seen.push(Number(candidate.id));
    const now = (deps.now ?? (() => new Date()))();
    const claim = await claimCandidate(db, { id: Number(candidate.id), source_deal_id: String(candidate.source_deal_id) }, now);
    if (claim.kind === "skip") continue;
    result.processed += 1;
    if (claim.kind === "decided") {
      await raiseAll(claim.alerts, claim.ids);
      result[claim.outcome] += 1;
      continue;
    }
    await raiseAll(claim.alerts, claim.ids);
    const rawBody = JSON.stringify(claim.body);
    // The body's office (dallas | atlanta, validated by the builder) picks the path; the signature covers that exact path.
    const targetUrl = buildRfpBidCreateOfficeTargetUrl(claim.body.office, config.coreBase)!;
    const response = await postCoreSigned(
      { targetUrl, domain: RFP_BID_CREATE_DOMAIN, rawBody, secret: config.secret },
      { fetchImpl: deps.fetchImpl },
    );
    const outcome: CoreCreateOutcome =
      response.kind === "transport"
        ? { kind: "retry", error: `Core rfp-bid-create transport failure: ${response.error}` }
        : classifyCoreCreateResponse(response.status, response.body);
    const counted = await recordOutcome(db, claim, outcome);
    if (counted) result[counted] += 1;
    log(`[rfp-core] E2 row ${claim.id} attempt ${claim.attempt}: ${outcome.kind}`, "rfp-core");
  }
  return result;
}

/** The worker tick's entry: one pass at a time per process. */
export async function processRfpCoreCreateOutbox(deps: RfpCoreDrainDeps = {}): Promise<RfpCoreCreateDrainResult> {
  if (senderRunning) return { ...emptyResult(), skipped: "running" };
  senderRunning = true;
  try {
    return await drainRfpCoreCreateOutbox(deps);
  } finally {
    senderRunning = false;
  }
}
