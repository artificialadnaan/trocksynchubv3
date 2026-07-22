import crypto from "crypto";
import path from "path";
import { log } from "../index";
import type { BidBoardExcelRow } from "./bidboard-stage-sync";

export interface BuildBidBoardCrmPayloadInput {
  rows: BidBoardExcelRow[];
  sourceFilename: string;
  extractedAt: string;
  officeSlug?: string;
}

export interface PushBidBoardRowsInput extends BuildBidBoardCrmPayloadInput {
  /** Backoff before each status probe after an ambiguous POST (defaults [500,1500,4000]ms). Test seam. */
  statusPollDelaysMs?: number[];
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Outcome of a durable CRM push.
 *  - `ok` means the ingestion is durably ACCEPTED (2xx, or a status probe reported queued/processing/
 *    succeeded). Alerting treats ok as healthy.
 *  - `terminalFailure` means the CRM accepted the payload but PROCESSING reached a real terminal failure.
 *  - `accepted === false` (with ok false, no terminalFailure) means we could NOT establish durable
 *    acceptance — an ambiguous gateway response (e.g. 502) that the status probe never resolved. This is
 *    explicitly NOT proof the CRM rolled back.
 */
export interface PushBidBoardRowsResult {
  ok: boolean;
  attempts: number;
  skipped?: boolean;
  status?: number;
  error?: string;
  accepted?: boolean;
  terminalFailure?: boolean;
  /** A deterministic client-side rejection (4xx other than 429/408) — the CRM will not accept this request
   *  as-is (bad signature, malformed, or oversized). Distinct from an ambiguous 502. */
  rejected?: boolean;
  ingestionStatus?: "accepted" | "queued" | "processing" | "succeeded" | "failed" | "unknown";
  idempotencyKey?: string;
}

export function buildBidBoardCrmPayload(input: BuildBidBoardCrmPayloadInput) {
  return {
    office_slug: input.officeSlug ?? process.env.CRM_BID_BOARD_SYNC_OFFICE_SLUG ?? "dallas",
    provenance: {
      sourceFilename: path.basename(input.sourceFilename),
      extractedAt: input.extractedAt,
      rowCount: input.rows.length,
    },
    rows: input.rows,
  };
}

export function signBidBoardCrmPayload(body: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** The CRM's idempotency key for a push: sha256 of the EXACT request body bytes.
 *  CONTRACT: must stay byte-identical with the CRM's computeIdempotencyKey (server/src/modules/
 *  bid-board-sync/inbox.ts) — both hash the same serialized body — so a status probe by key resolves the
 *  inbox row after an ambiguous POST. buildBidBoardCrmPayload constructs the object in a fixed key order and
 *  the same `body` string is what we POST, so the CRM's sha256(rawBody) equals this. */
export function computeBidBoardIdempotencyKey(body: Buffer | string) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/** The signed status endpoint sits next to /ingest. Append to the PATH via URL parsing (not raw string
 *  concat) so a configured query string — e.g. CRM_BID_BOARD_SYNC_URL=".../ingest?version=2" — yields
 *  ".../ingest/status?version=2", not the broken ".../ingest?version=2/status" that would probe the wrong
 *  endpoint and mis-report every ambiguous submission as unconfirmed. */
export function deriveBidBoardStatusUrl(ingestUrl: string) {
  const statusUrl = new URL(ingestUrl);
  statusUrl.pathname = `${statusUrl.pathname.replace(/\/+$/, "")}/status`;
  statusUrl.hash = "";
  return statusUrl.toString();
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-request deadlines. Every fetch in this flow runs inside the scheduled stage-sync cycle, which sets
// `bidboardStageSyncRunning` for its whole duration; a single request that connects but never completes its
// response would leave that flag set forever, so every later interval would skip and neither the CRM alert nor
// the remaining HubSpot sync would run. Bounding each request turns a hung connection into an ordinary failed
// attempt/probe on the existing catch paths (both are already retry/re-POST bounded and CRM-idempotent).
const CRM_POST_TIMEOUT_MS = 30_000; // the payload upload
const STATUS_PROBE_TIMEOUT_MS = 15_000; // the signed /ingest/status lookup (a quick CRM read)

interface TimedResponse {
  ok: boolean;
  status: number;
  bodyText: string; // the FULL body, already drained under the deadline
}

/** Run one fetch through the (test-injectable) impl AND fully drain its body under a SINGLE AbortController
 *  deadline. fetch() resolves on response HEADERS, so the body read must happen inside the deadline too — a
 *  server that sends headers then stalls the body would otherwise hang the caller's text()/json() forever with
 *  bidboardStageSyncRunning still set, defeating the timeout. We return the already-materialized body so callers
 *  never touch the socket again. Mirrors server/lib/fetch-with-timeout.ts but threads the injected `fetchImpl`
 *  so tests keep their seam. */
async function fetchImplWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    // Drain the body while the deadline is still armed. A deadline abort MUST propagate (that is the whole
    // point — it lands on the caller's catch as a failed attempt/probe); but a NON-abort body-read failure
    // (e.g. a connection reset mid-body) is swallowed to "" so the caller still classifies by HTTP status,
    // preserving the old lenient `response.text().catch(() => "")` / `response.json().catch(() => null)`.
    const bodyText = await response.text().catch((err) => {
      if (controller.signal.aborted) throw err;
      return "";
    });
    return { ok: response.ok, status: response.status, bodyText };
  } finally {
    clearTimeout(timeoutId);
  }
}

type CrmIngestionStatus = "queued" | "processing" | "succeeded" | "failed" | "unknown";

interface StatusProbeResult {
  ok: boolean; // the probe itself succeeded (endpoint reachable + 2xx)
  status?: CrmIngestionStatus;
  lastError?: string;
  error?: string; // probe transport/HTTP error
}

async function probeCrmIngestionStatus(
  statusUrl: string,
  args: { officeSlug: string; idempotencyKey: string; secret: string; fetchImpl: typeof fetch }
): Promise<StatusProbeResult> {
  const body = JSON.stringify({ office_slug: args.officeSlug, idempotency_key: args.idempotencyKey });
  try {
    const response = await fetchImplWithTimeout(
      args.fetchImpl,
      statusUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bid-board-sync-signature": signBidBoardCrmPayload(body, args.secret),
        },
        body,
      },
      STATUS_PROBE_TIMEOUT_MS
    );
    if (!response.ok) {
      return { ok: false, error: `status probe responded ${response.status}` };
    }
    let json: { status?: CrmIngestionStatus; lastError?: string } | null = null;
    try {
      json = response.bodyText ? JSON.parse(response.bodyText) : null;
    } catch {
      json = null;
    }
    const status = json?.status;
    if (status === "queued" || status === "processing" || status === "succeeded" || status === "failed") {
      return { ok: true, status, lastError: json?.lastError };
    }
    return { ok: true, status: "unknown" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push the scraped Bid Board rows to the CRM ingest endpoint and establish a DURABLE outcome.
 *
 * The CRM now acknowledges with 202 the moment it durably enqueues (the import runs async), so the happy
 * path is a single POST. On an AMBIGUOUS response (a gateway 502, a network drop, a 5xx) we do NOT
 * immediately re-POST the full payload — that is what produced three overlapping imports in the 2026-07-19
 * incident. Instead we probe the CRM's signed status endpoint by idempotency key:
 *   - queued/processing/succeeded → durably accepted → success (no alert);
 *   - failed → a real terminal processing failure → surfaced for a (correctly-worded) alert;
 *   - unknown → the POST likely never landed → ONE bounded re-POST, then keep probing.
 * If acceptance still can't be confirmed, we return accepted:false so the caller alerts on "unconfirmed"
 * (NOT "rolled back").
 */
export async function pushBidBoardRowsToCrm(input: PushBidBoardRowsInput): Promise<PushBidBoardRowsResult> {
  const url = process.env.CRM_BID_BOARD_SYNC_URL;
  const secret = process.env.BID_BOARD_SYNC_SECRET;
  if (!url || !secret) {
    log(
      "[BidBoardCRM] CRM_BID_BOARD_SYNC_URL or BID_BOARD_SYNC_SECRET missing; skipping CRM ingestion push",
      "sync"
    );
    return {
      ok: false,
      attempts: 0,
      skipped: true,
      error: "CRM Bid Board sync is not configured",
    };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const payload = buildBidBoardCrmPayload(input);
  const officeSlug = payload.office_slug;
  const body = JSON.stringify(payload);
  const idempotencyKey = computeBidBoardIdempotencyKey(body);
  const statusUrl = deriveBidBoardStatusUrl(url);
  const pollDelays = input.statusPollDelaysMs ?? [500, 1500, 4000];

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  // A deterministic client rejection (bad signature, malformed body, oversized payload) will NEVER be
  // accepted as-is, so it's a definite failure — NOT ambiguous. 429/408 are transient (rate limit / request
  // timeout) so they stay ambiguous and go through the status-probe path.
  const isDeterministicRejection = (status: number) =>
    status >= 400 && status < 500 && status !== 429 && status !== 408;

  const postOnce = async (): Promise<{ posted: boolean; ok: boolean; rejected: boolean }> => {
    attempts++;
    try {
      const response = await fetchImplWithTimeout(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bid-board-sync-signature": signBidBoardCrmPayload(body, secret),
          },
          body,
        },
        CRM_POST_TIMEOUT_MS
      );
      lastStatus = response.status;
      if (response.ok) {
        log(`[BidBoardCRM] Posted ${input.rows.length} Bid Board rows to CRM (accepted ${response.status})`, "sync");
        return { posted: true, ok: true, rejected: false };
      }
      lastError = `CRM responded ${response.status}: ${response.bodyText}`;
      const rejected = isDeterministicRejection(response.status);
      log(`[BidBoardCRM] Push attempt ${attempts} ${rejected ? "REJECTED" : "ambiguous"}: ${lastError}`, "sync");
      return { posted: true, ok: false, rejected };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`[BidBoardCRM] Push attempt ${attempts} ambiguous: ${lastError}`, "sync");
      return { posted: false, ok: false, rejected: false };
    }
  };

  const accepted = (ingestionStatus: PushBidBoardRowsResult["ingestionStatus"]): PushBidBoardRowsResult => ({
    ok: true,
    accepted: true,
    attempts,
    status: lastStatus,
    ingestionStatus,
    idempotencyKey,
  });

  const rejectedResult = (): PushBidBoardRowsResult => ({
    ok: false,
    accepted: false,
    rejected: true,
    attempts,
    status: lastStatus,
    ingestionStatus: "unknown",
    error: lastError,
    idempotencyKey,
  });

  const first = await postOnce();
  if (first.ok) return accepted("accepted");
  // A deterministic 4xx is a definite rejection — don't probe or re-POST; surface it for a clear alert.
  if (first.rejected) {
    log(`[BidBoardCRM] CRM REJECTED the push (${lastStatus}); not retrying`, "sync");
    return rejectedResult();
  }

  // Ambiguous. Resolve via the status endpoint instead of blindly re-POSTing the full payload.
  let repostsRemaining = 1;
  for (const wait of pollDelays) {
    await delay(wait);
    const probe = await probeCrmIngestionStatus(statusUrl, { officeSlug, idempotencyKey, secret, fetchImpl });
    if (probe.ok && probe.status) {
      if (probe.status === "queued" || probe.status === "processing" || probe.status === "succeeded") {
        log(`[BidBoardCRM] Ambiguous POST resolved as durably accepted (status=${probe.status})`, "sync");
        return accepted(probe.status);
      }
      if (probe.status === "failed") {
        log(`[BidBoardCRM] CRM ingestion reached a TERMINAL failure (status=failed)`, "sync");
        return {
          ok: false,
          accepted: true,
          terminalFailure: true,
          attempts,
          status: lastStatus,
          ingestionStatus: "failed",
          error: probe.lastError ?? lastError,
          idempotencyKey,
        };
      }
      // unknown → the POST likely never reached the CRM. Retry ONCE, then keep probing.
      if (probe.status === "unknown" && repostsRemaining > 0) {
        repostsRemaining--;
        const reposted = await postOnce();
        if (reposted.ok) return accepted("accepted");
        if (reposted.rejected) return rejectedResult();
      }
    } else if (probe.error) {
      lastError = probe.error;
    }
  }

  log(`[BidBoardCRM] Could not establish durable acceptance after ${attempts} attempt(s); extraction remains successful`, "sync");
  return {
    ok: false,
    accepted: false,
    attempts,
    status: lastStatus,
    ingestionStatus: "unknown",
    error: lastError ?? "could not establish durable CRM acceptance",
    idempotencyKey,
  };
}
