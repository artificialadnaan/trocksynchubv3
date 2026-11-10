import { sql } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { log } from "../index";
import {
  alertCrmSigningRefused,
  clearCrmSigningRefusal,
  crmSecretUsable,
  crmUrlAllowed,
  crmV2Headers,
  MIN_CRM_SECRET_BYTES,
  type CrmSignRefusal,
} from "../crm-signing-v2";

export interface BidBoardCreatedCallbackPayload {
  // 'created' on a successful Bid Board project creation; 'failed' when the (override)
  // Playwright creation failed and the request was left re-tryable. Optional for backward
  // compatibility — an absent status is treated as 'created' by consumers.
  status?: "created" | "failed";
  sourceDealId: string;
  rfpApprovalRequestId: number;
  bidboardProjectId?: string; // present on 'created'; absent on 'failed'
  projectNumber?: string;
  procoreCompanyId?: string; // best-effort on 'failed'
  error?: string; // present on 'failed'
  createdAt: string;
}

export interface RfpDeclinedCallbackPayload {
  sourceDealId: string;
  rfpApprovalRequestId: number;
  denialReason?: string;
  declinedAt: string;
}

const BACKOFF_INTERVALS = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"] as const;
let callbackWorkerTimer: ReturnType<typeof setInterval> | null = null;
let callbackWorkerRunning = false;

/** The alert / refusal namespace of this signer (server/crm-signing-v2.ts): bid-board-created + rfp-declined. */
const CALLBACK_SIGNER = "bidboard_callbacks";

async function getDb() {
  return (await import("../db")).db;
}

export function buildBidBoardCreatedCallbackTargetUrl(baseUrl = process.env.TROCK_CRM_BASE_URL): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/api/internal/bid-board-created` : null;
}

export function buildRfpDeclinedCallbackTargetUrl(baseUrl = process.env.TROCK_CRM_BASE_URL): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed ? `${trimmed}/api/internal/rfp-declined` : null;
}

export async function claimPendingBidBoardCallbacks(limit = 5): Promise<any[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE bidboard_callback_outbox
       SET last_attempt_at = NOW(),
           attempt_count = attempt_count + 1,
           next_attempt_at = NOW() + interval '5 minutes'
     WHERE id IN (
       SELECT id
         FROM bidboard_callback_outbox
        WHERE status = 'pending'
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  return Array.isArray(result) ? result : ((result as any).rows ?? []);
}

async function markCallbackSent(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_callback_outbox
       SET status = 'sent',
           sent_at = NOW(),
           last_error = NULL
     WHERE id = ${id}
  `);
}

async function markCallbackFailed(row: any, error: string): Promise<void> {
  const db = await getDb();
  const attemptCount = Number(row.attempt_count ?? row.attemptCount ?? 0);
  const maxAttempts = Number(row.max_attempts ?? row.maxAttempts ?? 5);
  if (attemptCount >= maxAttempts) {
    await db.execute(sql`
      UPDATE bidboard_callback_outbox
         SET status = 'dead',
             last_error = ${error},
             last_attempt_at = NOW()
       WHERE id = ${row.id}
    `);
    log(`[bidboard-callback] Callback outbox row ${row.id} for RFP request ${row.rfp_approval_request_id} is dead: ${error}`, "sync");
    return;
  }

  const backoff = BACKOFF_INTERVALS[Math.max(0, Math.min(attemptCount - 1, BACKOFF_INTERVALS.length - 1))];
  await db.execute(sql`
    UPDATE bidboard_callback_outbox
       SET status = 'pending',
           last_error = ${error},
           last_attempt_at = NOW(),
           next_attempt_at = NOW() + ${backoff}::interval
     WHERE id = ${row.id}
  `);
}

/**
 * One callback to the CRM (bid-board-created / rfp-declined), signed v2 over the row's own target path
 * (SIGNING-HARDENING r1, server/crm-signing-v2.ts). A secret under 32 bytes or a non-https target (localhost / 127.0.0.1
 * excepted) is REFUSED: nothing is sent, one alert, and the throw takes the row's ordinary failure path.
 */
export async function sendBidBoardCallbackRow(
  row: any,
  deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string; now?: () => Date } = {},
): Promise<void> {
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    throw new Error("RFP_REQUEST_SYNC_SECRET is not configured for BidBoard callback delivery");
  }
  const rawBody = JSON.stringify(row.payload);
  const signed = crmV2Headers({ url: String(row.target_url), rawBody, secret, signatureHeader: "x-rfp-request-signature", now: deps.now?.() });
  if (!signed.ok) {
    await alertCrmSigningRefused(CALLBACK_SIGNER, { reason: signed.reason, detail: signed.detail });
    throw new Error(`refused before sending the CRM callback: ${signed.detail}`);
  }
  const response = await (deps.fetchImpl ?? fetchWithTimeout)(row.target_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signed.headers,
    },
    body: rawBody,
  });

  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`CRM callback failed with ${response.status}: ${body || response.statusText}`);
}

/**
 * SIGNING-HARDENING r1, at first use (never boot): a secret under 32 bytes, or a TROCK_CRM_BASE_URL that is not https
 * (localhost / 127.0.0.1 excepted), and NOTHING is claimed or sent: every row stays pending, unchanged, with ONE alert
 * once a row is due (the shape of "unconfigured").
 */
function callbackConfigRefusal(secret: string | undefined): CrmSignRefusal | null {
  if (!crmSecretUsable(secret)) {
    return { reason: "secret_short", detail: `RFP_REQUEST_SYNC_SECRET is unset or shorter than ${MIN_CRM_SECRET_BYTES} bytes` };
  }
  const base = process.env.TROCK_CRM_BASE_URL?.trim();
  if (base && !crmUrlAllowed(base)) {
    return { reason: "url_refused", detail: "TROCK_CRM_BASE_URL is not https (http is allowed only for localhost / 127.0.0.1)" };
  }
  return null;
}

async function hasDueCallback(): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT id FROM bidboard_callback_outbox WHERE status = 'pending' AND next_attempt_at <= NOW() LIMIT 1
  `);
  const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
  return rows.length > 0;
}

export async function processBidBoardCallbackOutbox(
  options: { limit?: number; fetchImpl?: typeof fetchWithTimeout; secret?: string; now?: () => Date } = {},
): Promise<{ processed: number; sent: number; failed: number }> {
  if (callbackWorkerRunning) return { processed: 0, sent: 0, failed: 0 };
  callbackWorkerRunning = true;
  let sent = 0;
  let failed = 0;

  try {
    const secret = options.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
    const refusal = callbackConfigRefusal(secret);
    if (refusal) {
      if (await hasDueCallback()) await alertCrmSigningRefused(CALLBACK_SIGNER, refusal);
      return { processed: 0, sent: 0, failed: 0 };
    }
    clearCrmSigningRefusal(CALLBACK_SIGNER);
    const rows = await claimPendingBidBoardCallbacks(options.limit ?? 5);
    for (const row of rows) {
      try {
        await sendBidBoardCallbackRow(row, { fetchImpl: options.fetchImpl, secret, now: options.now });
        await markCallbackSent(row.id);
        sent += 1;
      } catch (error: any) {
        failed += 1;
        await markCallbackFailed(row, error?.message || String(error));
      }
    }
    return { processed: rows.length, sent, failed };
  } finally {
    callbackWorkerRunning = false;
  }
}

export function startBidBoardCallbackWorker(intervalMs = 30_000): void {
  if (callbackWorkerTimer) return;
  callbackWorkerTimer = setInterval(() => {
    processBidBoardCallbackOutbox().catch((error) => {
      log(`[bidboard-callback] Worker tick failed: ${error?.message || error}`, "sync");
    });
  }, intervalMs);
  log(`[bidboard-callback] Worker started (${intervalMs}ms)`, "sync");
}

export function stopBidBoardCallbackWorker(): void {
  if (!callbackWorkerTimer) return;
  clearInterval(callbackWorkerTimer);
  callbackWorkerTimer = null;
}
