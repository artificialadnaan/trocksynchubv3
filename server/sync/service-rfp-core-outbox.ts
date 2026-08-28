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
import { officeTenantForPrefix, parseOfficePrefixFromNumber } from "../constants";
import {
  SERVICE_RFP_CONTRACT_VERSION,
  buildServiceRfpIngressTargetUrl,
  postServiceRfpApproved,
  resolveServiceRfpIngressSecret,
  type ServiceRfpAddress,
  type ServiceRfpApprovedBody,
} from "./core-ingress-client";

const BACKOFF_INTERVALS = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"] as const;
const MAX_ATTEMPTS = 5;
let outboxWorkerTimer: ReturnType<typeof setInterval> | null = null;
let outboxWorkerRunning = false;

// Both of these are dynamic on purpose, matching bidboard-callback-worker's getDb(). `../db`
// THROWS at import time without DATABASE_URL, and bidboard-crm-alert imports its pool statically —
// so a static import here would drag that throw into rfp-approval.ts's own module graph and take
// every suite that imports the approval path down with it.
async function getDb() {
  return (await import("../db")).db;
}

async function getAlerter() {
  return (await import("./bidboard-crm-alert")).recordPushOutcomeAndMaybeAlert;
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

  const officePrefix = parseOfficePrefixFromNumber(input.projectNumber);
  const office = officeTenantForPrefix(officePrefix);
  if (!office) {
    return { ok: false, reason: "office_unmapped", detail: `office ${officePrefix ?? "unknown"} has no TROCK Core tenant` };
  }

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

/**
 * Alert state is keyed by office_slug in a table the Bid Board → CRM push already writes under the
 * bare slug ("dallas"). Namespacing keeps the two streams from sharing one row, where a Core failure
 * would suppress the push's recovery email and vice versa.
 */
function alertOffice(office: string | null): string {
  return `service-rfp-core:${office ?? "unmapped"}`;
}

async function raiseAlert(args: { office: string | null; attempts: number; status?: number; error: string; terminal: boolean }): Promise<void> {
  const recordPushOutcomeAndMaybeAlert = await getAlerter();
  await recordPushOutcomeAndMaybeAlert({
    pushResult: {
      ok: false,
      attempts: args.attempts,
      status: args.status,
      error: args.error,
      // A refusal that will never be accepted as-is maps to the 'request_rejected' wording; a
      // dead-lettered retry maps to 'terminal_failure'.
      rejected: args.terminal,
      terminalFailure: !args.terminal,
    },
    officeSlug: alertOffice(args.office),
  });
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
      ${attemptCount}, ${MAX_ATTEMPTS}, ${input.lastError},
      ${input.status === "pending" ? sql`NOW()` : sql`NULL`},
      NOW() + interval '30 seconds'
    )
    ON CONFLICT (source_system, source_deal_id, rfp_request_id) DO NOTHING
    RETURNING id, attempt_count, max_attempts
  `);
  const row = rowsOf(result)[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    attemptCount: Number(row.attempt_count ?? attemptCount),
    maxAttempts: Number(row.max_attempts ?? MAX_ATTEMPTS),
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
  const backoff = BACKOFF_INTERVALS[Math.max(0, Math.min(row.attemptCount - 1, BACKOFF_INTERVALS.length - 1))];
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
    await markRetryable(row, "SERVICE_RFP_INGRESS_SECRET_CURRENT is missing or shorter than 32 bytes");
    return "pending";
  }

  const outcome = await postServiceRfpApproved(
    { targetUrl: row.targetUrl, body: stampOccurredAt(row.body), secret },
    { fetchImpl: deps.fetchImpl },
  );

  if (outcome.kind === "sent") {
    await markSent(row.id, outcome.status, outcome.bidId);
    log(`[service-rfp-core] Row ${row.id} delivered to Core (bid ${outcome.bidId ?? "unknown"})`, "sync");
    return "sent";
  }

  if (outcome.kind === "terminal") {
    await markTerminal(row.id, outcome.error, outcome.status);
    await raiseAlert({ office: row.office, attempts: row.attemptCount, status: outcome.status, error: outcome.error, terminal: true });
    log(`[service-rfp-core] Row ${row.id} refused by Core: ${outcome.error}`, "sync");
    return "failed";
  }

  const { dead } = await markRetryable(row, outcome.error, outcome.status);
  if (dead) {
    await raiseAlert({ office: row.office, attempts: row.attemptCount, status: outcome.status, error: outcome.error, terminal: false });
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
      const office = officeTenantForPrefix(parseOfficePrefixFromNumber(input.projectNumber));
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
      await raiseAlert({ office, attempts: 0, error, terminal: true });
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
            maxAttempts: Number(row.max_attempts ?? MAX_ATTEMPTS),
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

export function startServiceRfpCoreOutboxWorker(intervalMs = 30_000): void {
  if (outboxWorkerTimer) return;
  outboxWorkerTimer = setInterval(() => {
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
