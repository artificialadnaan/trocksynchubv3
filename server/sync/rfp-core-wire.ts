/**
 * RFP Phase 2, S1a (CONTRACT v2.4 §5 / §6 / §7 / §10): the WIRE of the Core path, with no I/O.
 * S1a RED: exported stubs only (names, types and constants), no behaviour. GREEN implements them.
 */
import type { CreateFromRfpInput } from "../routes/rfp-requests";

export const RFP_BID_CREATE_DOMAIN = "trock.crm.rfp-bid-create.v1" as const;
export const RFP_BID_CREATE_LINKED_DOMAIN = "trock.crm.rfp-bid-create-linked.v1" as const;
export const RFP_BID_CREATE_OFFICE = "dallas" as const;
export const RFP_BID_CREATE_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1";
export const RFP_BID_CREATE_LINKED_PATH = "/webhooks/crm/dallas/rfp-bid-create/v1/linked";
export const CRM_CORE_BID_CREATED_PATH = "/api/internal/core-bid-created";
export const CRM_RFP_CORE_NOTICE_PATH = "/api/internal/rfp-core-notice";
export const RFP_BID_CREATE_SECRET_ENV = "RFP_BID_CREATE_INGRESS_SECRET_CURRENT";
export const RFP_CORE_BACKOFF_INTERVALS = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"] as const;
export const RFP_CORE_MAX_ATTEMPTS = RFP_CORE_BACKOFF_INTERVALS.length + 1;
export const RFP_CORE_CONFIRM_RETRY_INTERVAL = "2 hours";
export const RFP_CORE_CONFIRM_ALERT_EVERY = 12;
export const RFP_CORE_NOTICE_TABLE = "rfp_core_followup_outbox";

export type RfpCoreNoticeKind = "core_link_confirm_pending" | "core_link_confirmed" | "core_bid_orphan" | "core_bid_link_refused";

export function signRfpBidCreate(_input: { path: string; rawBody: string; secret: string }): string {
  return "";
}

export function signRfpBidCreateLinked(_input: { path: string; rawBody: string; secret: string }): string {
  return "";
}

export function resolveRfpBidCreateIngressSecret(_env: NodeJS.ProcessEnv = process.env): string | null {
  return null;
}

export function buildRfpBidCreateTargetUrl(_baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  return null;
}

export function buildRfpBidCreateLinkedTargetUrl(_baseUrl: string | undefined = process.env.CORE_INGRESS_BASE_URL): string | null {
  return null;
}

export function buildCrmInternalTargetUrl(_path: string, _baseUrl: string | undefined = process.env.TROCK_CRM_BASE_URL): string | null {
  return null;
}

export interface RfpBidCreateBody {
  version: typeof RFP_BID_CREATE_DOMAIN;
  office: typeof RFP_BID_CREATE_OFFICE;
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

export type RfpBidCreateBodyResult = { ok: true; body: RfpBidCreateBody } | { ok: false; reason: "company_missing" };

export function buildRfpBidCreateBody(
  _input: CreateFromRfpInput,
  _opts: { occurredAt: string; approvalKind?: string | null },
): RfpBidCreateBodyResult {
  return { ok: false, reason: "not_implemented" } as any;
}

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

export function buildCrmLinkBody(_input: Omit<CrmLinkBody, "sourceSystem">): CrmLinkBody {
  return {} as any;
}

export interface CoreConfirmBody {
  version: typeof RFP_BID_CREATE_LINKED_DOMAIN;
  occurredAt: string;
  sourceEventId: string;
  crmDealId: string;
  coreBidId: string;
  crmResult: "linked" | "replay";
}

export function buildCoreConfirmBody(_input: Omit<CoreConfirmBody, "version">): CoreConfirmBody {
  return {} as any;
}

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

export function buildRfpCoreNoticeBody(_input: Omit<RfpCoreNoticeBody, "sourceSystem">): RfpCoreNoticeBody {
  return {} as any;
}

export function rfpCoreNoticeId(_table: string, _rowId: number, _kind: RfpCoreNoticeKind): string {
  return "";
}

export type CoreCreateOutcome =
  | { kind: "sent"; status: number; result: "created" | "replay" | "updated"; coreBidId: string; createdAt: string; warnings: string[] }
  | { kind: "refused"; status: 409; reason: string }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

export function classifyCoreCreateResponse(_status: number, _body: unknown): CoreCreateOutcome {
  return { kind: "not_implemented" } as any;
}

export type CrmLinkOutcome =
  | { kind: "linked"; crmResult: "linked" | "replay"; result: "linked" | "replay" | "link_only" }
  | { kind: "stale" }
  | { kind: "link_refused"; status: 409; reason: string }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

export function classifyCrmLinkResponse(_status: number, _body: unknown): CrmLinkOutcome {
  return { kind: "not_implemented" } as any;
}

export type CoreConfirmOutcome = { kind: "confirmed" } | { kind: "retry"; status?: number; error: string };

export function classifyCoreConfirmResponse(_status: number, _body: unknown): CoreConfirmOutcome {
  return { kind: "not_implemented" } as any;
}

export type CrmNoticeOutcome =
  | { kind: "sent"; result: string | null }
  | { kind: "terminal"; status: number; error: string }
  | { kind: "retry"; status?: number; error: string };

export function classifyCrmNoticeResponse(_status: number, _body: unknown): CrmNoticeOutcome {
  return { kind: "not_implemented" } as any;
}

export type RetryDisposition = { kind: "retry"; delay: string } | { kind: "dead" };

export function retryDisposition(_attemptCount: number, _maxAttempts: number = RFP_CORE_MAX_ATTEMPTS): RetryDisposition {
  return { kind: "not_implemented" } as any;
}

export interface CoreConfirmDisposition {
  delay: string;
  pendingNotice: boolean;
  delayedAlert: boolean;
}

export function coreConfirmDisposition(_attemptCount: number): CoreConfirmDisposition {
  return { delay: "", pendingNotice: false, delayedAlert: false };
}

export function isOperatorRedrive(_payload: unknown): boolean {
  return false;
}
