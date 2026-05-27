import crypto from "crypto";
import { sql } from "drizzle-orm";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { log } from "../index";

export interface BidBoardCreatedCallbackPayload {
  sourceDealId: string;
  rfpApprovalRequestId: number;
  bidboardProjectId: string;
  projectNumber: string;
  procoreCompanyId: string;
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

function signPayload(rawBody: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

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

export async function sendBidBoardCallbackRow(row: any, deps: { fetchImpl?: typeof fetchWithTimeout; secret?: string } = {}): Promise<void> {
  const secret = deps.secret ?? process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    throw new Error("RFP_REQUEST_SYNC_SECRET is not configured for BidBoard callback delivery");
  }
  const rawBody = JSON.stringify(row.payload);
  const response = await (deps.fetchImpl ?? fetchWithTimeout)(row.target_url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rfp-request-signature": signPayload(rawBody, secret),
    },
    body: rawBody,
  });

  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`CRM callback failed with ${response.status}: ${body || response.statusText}`);
}

export async function processBidBoardCallbackOutbox(options: { limit?: number; fetchImpl?: typeof fetchWithTimeout; secret?: string } = {}): Promise<{ processed: number; sent: number; failed: number }> {
  if (callbackWorkerRunning) return { processed: 0, sent: 0, failed: 0 };
  callbackWorkerRunning = true;
  let sent = 0;
  let failed = 0;

  try {
    const rows = await claimPendingBidBoardCallbacks(options.limit ?? 5);
    for (const row of rows) {
      try {
        await sendBidBoardCallbackRow(row, { fetchImpl: options.fetchImpl, secret: options.secret });
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
