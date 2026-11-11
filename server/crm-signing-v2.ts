/**
 * SyncHub → CRM request signing, v2 (SIGNING-HARDENING r1 4c5bb802; the wire agreed with the CRM verifier's owner, 28).
 * ONE signer for every SyncHub → CRM request, so the legs can never drift apart:
 *   - x-rfp-request-signature, key RFP_REQUEST_SYNC_SECRET, base TROCK_CRM_BASE_URL: E4 core-bid-created, N1
 *     rfp-core-notice, bid-board-created / rfp-declined (the callback outbox), deals/current-values, estimates-sent,
 *     deals/eligibility-check, core-rfp-handoff (service-rfp-core-crm-notice);
 *   - x-bid-board-sync-signature, key BID_BOARD_SYNC_SECRET, URL CRM_BID_BOARD_SYNC_URL: the Bid Board ingest + its status probe.
 * The wire (v2 ONLY; the CRM dual-verifies v1 + v2 first, then SyncHub deploys this):
 *   headers  x-signature-version: 2 · x-signature-timestamp: <unix seconds, decimal> · <signature header>: sha256=<hex>
 *   HMAC-SHA256(secret, "v2\n" + METHOD + "\n" + path + "\n" + ts + "\n" + lowercase hex(sha256(raw body)))
 *   path = the pathname of the URL actually requested (no query), e.g. /api/internal/core-bid-created.
 * At FIRST USE (never at boot): a secret under 32 bytes, or a URL that is not https (only localhost / 127.0.0.1 may be
 * http), REFUSES the send: nothing is sent and ONE visible alert is raised per signer + reason.
 * The INBOUND CRM → SyncHub verification (routes/rfp-requests.ts) is not this file and is unchanged.
 */
import crypto from "crypto";

export const CRM_SIGNATURE_VERSION = "2";
export const CRM_SIGNATURE_VERSION_HEADER = "x-signature-version";
export const CRM_SIGNATURE_TIMESTAMP_HEADER = "x-signature-timestamp";
export const MIN_CRM_SECRET_BYTES = 32;

export interface CrmV2SignInput {
  method: string;
  path: string;
  /** Unix seconds. */
  timestamp: number;
  rawBody: string;
}

/** The exact string the HMAC covers. */
export function crmV2SignedString(input: CrmV2SignInput): string {
  const bodyHash = crypto.createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  return `v2\n${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${bodyHash}`;
}

/** `sha256=<lowercase hex>` over crmV2SignedString. */
export function signCrmV2(input: CrmV2SignInput & { secret: string }): string {
  return `sha256=${crypto.createHmac("sha256", input.secret).update(crmV2SignedString(input), "utf8").digest("hex")}`;
}

/** The floor: at least 32 bytes (UTF-8), as the CRM verifier requires of its side. */
export function crmSecretUsable(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= MIN_CRM_SECRET_BYTES;
}

/** https, or http ONLY to exactly localhost / 127.0.0.1 (the full-path test runs on http://localhost:3001). */
export function crmUrlAllowed(url: string | null | undefined): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
}

export type CrmSignRefusal = { reason: "secret_short" | "url_refused"; detail: string };

/** Why a signer may not send at all (checked at first use), or null when it may. */
export function crmSigningRefusal(input: { secret: string | null | undefined; url: string | null | undefined }): CrmSignRefusal | null {
  if (!crmSecretUsable(input.secret)) {
    return { reason: "secret_short", detail: `the CRM signing secret is unset or shorter than ${MIN_CRM_SECRET_BYTES} bytes` };
  }
  if (!crmUrlAllowed(input.url)) {
    return { reason: "url_refused", detail: `the CRM URL is not https (http is allowed only for localhost / 127.0.0.1)` };
  }
  return null;
}

export type CrmV2Headers = { ok: true; headers: Record<string, string> } | ({ ok: false } & CrmSignRefusal);

/** The three v2 headers for ONE request to `url` (its pathname is signed), or the refusal. */
export function crmV2Headers(input: {
  url: string;
  rawBody: string;
  secret: string | null | undefined;
  signatureHeader: string;
  method?: string;
  now?: Date;
}): CrmV2Headers {
  const refusal = crmSigningRefusal({ secret: input.secret, url: input.url });
  if (refusal) return { ok: false, ...refusal };
  const path = new URL(input.url.trim()).pathname;
  const method = (input.method ?? "POST").toUpperCase();
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return {
    ok: true,
    headers: {
      [input.signatureHeader]: signCrmV2({ method, path, timestamp, rawBody: input.rawBody, secret: input.secret as string }),
      [CRM_SIGNATURE_VERSION_HEADER]: CRM_SIGNATURE_VERSION,
      [CRM_SIGNATURE_TIMESTAMP_HEADER]: String(timestamp),
    },
  };
}

const alerted = new Set<string>();

/** Test seam: forget which refusals were already alerted. */
export function resetCrmSigningRefusalsForTests(): void {
  alerted.clear();
}

/** A signer that sends again clears its refusal, so the next refusal is visible again. */
export function clearCrmSigningRefusal(signer: string): void {
  for (const key of Array.from(alerted)) if (key.startsWith(`${signer}:`)) alerted.delete(key);
}

/**
 * ONE visible alert per signer + reason (the shape of the RFP "unconfigured" alert). Never throws; never prints a secret
 * value. The alert module is imported lazily: several signers sit below server/index in the import graph.
 */
export async function alertCrmSigningRefused(signer: string, refusal: CrmSignRefusal): Promise<void> {
  const key = `${signer}:${refusal.reason}`;
  if (alerted.has(key)) return;
  try {
    const { raiseRfpCoreAlert } = await import("./sync/rfp-core-alert");
    const delivered = await raiseRfpCoreAlert("crm_signing_refused", { signer, reason: refusal.reason, detail: refusal.detail, action: "nothing was sent" });
    // CodeRabbit 4536104331 on #130: the key is kept only after a CONFIRMED delivery, so a failed first alert never silences
    // every later refusal for this signer + reason (the next refusal raises again).
    if (delivered !== false) alerted.add(key);
  } catch (err) {
    console.warn(`[crm-signing] alert for ${signer} ${refusal.reason} could not be raised: ${(err as Error)?.message ?? err}`);
  }
}
