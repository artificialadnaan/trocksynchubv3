/**
 * RFP Phase 2, S1a (CONTRACT v2.4 §5 / §6 / §7 / §10): the WIRE of the Core path, with no I/O.
 *   E2  SyncHub → Core  POST /webhooks/crm/<office>/rfp-bid-create/v1         (domain trock.crm.rfp-bid-create.v1)
 *   E4  SyncHub → CRM   POST /api/internal/core-bid-created                   (bid-board-created's HMAC)
 *   E5  SyncHub → Core  POST /webhooks/crm/<office>/rfp-bid-create/v1/linked  (domain trock.crm.rfp-bid-create-linked.v1)
 *   N1  SyncHub → CRM   POST /api/internal/rfp-core-notice                  (bid-board-created's HMAC)
 * The bodies, the classifiers of each answer, the 30 s / 2 m / 10 m / 30 m / 2 h (6-attempt) schedule and the stable N1
 * noticeId live here, so the drains (rfp-core-sender.ts, rfp-core-followup.ts) only move rows. Wire details follow the
 * counterpart code where it is more specific than the contract (Core 3e13ff2e rfp-bid-create.contract.ts / .routes.ts;
 * CRM PR-B 5f1109d8 internal-rfp/core-bid-created-service.ts / routes.ts).
 */
import type { CreateFromRfpInput } from "../routes/rfp-requests";
import { MIN_INGRESS_SECRET_BYTES, signCoreIngress, validCoreIngressBase } from "./core-ingress-client";
import { wireCompanyBillAddress } from "./service-rfp-core-outbox";

export const RFP_BID_CREATE_DOMAIN = "trock.crm.rfp-bid-create.v1" as const;
export const RFP_BID_CREATE_LINKED_DOMAIN = "trock.crm.rfp-bid-create-linked.v1" as const;
/** The dallas office and its paths: the golden vectors' path (V1 / V2) and Core 3e13ff2e's only mounted office. */
export const RFP_BID_CREATE_OFFICE = "dallas" as const;
export const RFP_BID_CREATE_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1";
export const RFP_BID_CREATE_LINKED_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1/linked";
/**
 * r2 (d9 ruling 5): the offices the Core path serves. E1's CRM `office` is carried END TO END: it picks the Core path
 * (/webhooks/crm/<office>/rfp-bid-create/v1 and …/linked), it is the E2 body's `office`, and E4 / N1 carry it. Any other
 * or missing office is refused before sending (office_not_supported). NOT server/constants.ts CORE_RFP_TENANT, which
 * belongs to the service-RFP handoff only.
 */
export const RFP_BID_CREATE_OFFICES = ["dallas", "atlanta"] as const;
export type RfpBidCreateOffice = (typeof RFP_BID_CREATE_OFFICES)[number];
export const CRM_CORE_BID_CREATED_PATH = "/api/internal/core-bid-created";
export const CRM_RFP_CORE_NOTICE_PATH = "/api/internal/rfp-core-notice";
/** Its OWN key (§5): never the service-RFP key. */
export const RFP_BID_CREATE_SECRET_ENV = "RFP_BID_CREATE_INGRESS_SECRET_CURRENT";

/** The wait BEFORE each retry (§10): attempt N+1 fires this long after attempt N fails. */
export const RFP_CORE_BACKOFF_INTERVALS = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"] as const;
/** Six attempts (five waits between them); the sixth failure dead-letters E2 / E4 / N1 (§10). */
export const RFP_CORE_MAX_ATTEMPTS = RFP_CORE_BACKOFF_INTERVALS.length + 1;
/** E5 after the schedule: every 2 h until confirmed, never dead (§7). */
export const RFP_CORE_CONFIRM_RETRY_INTERVAL = "2 hours";
/** 12 post-schedule retries at 2 h = one day: the cadence of the "still delayed" ops alert (§7). */
export const RFP_CORE_CONFIRM_ALERT_EVERY = 12;
/** The table every N1 row lives in: the noticeId's table prefix (§10, b8 C3). */
export const RFP_CORE_NOTICE_TABLE = "rfp_core_followup_outbox";

export type RfpCoreNoticeKind = "core_link_confirm_pending" | "core_link_confirmed" | "core_bid_orphan" | "core_bid_link_refused";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Auth + targets ──────────────────────────────────────────────────────────────────────────────────────────────────

/** E2's `x-trock-signature`: domain ‖ 0x00 ‖ POST ‖ 0x00 ‖ path ‖ 0x00 ‖ raw body (Core crm-ingress/auth.ts preimage). */
export function signRfpBidCreate(input: { path: string; rawBody: string; secret: string }): string {
  return signCoreIngress({ ...input, domain: RFP_BID_CREATE_DOMAIN });
}

/** E5's `x-trock-signature`, the same frame under the -linked domain. */
export function signRfpBidCreateLinked(input: { path: string; rawBody: string; secret: string }): string {
  return signCoreIngress({ ...input, domain: RFP_BID_CREATE_LINKED_DOMAIN });
}

/** RFP_BID_CREATE_INGRESS_SECRET_CURRENT, or null when unset or shorter than Core's 32-byte minimum (inert, never a 401). */
export function resolveRfpBidCreateIngressSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env[RFP_BID_CREATE_SECRET_ENV] ?? "").trim();
  if (!secret) return null;
  return Buffer.byteLength(secret, "utf8") >= MIN_INGRESS_SECRET_BYTES ? secret : null;
}

/** E1's office when it is one the Core path serves (exact, after trim; the CRM sends lowercase slugs), else null. */
export function resolveRfpBidCreateOffice(value: unknown): RfpBidCreateOffice | null {
  if (typeof value !== "string") return null;
  const office = value.trim();
  return (RFP_BID_CREATE_OFFICES as readonly string[]).includes(office) ? (office as RfpBidCreateOffice) : null;
}

/** CORE_INGRESS_BASE_URL (https, no query / fragment) + /webhooks/crm/<office>/rfp-bid-create/v1; null for another office. */
export function buildRfpBidCreateOfficeTargetUrl(office: string, baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  const supported = resolveRfpBidCreateOffice(office);
  const base = validCoreIngressBase(baseUrl);
  return supported && base ? `${base}/webhooks/crm/${supported}/rfp-bid-create/v1` : null;
}

/** …and E5's /webhooks/crm/<office>/rfp-bid-create/v1/linked. */
export function buildRfpBidCreateLinkedOfficeTargetUrl(office: string, baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  const url = buildRfpBidCreateOfficeTargetUrl(office, baseUrl);
  return url ? `${url}/linked` : null;
}

/** CORE_INGRESS_BASE_URL (https, no query / fragment: the shared guard) + the dallas E2 path, or null. */
export function buildRfpBidCreateTargetUrl(baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  const base = validCoreIngressBase(baseUrl);
  return base ? `${base}${RFP_BID_CREATE_PATH}` : null;
}

export function buildRfpBidCreateLinkedTargetUrl(baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  const base = validCoreIngressBase(baseUrl);
  return base ? `${base}${RFP_BID_CREATE_LINKED_PATH}` : null;
}

/** TROCK_CRM_BASE_URL + an internal path, trimmed exactly as buildBidBoardCreatedCallbackTargetUrl does; null when unset. */
export function buildCrmInternalTargetUrl(path: string, baseUrl: string | undefined = process.env.TROCK_CRM_BASE_URL): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}${path}` : null;
}

// ── E2 body (§5) ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RfpBidCreateBody {
  version: typeof RFP_BID_CREATE_DOMAIN;
  office: RfpBidCreateOffice;
  occurredAt: string;
  sourceEventId: string;
  approvalKind: string | null;
  approval: {
    roundEventId: string | null;
    approvals: number;
    rejections: number;
    invitedVoterCount: number;
    decidedAt: string;
  } | null;
  crmDealId: string;
  deal: {
    name: string;
    projectNumber: string | null;
    projectType: string | null;
    amount: number | null;
    estimator: string | null;
    estimatorEmail: null;
    ownerName: string | null;
    ownerEmail: string | null;
    ownerSource: string | null;
    scopeTitle: string | null;
    description: string | null;
    dueDate: string | null;
    workflowRoute: string | null;
  };
  company: { id: string; name: string | null; billAddress?: { address: string; city: string; state: string; zip: string } };
  property: {
    id: string;
    name: string | null;
    address: { street: string | null; city: string | null; state: string | null; zip: string | null; country: string | null } | null;
  } | null;
  contact: { name: string | null; email: string; phone: string | null } | null;
  attachments: Array<{ name: string; url: string; contentType: string }>;
  attachmentsOmitted: number;
  crmActivityLog: string | null;
}

export type RfpBidCreateBodyResult =
  | { ok: true; body: RfpBidCreateBody }
  | { ok: false; reason: "office_not_supported" | "company_missing" };

/** A nullable E1 string as Core parses it: absent / null / blank ⇒ null (Core refuses "" in a nullable field), else trimmed. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A UTC ISO instant (§5 dueDate), or null when absent / unparseable. */
function utcInstant(value: unknown): string | null {
  const raw = textOrNull(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * E1 → E2 (§5). `office` = E1's office when dallas | atlanta, else { ok:false, reason:"office_not_supported" } (r2, d9
 * ruling 5; checked first: without an office there is no Core path). `estimator` = the CRM's free-text NAME
 * (estimatorEmail always null); `dueDate` = a UTC ISO instant;
 * companyId null ⇒ { ok:false, reason:"company_missing" } (SyncHub pre-refuses, nothing is sent); property null when
 * propertyId is null, else E1's address keys verbatim; contact null unless clientEmail is valid; the rest verbatim.
 * Blank strings read as null (Core's nullable strings refuse ""). `approvalKind` prefers the command row's stamp (§2).
 * `company.billAddress` is present only when all four parts meet Core's rules (the service-RFP rule, reused): a
 * malformed one would be Core's 400 for the whole body.
 */
export function buildRfpBidCreateBody(
  input: CreateFromRfpInput,
  opts: { occurredAt: string; approvalKind?: string | null },
): RfpBidCreateBodyResult {
  const e1 = input as any;
  const d = (e1.deal ?? {}) as Record<string, any>;
  const office = resolveRfpBidCreateOffice(e1.office);
  if (!office) return { ok: false, reason: "office_not_supported" };
  const companyId = textOrNull(d.companyId);
  if (!companyId) return { ok: false, reason: "company_missing" };

  const a = e1.approval;
  const approval = a && typeof a === "object"
    ? {
        roundEventId: textOrNull(a.roundEventId),
        approvals: a.approvals,
        rejections: a.rejections,
        invitedVoterCount: a.invitedVoterCount,
        decidedAt: a.decidedAt,
      }
    : null;

  const billAddress = wireCompanyBillAddress(d.companyBillAddress);
  const propertyId = textOrNull(d.propertyId);
  const addr = d.address && typeof d.address === "object" ? d.address : null;
  const email = textOrNull(d.clientEmail);

  const body: RfpBidCreateBody = {
    version: RFP_BID_CREATE_DOMAIN,
    office,
    occurredAt: opts.occurredAt,
    sourceEventId: input.sourceEventId,
    approvalKind: textOrNull(opts.approvalKind) ?? textOrNull(e1.approvalKind),
    approval,
    crmDealId: input.sourceDealId,
    deal: {
      name: d.name,
      projectNumber: textOrNull(d.projectNumber),
      projectType: textOrNull(d.projectType),
      amount: typeof d.amount === "number" ? d.amount : null,
      estimator: textOrNull(d.estimator),
      estimatorEmail: null,
      ownerName: textOrNull(d.ownerName),
      ownerEmail: textOrNull(d.ownerEmail),
      ownerSource: textOrNull(d.ownerSource),
      scopeTitle: textOrNull(d.scopeTitle),
      description: textOrNull(d.description),
      dueDate: utcInstant(d.dueDate),
      workflowRoute: textOrNull(d.workflowRoute),
    },
    company: { id: companyId, name: textOrNull(d.companyName), ...(billAddress ? { billAddress } : {}) },
    property: propertyId
      ? {
          id: propertyId,
          name: textOrNull(d.propertyName),
          address: addr
            ? {
                street: textOrNull(addr.street),
                city: textOrNull(addr.city),
                state: textOrNull(addr.state),
                zip: textOrNull(addr.zip),
                country: textOrNull(addr.country),
              }
            : null,
        }
      : null,
    contact: email && EMAIL_RE.test(email)
      ? { name: textOrNull(d.contactName), email, phone: textOrNull(d.clientPhone) }
      : null,
    attachments: (Array.isArray(e1.attachments) ? e1.attachments : []).map((f: any) => ({
      name: f.name,
      url: f.url,
      contentType: f.contentType,
    })),
    attachmentsOmitted: typeof e1.attachmentsOmitted === "number" ? e1.attachmentsOmitted : 0,
    crmActivityLog: typeof d.crmActivityLog === "string" && d.crmActivityLog.trim() !== "" ? d.crmActivityLog : null,
  };
  return { ok: true, body };
}

// ── E4 / E5 / N1 bodies ─────────────────────────────────────────────────────────────────────────────────────────────

/** E4 (§6), the CRM's strict 9 keys (core-bid-created-service.ts CORE_BID_CREATED_KEYS). Static: stored once, sent as stored. */
export interface CrmLinkBody {
  sourceSystem: "trock_crm";
  sourceDealId: string;
  sourceEventId: string;
  approvalKind: string | null;
  office: string | null;
  coreBidId: string;
  coreCreatedAt: string;
  projectNumber: string | null;
  warnings: string[];
}

export function buildCrmLinkBody(input: Omit<CrmLinkBody, "sourceSystem">): CrmLinkBody {
  return {
    sourceSystem: "trock_crm",
    sourceDealId: input.sourceDealId,
    sourceEventId: input.sourceEventId,
    approvalKind: input.approvalKind,
    office: input.office,
    coreBidId: input.coreBidId,
    coreCreatedAt: input.coreCreatedAt,
    projectNumber: input.projectNumber,
    warnings: input.warnings,
  };
}

/** E5 (§7), Core's strict 6 keys (parseRfpBidCreateLinked). occurredAt is stamped per attempt (Core's 5-minute window). */
export interface CoreConfirmBody {
  version: typeof RFP_BID_CREATE_LINKED_DOMAIN;
  occurredAt: string;
  sourceEventId: string;
  crmDealId: string;
  coreBidId: string;
  crmResult: "linked" | "replay";
}

export function buildCoreConfirmBody(input: Omit<CoreConfirmBody, "version">): CoreConfirmBody {
  return {
    version: RFP_BID_CREATE_LINKED_DOMAIN,
    occurredAt: input.occurredAt,
    sourceEventId: input.sourceEventId,
    crmDealId: input.crmDealId,
    coreBidId: input.coreBidId,
    crmResult: input.crmResult,
  };
}

/** N1 (§10 v2.1 wire shape), the strict 9 keys. Stored once (noticeId + occurredAt included), sent as stored. */
export interface RfpCoreNoticeBody {
  sourceSystem: "trock_crm";
  sourceDealId: string;
  sourceEventId: string;
  office: string | null;
  kind: RfpCoreNoticeKind;
  reason: string | null;
  coreBidId: string | null;
  noticeId: string;
  occurredAt: string;
}

/** reason (§10): core_bid_link_refused = the E4 409 error code; core_bid_orphan = "stale"; the confirm kinds = null. */
export function buildRfpCoreNoticeBody(input: Omit<RfpCoreNoticeBody, "sourceSystem">): RfpCoreNoticeBody {
  const reason =
    input.kind === "core_bid_orphan" ? "stale"
    : input.kind === "core_bid_link_refused" ? (input.reason ?? null)
    : null;
  return {
    sourceSystem: "trock_crm",
    sourceDealId: input.sourceDealId,
    sourceEventId: input.sourceEventId,
    office: input.office,
    kind: input.kind,
    reason,
    coreBidId: input.coreBidId && UUID_RE.test(input.coreBidId) ? input.coreBidId : null,
    noticeId: input.noticeId,
    occurredAt: input.occurredAt,
  };
}

/** The STABLE noticeId (§10): `rfp-core-notice:<table name>:<row id>:<kind>`; the table prefix because serial ids collide. */
export function rfpCoreNoticeId(table: string, rowId: number, kind: RfpCoreNoticeKind): string {
  return `rfp-core-notice:${table}:${rowId}:${kind}`;
}

// ── Classifiers ─────────────────────────────────────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

export type CoreCreateOutcome =
  | { kind: "sent"; status: number; result: "created" | "replay" | "updated"; coreBidId: string; createdAt: string; warnings: string[] }
  | { kind: "refused"; status: 409; reason: string }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

/**
 * E3 (§5 / §10): 201 created / 200 replay|updated ⇒ sent (a 2xx without a usable receipt is retried: Core committed, and
 * the retry replays with the id); 409 ⇒ refused with Core's reason verbatim; 404 (dark) / 408 / 429 / 5xx ⇒ retry;
 * 400 / 401 and every other deterministic status ⇒ terminal.
 */
export function classifyCoreCreateResponse(status: number, body: unknown): CoreCreateOutcome {
  const b: Record<string, unknown> = isObject(body) ? body : {};
  if (status >= 200 && status < 300) {
    const result = b.result;
    if (
      (result === "created" || result === "replay" || result === "updated")
      && typeof b.coreBidId === "string" && UUID_RE.test(b.coreBidId)
      && typeof b.createdAt === "string" && Number.isFinite(Date.parse(b.createdAt))
    ) {
      const warnings = Array.isArray(b.warnings) ? b.warnings.filter((w): w is string => typeof w === "string") : [];
      return { kind: "sent", status, result, coreBidId: b.coreBidId, createdAt: b.createdAt, warnings };
    }
    return { kind: "retry", status, error: `Core answered ${status} without a usable E3 receipt` };
  }
  if (status === 409) {
    const reason = typeof b.reason === "string" && b.reason.trim() !== "" ? b.reason : "unknown";
    return { kind: "refused", status: 409, reason };
  }
  if (status === 404 || retryable(status)) return { kind: "retry", status, error: `Core rfp-bid-create returned ${status}` };
  const detail = [b.error, b.reason, b.field].filter((v) => typeof v === "string").join(" ");
  return { kind: "terminal", status, error: `Core rfp-bid-create rejected the request with ${status}${detail ? `: ${detail}` : ""}` };
}

export type CrmLinkOutcome =
  | { kind: "linked"; crmResult: "linked" | "replay"; result: "linked" | "replay" | "link_only" }
  | { kind: "stale" }
  | { kind: "link_refused"; status: 409; reason: string }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

/**
 * E4 (§6 / §10), decided on `result` ONLY (the CRM builder's shapes, 11-10): "linked" | "replay" ⇒ linked (done + E5);
 * "stale" ⇒ stale. `linked` / `claimed` are optional extras an old CRM never sends: `claimed:false` (a link-only answer
 * for a deal with a Procore identity: no claim, no marker) is recorded as result "link_only" and is still linked.
 * 409 {error} ⇒ link_refused (never retried); 408 / 429 / 5xx (incl. 503 dark / deal_busy) ⇒ retry; any other status
 * (400 / 401 / 404 / 422 …) ⇒ terminal. A 2xx whose `result` is missing or unknown is RETRIED (E4 is idempotent: the
 * CRM's replay arm answers a re-delivery), alerted like any retry, and dead-letters after the schedule.
 */
export function classifyCrmLinkResponse(status: number, body: unknown): CrmLinkOutcome {
  const b: Record<string, unknown> = isObject(body) ? body : {};
  if (status >= 200 && status < 300) {
    if (b.result === "stale") return { kind: "stale" };
    if (b.result === "linked" || b.result === "replay") {
      return { kind: "linked", crmResult: b.result, result: b.result === "linked" && b.claimed === false ? "link_only" : b.result };
    }
    return { kind: "retry", status, error: `CRM core-bid-created answered ${status} with an unknown result: ${JSON.stringify(b.result ?? null)}` };
  }
  if (status === 409) {
    const reason = typeof b.error === "string" && b.error.trim() !== "" ? b.error : "unknown";
    return { kind: "link_refused", status: 409, reason };
  }
  if (retryable(status)) return { kind: "retry", status, error: `CRM core-bid-created returned ${status}` };
  const detail = typeof b.error === "string" ? `: ${b.error}` : "";
  return { kind: "terminal", status, error: `CRM core-bid-created rejected the request with ${status}${detail}` };
}

export type CoreConfirmOutcome = { kind: "confirmed" } | { kind: "retry"; status?: number; error: string };

/** E5 (§7): 2xx {confirmed:true} ⇒ confirmed; EVERYTHING else is retried (E5 never dead-letters). */
export function classifyCoreConfirmResponse(status: number, body: unknown): CoreConfirmOutcome {
  const b: Record<string, unknown> = isObject(body) ? body : {};
  if (status >= 200 && status < 300 && b.confirmed === true) return { kind: "confirmed" };
  const detail = [b.error, b.reason].filter((v) => typeof v === "string").join(" ");
  return { kind: "retry", status, error: `Core rfp-bid-create/linked returned ${status}${detail ? `: ${detail}` : ""}` };
}

export type CrmNoticeOutcome =
  | { kind: "sent"; result: string | null }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

/** N1 (§10): 2xx (recorded | replay) ⇒ sent; 408 / 429 / 5xx (incl. 503 dark) ⇒ retry; any other status ⇒ terminal. */
export function classifyCrmNoticeResponse(status: number, body: unknown): CrmNoticeOutcome {
  const b: Record<string, unknown> = isObject(body) ? body : {};
  if (status >= 200 && status < 300) return { kind: "sent", result: typeof b.result === "string" ? b.result : null };
  if (retryable(status)) return { kind: "retry", status, error: `CRM rfp-core-notice returned ${status}` };
  const detail = typeof b.error === "string" ? `: ${b.error}` : "";
  return { kind: "terminal", status, error: `CRM rfp-core-notice rejected the request with ${status}${detail}` };
}

// ── Schedule ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RetryDisposition = { kind: "retry"; delay: string } | { kind: "dead" };

/** E2 / E4 / N1 after a retryable failure of attempt `attemptCount` (1-based): the next wait, or dead at the ceiling. */
export function retryDisposition(attemptCount: number, maxAttempts: number = RFP_CORE_MAX_ATTEMPTS): RetryDisposition {
  if (attemptCount >= maxAttempts) return { kind: "dead" };
  const i = Math.max(0, Math.min(attemptCount - 1, RFP_CORE_BACKOFF_INTERVALS.length - 1));
  return { kind: "retry", delay: RFP_CORE_BACKOFF_INTERVALS[i] };
}

export interface CoreConfirmDisposition {
  delay: string;
  /** The schedule is exhausted: the ONE N1 core_link_confirm_pending must exist (enqueued idempotently). */
  pendingNotice: boolean;
  /** The ops "confirmation delayed" alert: at the first post-schedule failure, then once a day. */
  delayedAlert: boolean;
}

/** E5 after a failure of attempt `attemptCount`: the 6-step schedule, then every 2 h forever (never dead, §7). */
export function coreConfirmDisposition(attemptCount: number): CoreConfirmDisposition {
  if (attemptCount < RFP_CORE_MAX_ATTEMPTS) {
    const i = Math.max(0, attemptCount - 1);
    return { delay: RFP_CORE_BACKOFF_INTERVALS[i], pendingNotice: false, delayedAlert: false };
  }
  return {
    delay: RFP_CORE_CONFIRM_RETRY_INTERVAL,
    pendingNotice: true,
    delayedAlert: (attemptCount - RFP_CORE_MAX_ATTEMPTS) % RFP_CORE_CONFIRM_ALERT_EVERY === 0,
  };
}

/**
 * A one-deal operator re-drive row (re-drive design r2 001ab3ba): a non-empty string at `payload.operatorRedrive.go`. Only
 * such a row, whose command is procore-done, skips the sender's Procore-footprint hold. Lives in rfp-operator-redrive.ts
 * (S0 reads it too); re-exported here unchanged.
 */
export { isOperatorRedrive } from "./rfp-operator-redrive";
