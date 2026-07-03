import { sql } from "drizzle-orm";
import { log } from "../index";
import { storage } from "../storage";
import { checkRfpApprovalSourceEligibility } from "../rfp-approval";
import { RFP_OVERRIDE_APPROVING_STATUS } from "@shared/schema";
import { buildBidBoardCreatedCallbackTargetUrl } from "./bidboard-callback-worker";
import type { CreateFromRfpInput } from "../routes/rfp-requests";

// Durable command outbox for create-from-rfp (findings V1-V4). See shared/schema.ts bidboardCreateOutbox.
// The endpoint persists a command before its 202; this SERIAL worker (one create at a time, matching the global
// browser lock) does the eligibility recheck + guards + Playwright create + durable callback — without holding a
// request-thread pool client across the long create.

let createWorkerTimer: ReturnType<typeof setInterval> | null = null;
let createWorkerRunning = false;

async function getDb() {
  return (await import("../db")).db;
}

// Persist a create command (called by the endpoint BEFORE its 202 — finding V3). Idempotent on source_event_id:
// a duplicate delivery is a no-op; a previously FAILED command is re-queued (the CRM's rep-driven retry re-POSTs
// the same source_event_id, so DO NOTHING would otherwise strand the retry).
export async function enqueueBidboardCreateCommand(input: CreateFromRfpInput): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    INSERT INTO bidboard_create_outbox
      (source_system, source_deal_id, source_event_id, project_number, payload, status, next_attempt_at, created_at)
    VALUES (
      ${input.sourceSystem}, ${input.sourceDealId}, ${input.sourceEventId},
      ${input.deal.projectNumber ?? null}, ${JSON.stringify(input)}::jsonb, 'pending', NOW(), NOW()
    )
    ON CONFLICT (source_event_id) DO UPDATE
      -- finding Y4: refresh the stored payload + project_number + source fields on re-queue. A rep who corrected
      -- the CRM deal and re-posts the same sourceEventId must have the worker retry with the CORRECTED body, not
      -- the stale one — so create/callback use the new project number / attachments, not the old.
      SET status = 'pending', next_attempt_at = NOW(), attempt_count = 0, last_error = NULL,
          payload = EXCLUDED.payload, project_number = EXCLUDED.project_number,
          source_system = EXCLUDED.source_system, source_deal_id = EXCLUDED.source_deal_id
      -- finding AA2: also re-queue+refresh a STALE 'processing' row (worker crashed after claiming). Otherwise a
      -- corrected re-post is a no-op while the stale-reclaim path later runs the OLD payload. An ACTIVELY-processing
      -- row (recent last_attempt_at) is left alone — its in-flight attempt owns it; a subsequent re-post after it
      -- fails will refresh it. Threshold matches the reclaim window.
      WHERE bidboard_create_outbox.status = 'failed'
         OR (bidboard_create_outbox.status = 'processing'
             AND bidboard_create_outbox.last_attempt_at < NOW() - interval '10 minutes')
  `);
}

// Claim ONE pending/retryable command at a time (serial → satisfies the same-project-number ordering V1 needs +
// keeps at most one Playwright create in flight, matching withBrowserLock). FOR UPDATE SKIP LOCKED so overlapping
// ticks can't double-claim. Also RE-CLAIMS a stale 'processing' row (finding X3): if the worker crashed after
// claiming but before marking done/failed, the row would otherwise be stuck 'processing' forever and the
// 202-accepted vote would sit with no project/callback — so a processing row untouched for >10m (well past any
// real create) is picked back up, bounded by attempt_count < max_attempts.
const STALE_PROCESSING_INTERVAL = "10 minutes";
export async function claimNextBidboardCreateCommand(): Promise<any | null> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE bidboard_create_outbox
       SET status = 'processing', last_attempt_at = NOW(), attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM bidboard_create_outbox
        WHERE attempt_count < max_attempts
          AND (
            (status = 'pending' AND next_attempt_at <= NOW())
            OR (status = 'processing' AND last_attempt_at < NOW() - interval '${sql.raw(STALE_PROCESSING_INTERVAL)}')
          )
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  const rows = Array.isArray(result) ? result : ((result as any).rows ?? []);
  return rows[0] ?? null;
}

async function markCreateCommandDone(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET status = 'done', processed_at = NOW(), last_error = NULL WHERE id = ${id}
  `);
}

// A create failure is TERMINAL for the worker (status='failed') — like the pre-rebuild behaviour, the CRM shows
// send_failed and the rep re-triggers, which re-queues via enqueueBidboardCreateCommand. The failed CALLBACK is
// still delivered durably (below) so the CRM learns of it.
async function markCreateCommandFailed(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET status = 'failed', processed_at = NOW(), last_error = ${error} WHERE id = ${id}
  `);
}

async function resolveProcoreCompanyIdForCallback(): Promise<string | undefined> {
  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config = typeof getAutomationConfig === "function"
    ? await getAutomationConfig.call(storage, "procore_config")
    : null;
  return String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || "").trim() || undefined;
}

// Persist a voting-path callback into the durable bidboard_callback_outbox (finding S2), delivered by
// startBidBoardCallbackWorker. NULL rfpApprovalRequestId, keyed by sourceDealId.
async function enqueueCreateFromRfpCallback(input: CreateFromRfpInput, payload: Record<string, any>): Promise<void> {
  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    // finding X5: do NOT swallow this. If we returned normally the worker would mark the command 'done' — a
    // 202-accepted vote could then create/adopt a project with NO callback row for the CRM to recover from.
    // Throw so the command is marked failed + retryable (the rep-retry re-posts once TROCK_CRM_BASE_URL is set).
    throw new Error("TROCK_CRM_BASE_URL not configured; cannot enqueue create-from-rfp callback");
  }
  // finding X4: supersede any prior PENDING voting callback for this deal before enqueuing. A previously-enqueued
  // 'failed' (from a create that failed while CRM delivery was down) is keyed by NULL rfpApprovalRequestId, so it
  // isn't deduped by the request-id unique index; without this it could be delivered AFTER a later successful
  // 'created', leaving the CRM with a stale failed terminal result. Only the LATEST callback for the deal wins.
  const db = await getDb();
  await db.execute(sql`
    DELETE FROM bidboard_callback_outbox
     WHERE source_system = ${input.sourceSystem}
       AND source_deal_id = ${input.sourceDealId}
       AND rfp_approval_request_id IS NULL
       AND status = 'pending'
  `);
  await storage.enqueueBidboardCallback({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: null,
    payload,
    targetUrl,
  });
}

// callbackAt (finding AA3): the callback's createdAt should be the COMMAND's receipt time (≈ the CRM vote
// time, when the endpoint inserted the outbox row) — NOT when the worker finished. A stale in-flight callback
// stamped with "now" would look newer than the CRM's replacement round and defeat the CRM-side createdAt-vs-
// requested_at/reviewed_at freshness. Callers pass the outbox row's created_at.
async function enqueueFailedCallback(input: CreateFromRfpInput, error: string, callbackAt?: string): Promise<void> {
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  await enqueueCreateFromRfpCallback(input, {
    status: "failed",
    sourceDealId: input.sourceDealId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    error,
    createdAt: callbackAt ?? new Date().toISOString(),
  });
}

// The actual create work, run by the worker under serial processing. Throws on a CREATE failure (the caller
// marks the command failed + delivers a failed callback); returns normally after enqueuing the created callback.
// callbackAt stamps every callback with the command's receipt time (finding AA3).
export async function performCreateFromRfpVote(input: CreateFromRfpInput, callbackAt?: string): Promise<void> {
  const { createBidBoardProjectFromDeal } = await import("../playwright/bidboard");
  const projectNumber = input.deal.projectNumber;

  // Eligibility recheck IMMEDIATELY before the create (findings T3 + V4): by now the command may have waited in
  // the queue, and the CRM deal could have been deleted or moved out of Opportunity. Fail-open on a config/5xx
  // check failure (checkRfpApprovalSourceEligibility returns eligible:true then), matching the normal path.
  const eligibility = await checkRfpApprovalSourceEligibility({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
  });
  if (!eligibility.eligible) {
    await enqueueFailedCallback(input, eligibility.reason || "Source CRM deal is no longer eligible for BidBoard creation", callbackAt);
    return;
  }

  // [Collision guard] (findings S3/S4) — block a conflicting email/override approval for the same project/deal.
  const inFlightApproval =
    (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "pending"))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, RFP_OVERRIDE_APPROVING_STATUS))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "approved"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, "pending"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_OVERRIDE_APPROVING_STATUS))
    // finding X6: also block an already-APPROVED RFP for the SAME source deal. If this deal was approved earlier
    // with project number A and a later vote arrives with a revised number B, createBidBoardProjectFromDeal would
    // adopt the existing source-deal mapping and send a 'created' callback for B pointing at A's old project.
    // Refuse so it stops for manual resolution instead.
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, "approved"));
  if (inFlightApproval) {
    await enqueueFailedCallback(
      input,
      `Project ${projectNumber} / deal ${input.sourceDealId} already has a conflicting RFP approval (request ${inFlightApproval.id}, status ${inFlightApproval.status}); not creating from vote`,
      callbackAt,
    );
    return;
  }

  // [Ownership guard] (finding V1) — refuse to adopt a BidBoard project owned by a DIFFERENT deal. Because the
  // worker is SERIAL, a command sharing a project number is processed only AFTER the first wrote its mapping, so
  // this check now sees that mapping and refuses (the racy pre-lock window the advisory approach had is gone).
  const numberOwner = await storage.getBidboardMappingByProcoreProjectNumber(projectNumber);
  if (
    numberOwner?.bidboardProjectId &&
    !(numberOwner.sourceSystem === input.sourceSystem && numberOwner.sourceDealId === input.sourceDealId)
  ) {
    await enqueueFailedCallback(
      input,
      `Project ${projectNumber} is already linked to ${numberOwner.sourceSystem} deal ${numberOwner.sourceDealId} (BidBoard ${numberOwner.bidboardProjectId}); refusing to adopt for deal ${input.sourceDealId}`,
      callbackAt,
    );
    return;
  }

  // [Same-deal revised-number guard] (finding Y2) — createBidBoardProjectFromDeal adopts THIS deal's existing
  // source-deal mapping BEFORE considering the requested number. If a prior voting command already created a
  // project for this deal under a DIFFERENT number, a revised-number vote would silently return the old project
  // while the callback reports the new projectNumber. Refuse for manual resolution instead. (A same-number
  // re-delivery is the legit idempotent-retry case and is allowed through to the adopt-guard.)
  const dealMapping = await storage.getSyncMappingBySourceDealId(input.sourceSystem as any, input.sourceDealId);
  if (
    dealMapping?.bidboardProjectId &&
    dealMapping.procoreProjectNumber &&
    projectNumber &&
    dealMapping.procoreProjectNumber !== projectNumber
  ) {
    await enqueueFailedCallback(
      input,
      `Deal ${input.sourceDealId} already has BidBoard project ${dealMapping.bidboardProjectId} under number ${dealMapping.procoreProjectNumber}; refusing to create/adopt under revised number ${projectNumber}`,
      callbackAt,
    );
    return;
  }

  const d = input.deal;
  const normalizedDealData: Record<string, any> = {
    dealname: d.name,
    project_number: d.projectNumber,
    project_types: d.projectType,
    amount: d.amount,
    estimator: d.estimator,
    company_name: d.companyName,
    contact_name: d.contactName,
    client_email: d.clientEmail,
    client_phone: d.clientPhone,
    address: d.address?.street,
    city: d.address?.city,
    state: d.address?.state,
    zip: d.address?.zip,
    country: d.address?.country,
    description: d.description,
    bid_due_date: d.dueDate,
    attachments: input.attachments,
    project_location: d.address?.street,
    due_date: d.dueDate,
    notes: d.description,
  };

  const result = await createBidBoardProjectFromDeal({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    bidboardStage: "Estimate in Progress",
    normalizedDealData,
    options: { syncDocuments: true },
  });

  if (!result.success || !result.projectId) {
    // finding Y1: a create FAILURE (Playwright/UI error, ambiguous existing project, ...) must stay RETRYABLE.
    // Throw so processBidboardCreateOutbox marks the command 'failed' (which enqueueBidboardCreateCommand
    // re-queues on the CRM rep's same-sourceEventId retry) + delivers a failed callback — rather than returning
    // normally, which would mark it 'done' and make the retry a silent no-op needing manual DB surgery.
    throw new Error(result.error || "BidBoard project creation failed");
  }

  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  await enqueueCreateFromRfpCallback(input, {
    status: "created" as const,
    sourceDealId: input.sourceDealId,
    bidboardProjectId: result.projectId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    // finding AA3: stamp with the command receipt time so a stale in-flight 'created' can't look newer than a
    // later CRM round + slip past the CRM's createdAt-vs-requested_at/reviewed_at freshness.
    createdAt: callbackAt ?? new Date().toISOString(),
  });
}

const CREATE_WORKER_LOCK_KEY = "bidboard_create_from_rfp_worker";

export async function processBidboardCreateOutbox(deps: { performImpl?: typeof performCreateFromRfpVote } = {}): Promise<{ processed: number }> {
  if (createWorkerRunning) return { processed: 0 };
  createWorkerRunning = true;
  const perform = deps.performImpl ?? performCreateFromRfpVote;
  let processed = 0;
  // finding X2: serialize the DRAIN across app instances with a single global advisory lock held on a dedicated
  // connection for the whole drain. FOR UPDATE SKIP LOCKED alone lets instance A claim row 1 while instance B
  // claims row 2 — two same-project creates could then both see no mapping before either writes one. The global
  // lock guarantees only ONE instance's worker creates at a time, so performCreateFromRfpVote is truly serial and
  // the ownership guard's ordering holds. Non-blocking (pg_try_advisory_lock): a second instance's tick just
  // skips. Holding one connection in a background worker (not a request thread) is fine — no request-pool
  // exhaustion. NOTE: pool.connect is dynamically imported so the test's ../db mock (drizzle-only) isn't required
  // to expose a pool — when absent, we fall back to non-cross-instance draining.
  let lockClient: { query: (t: string) => Promise<any>; release: () => void } | null = null;
  let locked = false;
  try {
    const dbModule: any = await import("../db");
    if (dbModule.pool?.connect) {
      lockClient = await dbModule.pool.connect();
      const res = await lockClient!.query(`SELECT pg_try_advisory_lock(hashtext('${CREATE_WORKER_LOCK_KEY}')) AS locked`);
      locked = Boolean((res.rows ?? res)[0]?.locked);
      if (!locked) return { processed: 0 }; // another instance is draining
    }

    // Drain the queue one command at a time (serial).
    for (;;) {
      const row = await claimNextBidboardCreateCommand();
      if (!row) break;
      const input = (row.payload ?? {}) as CreateFromRfpInput;
      // The command's receipt time (≈ CRM vote time) stamps every callback (finding AA3).
      const callbackAt = row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString();
      // finding AA1: keep the CREATE and the DONE bookkeeping in SEPARATE try/catches. A create failure (perform
      // throws) must deliver a failed callback + mark the command failed. But if perform SUCCEEDED (project
      // created + 'created' callback enqueued) and only markCreateCommandDone throws (transient DB error), we must
      // NOT enqueue a failed callback (which would delete the real 'created') — the project exists. Leave the row
      // 'processing' so the stale-reclaim path re-runs it idempotently (adopt-guard + latest-callback-wins).
      try {
        await perform(input, callbackAt);
      } catch (error: any) {
        const message = error?.message || String(error);
        log(`[bidboard-create] Command ${row.id} create for deal ${input.sourceDealId} failed: ${message}`, "sync");
        await markCreateCommandFailed(row.id, message);
        try { await enqueueFailedCallback(input, message, callbackAt); } catch { /* logged upstream */ }
        processed += 1;
        continue;
      }
      try {
        await markCreateCommandDone(row.id);
      } catch (bookErr: any) {
        // Create + 'created' callback already happened; a failed markDone must NOT flip this to a failure. Leave it
        // 'processing' for the stale-reclaim to finish (re-running is idempotent).
        log(`[bidboard-create] Command ${row.id} created OK but markDone failed (will re-reconcile): ${bookErr?.message || bookErr}`, "sync");
      }
      processed += 1;
    }
    return { processed };
  } finally {
    if (lockClient) {
      if (locked) {
        try { await lockClient.query(`SELECT pg_advisory_unlock(hashtext('${CREATE_WORKER_LOCK_KEY}'))`); } catch { /* connection may be gone */ }
      }
      lockClient.release();
    }
    createWorkerRunning = false;
  }
}

export function startBidboardCreateWorker(intervalMs = 15_000): void {
  if (createWorkerTimer) return;
  createWorkerTimer = setInterval(() => {
    processBidboardCreateOutbox().catch((error) => {
      log(`[bidboard-create] Worker tick failed: ${error?.message || error}`, "sync");
    });
  }, intervalMs);
  log(`[bidboard-create] Worker started (${intervalMs}ms)`, "sync");
}

export function stopBidboardCreateWorker(): void {
  if (!createWorkerTimer) return;
  clearInterval(createWorkerTimer);
  createWorkerTimer = null;
}
