// Approved service RFP → TROCK Core, as a durable outbound outbox.
//
// The Procore Bid Board create is a multi-minute Playwright automation. Core is told about the job
// FIRST so the estimator sees the card immediately, and a Core failure must never block or fail the
// Procore create — so every entry point here swallows its errors and leaves the work queued.
//
// Modelled on bidboard-callback-worker.ts (per-row target_url, HMAC-signed POST, BACKOFF_INTERVALS,
// dead-lettering) and deliberately NOT on bidboard-create-worker.ts, whose `failed` is terminal with
// no backoff at all.
import { sql } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { log } from "../index";
import { coreRfpTenant } from "../constants";
import {
  SERVICE_RFP_CONTRACT_VERSION,
  buildServiceRfpIngressTargetUrl,
  postServiceRfpApproved,
  resolveServiceRfpIngressSecret,
  type ServiceRfpAddress,
  type ServiceRfpApprovedBody,
} from "./core-ingress-client";

/** The wait BEFORE each retry: attempt N+1 fires this long after attempt N. */
export const SERVICE_RFP_CORE_BACKOFF_INTERVALS = [
  "30 seconds",
  "2 minutes",
  "10 minutes",
  "30 minutes",
  "2 hours",
] as const;

/**
 * One MORE than the number of waits — five intervals describe the gaps between SIX attempts, so a
 * ceiling equal to the interval count strands the last one. It did: at 5, the row dead-lettered on the
 * fifth claim ~42.5 minutes after approval, and the declared two-hour retry never ran once. That made
 * classifying Core's 404 (ingress dark) and 503 (Core has no secret) as RETRYABLE self-defeating — the
 * whole point of those two is to carry an approval across the provisioning window, and a flag flipped
 * later than ~42 minutes after deploy left every approval in it permanently dead.
 *
 * DERIVED, not written down, so adding a sixth interval cannot strand it again. Kept in step with
 * max_attempts in migrations/0025 and shared/schema.ts — the DB value is what wins at runtime, because
 * the worker reads max_attempts off the claimed row.
 */
export const SERVICE_RFP_CORE_MAX_ATTEMPTS = SERVICE_RFP_CORE_BACKOFF_INTERVALS.length + 1;

let outboxWorkerTimer: ReturnType<typeof setInterval> | null = null;
let outboxWorkerRunning = false;

// Both of these are dynamic on purpose, matching bidboard-callback-worker's getDb(). `../db`
// THROWS at import time without DATABASE_URL, and service-rfp-core-alert reaches bidboard-crm-alert,
// which imports its pool statically — so a static import here would drag that throw into
// rfp-approval.ts's own module graph and take every suite that imports the approval path down with it.
async function getDb() {
  return (await import("../db")).db;
}

/**
 * How long anything here will WAIT on an ops notification before walking away from it.
 *
 * The alert is not part of the record — the outbox row is durable before it is dispatched — but the
 * alerter is three DB round-trips plus an SMTP send, and sendEmail has no timeout of its own. Awaited
 * unbounded it sits on two critical paths: in the producer it is in front of the Playwright Bid Board
 * create, so a wedged mail provider would hold the entire approval; in the drain it is inside the
 * outboxWorkerRunning guard, so it would starve every later tick, not just its own.
 *
 * Both are the failure the fail-open design exists to prevent, and neither is covered by the Core
 * POST's own 5 s deadline. Walking away does NOT cancel the notification — it finishes in the
 * background — it only stops being something real work waits on.
 */
const ALERT_DISPATCH_WAIT_MS = 2_000;

/**
 * Tell the alerter what happened to one delivery. SUCCESS is reported too, not just failure: the alert
 * state only leaves 'failing' on an ok outcome, so a stream that reports failures alone never sends a
 * recovery email and — worse — leaves the failure debounce holding a stale incident that swallows the
 * next real one.
 *
 * The copy is this stream's own (see ./service-rfp-core-alert); only the debounce, the state table and
 * the send path are shared with the Bid Board → CRM push.
 */
async function reportDelivery(outcome: {
  office: string | null;
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
  terminal?: boolean;
}): Promise<void> {
  const dispatch = (async () => {
    const { recordServiceRfpCoreDelivery } = await import("./service-rfp-core-alert");
    await recordServiceRfpCoreDelivery(outcome);
  })();

  // recordServiceRfpCoreDelivery never throws by contract, but the dynamic import can — and a promise
  // this function may stop awaiting must never surface as an unhandledRejection.
  const guarded = dispatch.catch((error: any) => {
    log(`[service-rfp-core] Alert dispatch failed: ${error?.message || error}`, "sync");
  });

  const SLOW = Symbol("alert-dispatch-slow");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcomeOfRace = await Promise.race([
    guarded.then(() => undefined),
    new Promise<typeof SLOW>((resolve) => {
      timer = setTimeout(() => resolve(SLOW), ALERT_DISPATCH_WAIT_MS);
    }),
  ]);
  // Cleared on the fast path too, so a delivery that took 20 ms does not leave a live 2 s timer behind.
  clearTimeout(timer);

  if (outcomeOfRace === SLOW) {
    log(`[service-rfp-core] Alert dispatch is slow (>${ALERT_DISPATCH_WAIT_MS}ms); continuing without it`, "sync");
  }
}

function rowsOf(result: unknown): any[] {
  return Array.isArray(result) ? result : ((result as any)?.rows ?? []);
}

// ── Wire coercion ────────────────────────────────────────────────────────────
//
// Core's boundedString rejects a string that is untrimmed, empty, over-length, or contains ANY C0/C1
// control character — newlines included. A CRM description is routinely multi-line, so a raw
// pass-through would make every such approval a permanent 400 at the boundary. These coercions are
// therefore not cosmetic: they are what keeps a real description deliverable at all.

const MONEY_RE = /^(?:0|[1-9]\d{0,11})\.\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Core's canonical uuid: lowercase, with the variant nibble pinned. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Core's per-field bounds. `description`/`notes` are this producer's own cap under the 32 KiB body. */
const MAX = {
  companyName: 200,
  contactName: 200,
  phone: 64,
  email: 320,
  title: 300,
  propertyName: 300,
  projectNumber: 64,
  line: 200,
  city: 100,
  state: 100,
  postalCode: 32,
  description: 2_000,
} as const;

function wireString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= max) return collapsed;
  // Truncate rather than refuse: Procore still receives the full text, and losing the tail of a
  // description is strictly better than the job never reaching Core's estimating lane at all.
  return `${collapsed.slice(0, max - 1).trim()}…`;
}

function wireUuid(value: unknown): string | null {
  const raw = wireString(value, 36)?.toLowerCase();
  return raw && UUID_RE.test(raw) ? raw : null;
}

/** `amount` is a JS number upstream; Core wants a fixed-scale decimal string. */
function wireMoney(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0 || numeric >= 1e12) return null;
  const fixed = numeric.toFixed(2);
  return MONEY_RE.test(fixed) ? fixed : null;
}

function wireTimestamp(value: unknown): string | null {
  const raw = wireString(value, 64);
  if (!raw) return null;
  const ms = Date.parse(raw);
  // Core refuses a year before 2000 outright, so a garbage date is dropped here rather than sent.
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1)) return null;
  return new Date(ms).toISOString();
}

/**
 * Core requires /^[A-Z]{2}$/ and rejects the WHOLE address otherwise. Everything T-Rock bids is
 * domestic and the CRM's country field is free text that is usually blank, so an unrecognised value
 * resolves to US rather than discarding a real street address over a formatting detail.
 */
function wireCountry(value: unknown): string {
  const raw = wireString(value, 32)?.toUpperCase();
  if (raw && /^[A-Z]{2}$/.test(raw)) return raw;
  return "US";
}

// ── Payload ──────────────────────────────────────────────────────────────────

/** Closed vocabulary. A refusal is recorded and alerted, never silently dropped. */
export type ServiceRfpSkipReason =
  | "source_system_unsupported"
  | "office_unmapped"
  | "missing_crm_identity"
  | "missing_required_field";

export interface ServiceRfpHandoffInput {
  sourceSystem: string;
  sourceDealId: string;
  rfpRequestId: number;
  /** The POST-type-rewrite project number, so Core records the number the RFP actually assigned. */
  projectNumber: string;
  dealData: Record<string, any>;
  /**
   * The SAME object handed to createBidBoardProjectFromDeal. Both payloads are derived from it so the
   * two systems cannot receive different values for one approval.
   */
  editedFieldsOverride: Record<string, string>;
  approvedAt?: Date;
}

export type ServiceRfpBodyResult =
  | { ok: true; office: string; body: ServiceRfpApprovedBody }
  | { ok: false; reason: ServiceRfpSkipReason; detail: string };

/**
 * The effective value of a deal field, resolving edits exactly the way
 * createBidBoardProjectFromDeal's own `get` does: a trimmed non-empty edited value wins, otherwise the
 * cached deal field. Reproducing that rule here is what makes "one source of truth" structural rather
 * than a comment — the same input yields the same value on both sides.
 */
function effectiveField(input: ServiceRfpHandoffInput, key: string): unknown {
  const edited = input.editedFieldsOverride[key];
  if (edited && String(edited).trim()) return String(edited).trim();
  return input.dealData[key];
}

/** Pure. Builds the exact v1 body, or names the reason this approval cannot be represented. */
export function buildServiceRfpApprovedBody(input: ServiceRfpHandoffInput): ServiceRfpBodyResult {
  // v1 accepts CRM-sourced RFPs only. Core's bid.crm_deal_id, company.crm_company_id and
  // project.crm_deal_id are all `uuid`, so a HubSpot numeric deal id cannot be represented at all —
  // this is a shape limit, not a policy, and widening it means widening three live uuid columns.
  if (input.sourceSystem !== "trock_crm") {
    return { ok: false, reason: "source_system_unsupported", detail: `source system ${input.sourceSystem} has no uuid identity Core can store` };
  }

  // No office check. There used to be one, deriving the tenant from the project-number prefix and
  // refusing anything that was not DFW — which rejected two real Atlanta approvals. The prefix records
  // the MARKET the work is in, not the office that runs it; Atlanta jobs are run out of DFW like the
  // rest. There is one operating office, so there is nothing here to decide.
  const office = coreRfpTenant();

  const dealId = wireUuid(input.sourceDealId);
  const companyId = wireUuid(input.dealData.crm_company_id);
  const propertyId = wireUuid(input.dealData.crm_property_id);
  if (!dealId || !companyId || !propertyId) {
    // The uuids arrive from the CRM's RFP payload. Absent means the CRM has not been deployed with
    // them yet, or the deal genuinely has no company/property — either way Core cannot resolve the
    // customer or the job site, so this is terminal and visible rather than a crash or a guess.
    const missing = [!dealId && "deal", !companyId && "company", !propertyId && "property"].filter(Boolean).join(", ");
    return { ok: false, reason: "missing_crm_identity", detail: `CRM uuid missing or non-canonical: ${missing}` };
  }

  const title = wireString(effectiveField(input, "dealname"), MAX.title);
  const companyName = wireString(effectiveField(input, "company_name"), MAX.companyName);
  const contactName = wireString(effectiveField(input, "contact_name"), MAX.contactName);
  const contactEmail = wireString(effectiveField(input, "client_email"), MAX.email);
  const rfpProjectNumber = wireString(input.projectNumber, MAX.projectNumber);
  if (!title || !companyName || !contactName || !contactEmail || !EMAIL_RE.test(contactEmail) || !rfpProjectNumber) {
    const missing = [
      !title && "bid title",
      !companyName && "company name",
      !contactName && "contact name",
      (!contactEmail || !EMAIL_RE.test(contactEmail)) && "contact email",
      !rfpProjectNumber && "project number",
    ].filter(Boolean).join(", ");
    return { ok: false, reason: "missing_required_field", detail: `Core requires: ${missing}` };
  }

  // Same fallback chain the Procore create uses, so the two descriptions are the same string. `notes`
  // is deliberately NOT mapped to bid.notes: upstream it is a verbatim copy of `description`, and
  // crm_activity_log is kept out of both systems' description fields.
  const description =
    wireString(effectiveField(input, "description"), MAX.description)
    ?? wireString(input.dealData.project_description__briefly_describe_the_project_, MAX.description)
    ?? wireString(input.dealData.project_description, MAX.description)
    ?? wireString(input.dealData.notes, MAX.description);

  const line1 = wireString(effectiveField(input, "address"), MAX.line);
  const city = wireString(effectiveField(input, "city"), MAX.city);
  const state = wireString(effectiveField(input, "state"), MAX.state);
  const postalCode = wireString(effectiveField(input, "zip"), MAX.postalCode);
  const address: ServiceRfpAddress | null =
    line1 && city && state && postalCode
      ? { line1, line2: null, city, state, postalCode, country: wireCountry(effectiveField(input, "country")) }
      : null;

  // The CRM's RFP payload carries the property's uuid but not its NAME, so the name is derived. It is
  // display-only — the property is resolved by crm_property_id — and the street address is the most
  // useful label for a job site; the bid title is the same fallback Core's own attach-project door
  // uses when it has nothing better.
  const propertyName =
    wireString(effectiveField(input, "address"), MAX.propertyName)
    ?? wireString(input.dealData.project_location, MAX.propertyName)
    ?? title;

  const approvedAt = input.approvedAt ?? new Date();
  return {
    ok: true,
    office,
    body: {
      version: SERVICE_RFP_CONTRACT_VERSION,
      office,
      // Re-stamped on every delivery attempt; see stampOccurredAt.
      occurredAt: approvedAt.toISOString(),
      rfp: { requestId: input.rfpRequestId, approvedAt: approvedAt.toISOString() },
      deal: { id: dealId, rfpProjectNumber },
      company: { id: companyId, name: companyName },
      primaryContact: {
        name: contactName,
        email: contactEmail,
        businessPhone: wireString(effectiveField(input, "client_phone"), MAX.phone),
      },
      bid: {
        title,
        estimatedValue: wireMoney(effectiveField(input, "amount")),
        dueAt: wireTimestamp(effectiveField(input, "bid_due_date")) ?? wireTimestamp(effectiveField(input, "due_date")),
        description,
        notes: null,
      },
      property: { id: propertyId, name: propertyName, address },
    },
  };
}

/**
 * Core enforces a five-minute event-age window on `occurredAt`, so a stored payload replayed by the
 * backoff worker would 401 on every attempt after the first two intervals. The transport instant is
 * therefore re-stamped at send time; `rfp.approvedAt` is the field that preserves when the human
 * actually approved, and it is never rewritten.
 */
function stampOccurredAt(body: ServiceRfpApprovedBody): ServiceRfpApprovedBody {
  return { ...body, occurredAt: new Date().toISOString() };
}

// ── Row lifecycle ────────────────────────────────────────────────────────────

interface EnqueuedRow {
  id: number;
  attemptCount: number;
  maxAttempts: number;
}

/**
 * Insert the row. Returns null when one already exists for this (source system, deal, request) —
 * processRfpApproval is not idempotent and both entry points are fire-and-forget behind a 202, so a
 * concurrent re-entry must find the work already owned and post nothing.
 *
 * `attemptCount` starts at 1 for a deliverable row because the caller attempts inline immediately.
 */
async function insertOutboxRow(input: {
  sourceSystem: string;
  sourceDealId: string;
  rfpRequestId: number;
  payload: unknown;
  targetUrl: string | null;
  status: "pending" | "failed";
  lastError: string | null;
}): Promise<EnqueuedRow | null> {
  const db = await getDb();
  const attemptCount = input.status === "pending" ? 1 : 0;
  const result = await db.execute(sql`
    INSERT INTO service_rfp_core_outbox
      (source_system, source_deal_id, rfp_request_id, payload, target_url, status, attempt_count, max_attempts, last_error, last_attempt_at, next_attempt_at)
    VALUES (
      ${input.sourceSystem}, ${input.sourceDealId}, ${input.rfpRequestId},
      ${JSON.stringify(input.payload)}::jsonb, ${input.targetUrl}, ${input.status},
      ${attemptCount}, ${SERVICE_RFP_CORE_MAX_ATTEMPTS}, ${input.lastError},
      ${input.status === "pending" ? sql`NOW()` : sql`NULL`},
      NOW() + interval '30 seconds'
    )
    -- A PRE-POST REFUSAL IS THE ONE ROW A RE-APPROVAL MAY REPLACE [Codex #75].
    --
    -- DO NOTHING alone made a correctable refusal permanent. A row refused before any POST — missing CRM
    -- uuids, an office with no Core tenant — holds only the reason, carries target_url NULL, and is never
    -- claimable (the drain requires target_url IS NOT NULL). Once the data is fixed, re-approving the same
    -- request hits this unique triple, returns 'duplicate', and delivers nothing: the approval could never
    -- reach Core again without hand-editing the table.
    --
    -- So a TERMINAL row is UPGRADED in place when a later attempt can actually be delivered.
    --
    -- 'failed' OR 'dead', NOT only the never-sent ones. The first version required 'target_url IS NULL',
    -- which covered pre-POST refusals and MISSED THE CASE IT WAS WRITTEN FOR: a Core 4xx (a customer not
    -- yet linked to its CRM id) leaves the row 'failed' WITH a target_url, and an exhausted retry ladder
    -- leaves it 'dead'. Both are correctable, and both were excluded [Codex #83].
    --
    -- 'pending' and 'sent' stay excluded, for different reasons. A pending row is IN FLIGHT and
    -- overwriting it races the worker. A sent row already delivered — and while re-driving one would be
    -- harmless, because Core's semantic digest answers 'noop' to an exact redelivery, allowing it invites
    -- the reading that this is how you resend, which it is not.
    --
    -- That idempotency is what makes widening this safe at all: a row that reached Core and lost its
    -- response can be re-driven without minting a second bid, because Core recognises the delivery.
    --
    -- attempt_count RESETS, because the prior attempts were of a body that could not be sent at all; they
    -- are not evidence about this one, and inheriting them would dead-letter the corrected delivery early.
    ON CONFLICT (source_system, source_deal_id, rfp_request_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          target_url = EXCLUDED.target_url,
          status = EXCLUDED.status,
          attempt_count = EXCLUDED.attempt_count,
          last_error = EXCLUDED.last_error,
          last_attempt_at = EXCLUDED.last_attempt_at,
          next_attempt_at = EXCLUDED.next_attempt_at
      WHERE service_rfp_core_outbox.status IN ('failed', 'dead')
        AND EXCLUDED.target_url IS NOT NULL
    RETURNING id, attempt_count, max_attempts
  `);
  const row = rowsOf(result)[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    attemptCount: Number(row.attempt_count ?? attemptCount),
    maxAttempts: Number(row.max_attempts ?? SERVICE_RFP_CORE_MAX_ATTEMPTS),
  };
}

async function markSent(id: number, status: number, bidId: string | null): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET status = 'sent',
           sent_at = NOW(),
           last_attempt_at = NOW(),
           last_status_code = ${status},
           core_bid_id = ${bidId},
           last_error = NULL
     WHERE id = ${id}
  `);
}

async function markTerminal(id: number, error: string, status?: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET status = 'failed',
           last_error = ${error},
           last_status_code = ${status ?? null},
           last_attempt_at = NOW()
     WHERE id = ${id}
  `);
}

/** Leave the row queued on the backoff schedule, or dead-letter it at the attempt ceiling. */
async function markRetryable(row: EnqueuedRow, error: string, status?: number): Promise<{ dead: boolean }> {
  const db = await getDb();
  if (row.attemptCount >= row.maxAttempts) {
    await db.execute(sql`
      UPDATE service_rfp_core_outbox
         SET status = 'dead',
             last_error = ${error},
             last_status_code = ${status ?? null},
             last_attempt_at = NOW()
       WHERE id = ${row.id}
    `);
    return { dead: true };
  }
  const backoff =
    SERVICE_RFP_CORE_BACKOFF_INTERVALS[
      Math.max(0, Math.min(row.attemptCount - 1, SERVICE_RFP_CORE_BACKOFF_INTERVALS.length - 1))
    ];
  await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET status = 'pending',
           last_error = ${error},
           last_status_code = ${status ?? null},
           last_attempt_at = NOW(),
           next_attempt_at = NOW() + ${backoff}::interval
     WHERE id = ${row.id}
  `);
  return { dead: false };
}

/**
 * One delivery attempt for an already-persisted row. The POST itself cannot throw (a transport
 * failure is an ordinary retryable outcome); a throw from here can only be the DB write recording the
 * result, and both call paths — the producer's try/catch and the drain's per-row catch — contain it.
 */
async function deliver(
  row: EnqueuedRow & { targetUrl: string; body: ServiceRfpApprovedBody; office: string | null },
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string } = {},
): Promise<"sent" | "failed" | "pending" | "dead"> {
  const secret = deps.secret ?? resolveServiceRfpIngressSecret();
  if (!secret) {
    // Unprovisioned or too short for Core's 32-byte floor. Retryable: an operator sets the value and
    // the queued row drains without the approval having to be repeated.
    //
    // It is NOT exempt from the attempt ceiling, though — every worker claim burns an attempt whether
    // or not a POST goes out — so this row does eventually stop being retried. Discarding
    // markRetryable's `dead` and always reporting 'pending' is how that happened in silence: the row
    // dead-lettered with no alert, and restoring the secret afterwards then delivered nothing, because
    // a 'dead' row is never claimed again.
    const error = "SERVICE_RFP_INGRESS_SECRET_CURRENT is missing or shorter than 32 bytes";
    const { dead } = await markRetryable(row, error);
    if (dead) {
      await reportDelivery({ office: row.office, ok: false, attempts: row.attemptCount, error, terminal: false });
    }
    log(
      `[service-rfp-core] Row ${row.id} has no usable ingress secret; ${dead ? "dead-lettered" : "queued for retry"}`,
      "sync",
    );
    return dead ? "dead" : "pending";
  }

  const outcome = await postServiceRfpApproved(
    { targetUrl: row.targetUrl, body: stampOccurredAt(row.body), secret },
    { fetchImpl: deps.fetchImpl },
  );

  if (outcome.kind === "sent") {
    await markSent(row.id, outcome.status, outcome.bidId);
    // The success is reported to the alerter, not only to the row. The namespaced alert state stays
    // 'failing' until an ok outcome flips it, so without this no recovery email is ever sent — and the
    // failure debounce keeps suppressing the NEXT incident as a repeat of one that already cleared,
    // however many successful deliveries happened in between.
    await reportDelivery({ office: row.office, ok: true, attempts: row.attemptCount, status: outcome.status });
    log(`[service-rfp-core] Row ${row.id} delivered to Core (bid ${outcome.bidId ?? "unknown"})`, "sync");
    return "sent";
  }

  if (outcome.kind === "terminal") {
    await markTerminal(row.id, outcome.error, outcome.status);
    await reportDelivery({
      office: row.office,
      ok: false,
      attempts: row.attemptCount,
      status: outcome.status,
      error: outcome.error,
      terminal: true,
    });
    log(`[service-rfp-core] Row ${row.id} refused by Core: ${outcome.error}`, "sync");
    return "failed";
  }

  const { dead } = await markRetryable(row, outcome.error, outcome.status);
  if (dead) {
    await reportDelivery({
      office: row.office,
      ok: false,
      attempts: row.attemptCount,
      status: outcome.status,
      error: outcome.error,
      terminal: false,
    });
  }
  log(`[service-rfp-core] Row ${row.id} not delivered (${outcome.error}); ${dead ? "dead-lettered" : "queued for retry"}`, "sync");
  return dead ? "dead" : "pending";
}

// ── The producer ─────────────────────────────────────────────────────────────

/**
 * Hand an approved service RFP to TROCK Core. Called from processRfpApproval AFTER the deal-cache
 * refresh and BEFORE createBidBoardProjectFromDeal, so the card exists in Core's service estimating
 * lane before the multi-minute Procore automation starts.
 *
 * FAIL-OPEN, absolutely: every failure mode ends in a return, never a throw. The caller does not
 * branch on the result, and the Procore create runs regardless.
 *
 * Inert until provisioned: with CORE_INGRESS_BASE_URL or SERVICE_RFP_INGRESS_SECRET_CURRENT unset,
 * nothing is written at all. That gate is checked BEFORE the refusal paths on purpose — alerting
 * about a HubSpot-sourced RFP while the whole integration is switched off would be noise about a
 * boundary nobody is watching yet.
 */
export async function handOffServiceRfpApprovalToCore(
  input: ServiceRfpHandoffInput,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string } = {},
): Promise<{ status: "skipped" | "sent" | "failed" | "pending" | "dead" | "duplicate" }> {
  try {
    const secret = deps.secret ?? resolveServiceRfpIngressSecret();
    const baseConfigured = Boolean(process.env.CORE_INGRESS_BASE_URL?.trim());
    if (!secret || !baseConfigured) {
      log("[service-rfp-core] Core ingress is not provisioned; skipping the service-RFP handoff", "sync");
      return { status: "skipped" };
    }

    const built = buildServiceRfpApprovedBody(input);
    if (!built.ok) {
      // Terminal, and LOUD. Not a silent drop: the row records what was refused and why, and the
      // alert makes the gap visible while the manual creation door is still open.
      const office = coreRfpTenant();
      const error = `${built.reason}: ${built.detail}`;
      const inserted = await insertOutboxRow({
        sourceSystem: input.sourceSystem,
        sourceDealId: input.sourceDealId,
        rfpRequestId: input.rfpRequestId,
        // No body exists for a refusal, so the payload records the facts that identify it instead.
        payload: { refused: built.reason, detail: built.detail, projectNumber: input.projectNumber },
        targetUrl: null,
        status: "failed",
        lastError: error,
      });
      if (!inserted) return { status: "duplicate" };
      await reportDelivery({ office, ok: false, attempts: 0, error, terminal: true });
      log(`[service-rfp-core] Service RFP ${input.rfpRequestId} cannot reach Core — ${error}`, "sync");
      return { status: "failed" };
    }

    const targetUrl = buildServiceRfpIngressTargetUrl(built.office);
    if (!targetUrl) {
      log("[service-rfp-core] CORE_INGRESS_BASE_URL is unusable; skipping the service-RFP handoff", "sync");
      return { status: "skipped" };
    }

    const inserted = await insertOutboxRow({
      sourceSystem: input.sourceSystem,
      sourceDealId: input.sourceDealId,
      rfpRequestId: input.rfpRequestId,
      payload: built.body,
      targetUrl,
      status: "pending",
      lastError: null,
    });
    // A concurrent re-entry already owns this approval; posting again would be a second delivery.
    if (!inserted) return { status: "duplicate" };

    const result = await deliver({ ...inserted, targetUrl, body: built.body, office: built.office }, deps);
    return { status: result };
  } catch (error: any) {
    // The Core handoff must never fail an approval. Swallow, log, and let the worker (or a human
    // reading the alert) pick it up.
    log(`[service-rfp-core] Handoff failed for RFP request ${input.rfpRequestId}: ${error?.message || error}`, "sync");
    return { status: "skipped" };
  }
}

// ── The drain ────────────────────────────────────────────────────────────────

/**
 * Claim due rows. `status = 'pending'` is the type filter as well as the readiness filter: a terminal
 * refusal row (no target_url) is never claimable, and no other worker's claim query can reach this
 * table at all — which is the whole reason the command has its own table.
 */
export async function claimPendingServiceRfpCoreRows(limit = 5): Promise<any[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE service_rfp_core_outbox
       SET last_attempt_at = NOW(),
           attempt_count = attempt_count + 1,
           next_attempt_at = NOW() + interval '5 minutes'
     WHERE id IN (
       SELECT id
         FROM service_rfp_core_outbox
        WHERE status = 'pending'
          AND target_url IS NOT NULL
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return rowsOf(result);
}

export async function processServiceRfpCoreOutbox(
  options: { limit?: number; fetchImpl?: typeof fetchWithTimeout; secret?: string } = {},
): Promise<{ processed: number; sent: number; failed: number }> {
  if (outboxWorkerRunning) return { processed: 0, sent: 0, failed: 0 };
  outboxWorkerRunning = true;
  let sent = 0;
  let failed = 0;

  try {
    const rows = await claimPendingServiceRfpCoreRows(options.limit ?? 5);
    for (const row of rows) {
      try {
        const outcome = await deliver(
          {
            id: Number(row.id),
            attemptCount: Number(row.attempt_count ?? 0),
            maxAttempts: Number(row.max_attempts ?? SERVICE_RFP_CORE_MAX_ATTEMPTS),
            targetUrl: String(row.target_url),
            body: row.payload as ServiceRfpApprovedBody,
            office: (row.payload as ServiceRfpApprovedBody)?.office ?? null,
          },
          { fetchImpl: options.fetchImpl, secret: options.secret },
        );
        if (outcome === "sent") sent += 1;
        else failed += 1;
      } catch (error: any) {
        failed += 1;
        log(`[service-rfp-core] Row ${row.id} delivery threw: ${error?.message || error}`, "sync");
      }
    }
    return { processed: rows.length, sent, failed };
  } finally {
    outboxWorkerRunning = false;
  }
}

/**
 * Assert the outbox TABLE is actually there, once, at startup.
 *
 * WHY THIS EXISTS. Migration 0025 creates `service_rfp_core_outbox`, and NOTHING migrates this database on
 * deploy — so the table can be absent on a service whose code, secret and base URL are all correctly
 * provisioned. That combination is worse than being unconfigured, because `handOffServiceRfpApprovalToCore`
 * is deliberately FAIL-OPEN: its catch-all swallows the failed insert, returns `skipped`, and the approval
 * proceeds to Procore exactly as before. The Core delivery is then dropped with no outbox row, no retry and
 * no alert — the feature reports healthy and silently does nothing.
 *
 * That is not hypothetical; it is what this deployment did the first time it was provisioned, and the only
 * symptom was a worker tick line. So the check is at STARTUP rather than inside the handoff: it must fire
 * without waiting for an approval to be lost, and it must be loud enough to read as a provisioning error
 * rather than as routine noise.
 *
 * It never throws. A boot that dies on a missing table would take the whole RFP flow — Procore automation
 * included — down with it, which trades a silent gap for an outage. Reporting and continuing is the same
 * fail-open posture the handoff takes, made VISIBLE.
 */
/** Whether the probe has reached a CONCLUSIVE answer. Inconclusive attempts do not settle it. */
let outboxPreflightSettled = false;

/** Test seam: forget the settled verdict so each case starts from an unprobed worker. */
export function resetServiceRfpPreflightForTests(): void {
  outboxPreflightSettled = false;
}

/**
 * Assert the outbox TABLE is there. Returns its verdict so a caller — and a test — can AWAIT it.
 *
 * Returning the verdict rather than void is not cosmetic [Codex #75]. The first version was
 * fire-and-forget, so `Worker started` (logged synchronously) could land before the probe had run at all;
 * a test that waited for that line and then asserted "no PROVISIONING ERROR" passed whether or not the
 * present-table guard worked. Codex confirmed it: the test still passed with `if (present) return`
 * deleted. An assertion that cannot fail is worse than no assertion, because it reads as coverage.
 *
 * INCONCLUSIVE IS NOT ABSENT and is not final either. If the connection is down at startup but recovers
 * while the table really is missing, a one-shot probe would log its generic verification failure once and
 * never speak again — leaving only the raw `relation ... does not exist` tick noise this exists to
 * replace, which is exactly the operator experience it was written to prevent. So only a definite
 * present/absent answer settles it; anything else is retried on the next tick.
 *
 * Still never throws: a boot that died here would take the Procore automation down with it.
 */
export async function preflightOutboxTable(): Promise<"present" | "missing" | "inconclusive"> {
  try {
    const db = await getDb();
    const probe = await db.execute<{ rc: string | null }>(
      sql`select to_regclass('public.service_rfp_core_outbox')::text as rc`,
    );
    const present = Boolean((probe as any).rows?.[0]?.rc ?? (probe as any)[0]?.rc);
    outboxPreflightSettled = true;
    if (present) return "present";
    log(
      "[service-rfp-core] PROVISIONING ERROR: table service_rfp_core_outbox is MISSING. " +
        "Approved service RFPs will NOT reach TROCK Core, and because the handoff is fail-open they will " +
        "be dropped silently — no outbox row, no retry, no alert. Apply migrations/0025_create_service_rfp_core_outbox.sql.",
      "sync",
    );
    return "missing";
  } catch (error: any) {
    // A probe that cannot run is not evidence the table is missing, and must not be reported as if it
    // were. Left UNSETTLED so the next tick asks again.
    log(`[service-rfp-core] Could not verify the outbox table: ${error?.message || error}`, "sync");
    return "inconclusive";
  }
}

export function startServiceRfpCoreOutboxWorker(intervalMs = 30_000): void {
  if (outboxWorkerTimer) return;
  void preflightOutboxTable();
  outboxWorkerTimer = setInterval(() => {
    // Re-probe until the answer is CONCLUSIVE. A startup probe that could not reach the database proves
    // nothing, and without this the migration-specific diagnosis would never be emitted for the very
    // case it exists to catch — a transient outage at boot over a genuinely missing table.
    if (!outboxPreflightSettled) void preflightOutboxTable();
    processServiceRfpCoreOutbox().catch((error) => {
      log(`[service-rfp-core] Worker tick failed: ${error?.message || error}`, "sync");
    });
  }, intervalMs);
  log(`[service-rfp-core] Worker started (${intervalMs}ms)`, "sync");
}

export function stopServiceRfpCoreOutboxWorker(): void {
  if (!outboxWorkerTimer) return;
  clearInterval(outboxWorkerTimer);
  outboxWorkerTimer = null;
}
