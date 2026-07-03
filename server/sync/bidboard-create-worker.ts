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
          source_system = EXCLUDED.source_system, source_deal_id = EXCLUDED.source_deal_id,
          -- refresh the receipt time on re-queue: processBidboardCreateOutbox stamps every callback with the row's
          -- created_at (≈ CRM vote time). Leaving it at the ORIGINAL attempt would make a corrected retry's
          -- 'created' callback carry a timestamp OLDER than the CRM's fresh round/retry, and the CRM's
          -- createdAt-vs-requested_at/reviewed_at freshness would reject it as stale. A re-queue IS a new receipt,
          -- so stamp created_at = NOW() (this also re-orders it fairly in the FIFO drain).
          created_at = NOW()
      -- Re-queue + refresh a 'failed' row or a STILL-'pending' row (a corrected re-post that arrived BEFORE the
      -- worker claimed it — otherwise the worker would run the STALE first payload). A 'processing' row is NEVER
      -- refreshed here (finding): a create can legitimately run longer than any fixed window (slow Playwright + a
      -- large attachment sync), so rewriting it back to 'pending' while a worker is mid-create would let that worker
      -- finalize the refreshed row (markCreateCommandDone) and silently drop the corrected payload. The in-flight
      -- attempt OWNS its row; a crashed worker's stuck 'processing' row is recovered by the stale-reclaim in
      -- claimNextBidboardCreateCommand (which re-runs the row's payload), and a corrected re-post lands once the
      -- attempt reaches a terminal state. (This deliberately supersedes the earlier AA2 refresh-processing behavior,
      -- trading a rare corrected-re-post-during-create staleness for not corrupting a live long-running create.)
      -- Also re-queue a 'done' row for CALLBACK RECOVERY (finding): 'done' only means the created callback was
      -- ENQUEUED, not delivered. If that callback later went 'dead' (exhausted its retries) or was lost while the
      -- CRM stayed unaware, a same-sourceEventId retry would otherwise 202-no-op and leave the deal permanently
      -- unlinked. Re-queue ONLY when NO live (pending/sent) request-less callback exists for the deal — the worker
      -- then re-runs perform's mapping-first ADOPT and re-sends the 'created' callback. A 'done' row whose callback
      -- is still pending or already sent stays put (preserves duplicate-delivery idempotency).
      WHERE bidboard_create_outbox.status IN ('failed', 'pending')
         OR (
           bidboard_create_outbox.status = 'done'
           AND NOT EXISTS (
             SELECT 1 FROM bidboard_callback_outbox cb
              WHERE cb.source_system = EXCLUDED.source_system
                AND cb.source_deal_id = EXCLUDED.source_deal_id
                AND cb.rfp_approval_request_id IS NULL
                AND cb.status IN ('pending', 'sent')
           )
         )
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

// finding: a POST-create failure (the project was created but the 'created' callback couldn't be enqueued — e.g.
// TROCK_CRM_BASE_URL missing) leaves the row 'processing' for the stale-reclaim to re-run + adopt. RESET
// attempt_count so this callback-delivery recovery is NOT capped by max_attempts — otherwise a config fixed later
// than max_attempts reclaims would never deliver the 'created' callback without a manual same-sourceEventId re-post,
// leaving the accepted vote with a BidBoard project but no CRM notification. The row stays 'processing' with its
// claim-time last_attempt_at, so it reclaims on the next stale window.
async function resetCreateCommandForReclaim(id: number, note: string): Promise<void> {
  const db = await getDb();
  await db.execute(sql`
    UPDATE bidboard_create_outbox SET attempt_count = 0, last_error = ${note} WHERE id = ${id}
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
  // finding: scope the supersede to callbacks STRICTLY OLDER than the one being enqueued (by payload createdAt =
  // the command's receipt time). Deleting EVERY pending request-less callback would let an OLDER reclaimed command
  // (A, still 'processing' with a lagging createdAt) erase a NEWER round's still-pending callback (B) and replace
  // it with A's older createdAt, which the CRM's freshness check then ignores — permanently unlinking B's round.
  // A callback with no createdAt (legacy/pre-AA3) is left alone rather than risking deleting a newer one.
  // Residual race (accepted): if the callback worker has ALREADY claimed a stale 'failed' row (still status
  // 'pending' while its HTTP is in flight), this DELETE removes the row but can't recall the in-flight request, so
  // a stale 'failed' could still reach the CRM after this 'created'. That is covered RECEIVER-SIDE, which is the
  // real supersede guarantee: the CRM's request-less 'failed' handler only applies to a deal still in a
  // create-in-flight state (rfp_approval_status pending, or declined+approving) AND compares the callback createdAt
  // to the round's freshness markers — so a 'failed' arriving after the deal is already 'approved' (or stamped by a
  // newer round) is a no-op. We can't cancel an in-flight HTTP here; ordering is enforced where it can be.
  const db = await getDb();
  const supersedeBefore = typeof payload.createdAt === "string" ? payload.createdAt : null;
  if (supersedeBefore) {
    await db.execute(sql`
      DELETE FROM bidboard_callback_outbox
       WHERE source_system = ${input.sourceSystem}
         AND source_deal_id = ${input.sourceDealId}
         AND rfp_approval_request_id IS NULL
         AND status = 'pending'
         AND payload->>'createdAt' IS NOT NULL
         AND (payload->>'createdAt')::timestamptz < ${supersedeBefore}::timestamptz
    `);
  }
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

// Enqueue a durable 'created' callback. finding: the CRM's created-callback handler REQUIRES procore_company_id
// (it 422s a 'created' that omits it, which would then 422-LOOP forever while this command is already marked
// 'done' — the project would exist with no CRM link). So a missing company id is RETRYABLE: throw before enqueuing
// so the command reclaims until procore_config.companyId / PROCORE_COMPANY_ID is configured, rather than sending an
// unusable 'created'. (Failed callbacks don't need it and stay best-effort.)
async function enqueueCreatedCallback(input: CreateFromRfpInput, bidboardProjectId: string, callbackAt?: string): Promise<void> {
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  if (!procoreCompanyId) {
    throw new Error("Procore company id not configured (procore_config.companyId / PROCORE_COMPANY_ID); cannot enqueue a 'created' callback the CRM would 422");
  }
  await enqueueCreateFromRfpCallback(input, {
    status: "created" as const,
    sourceDealId: input.sourceDealId,
    bidboardProjectId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    // finding AA3: stamp with the command receipt time so a stale in-flight 'created' can't look newer than a
    // later CRM round + slip past the CRM's createdAt-vs-requested_at/reviewed_at freshness.
    createdAt: callbackAt ?? new Date().toISOString(),
  });
}

// The actual create work, run by the worker under serial processing. Returns a discriminated outcome (finding):
//   "created"  — a new BidBoard project was created + a 'created' callback enqueued.
//   "adopted"  — a project already existed for this deal; re-sent the 'created' (adopt) callback.
//   "failed"   — a PRE-create terminal branch (ineligible / conflict / ownership / revised-number) enqueued a
//                'failed' callback and did NOT create a project.
// Throws on a create failure that produced no callback (the caller delivers the failed callback + marks the
// command failed/retryable). The caller uses the outcome to mark the command terminal WITHOUT assuming a normal
// return implies a project was created. callbackAt stamps every callback with the command's receipt time (AA3).
export async function performCreateFromRfpVote(input: CreateFromRfpInput, callbackAt?: string): Promise<"created" | "adopted" | "failed"> {
  const { createBidBoardProjectFromDeal } = await import("../playwright/bidboard");
  const projectNumber = input.deal.projectNumber;

  // [Idempotent adopt / reclaim-after-create] If a BidBoard project ALREADY exists for THIS source deal — a prior
  // attempt created it + wrote the mapping, but a LATER step failed (the 'created' callback persist, or
  // markCreateCommandDone) and the command was reclaimed — do NOT re-check eligibility or re-create. Re-send the
  // 'created' (adopt) callback idempotently. This guarantees a transient post-create error, OR the deal having
  // since left Opportunity, can never flip an already-created project into a 'failed' CRM result (the CRM harmlessly
  // ignores a 'created' for a cancelled deal via its status-not-null guard, but must never be told the create
  // failed when the project exists). A revised projectNumber is the Y2 conflict and is refused, not adopted.
  const existingMapping = await storage.getSyncMappingBySourceDealId(input.sourceSystem as any, input.sourceDealId);
  if (existingMapping?.bidboardProjectId) {
    if (projectNumber && existingMapping.procoreProjectNumber && existingMapping.procoreProjectNumber !== projectNumber) {
      await enqueueFailedCallback(
        input,
        `Deal ${input.sourceDealId} already has BidBoard project ${existingMapping.bidboardProjectId} under number ${existingMapping.procoreProjectNumber}; refusing to create/adopt under revised number ${projectNumber}`,
        callbackAt,
      );
      return "failed";
    }
    await enqueueCreatedCallback(input, existingMapping.bidboardProjectId, callbackAt);
    return "adopted";
  }

  // Eligibility recheck IMMEDIATELY before the create (findings T3 + V4): by now the command may have waited in
  // the queue, and the CRM deal could have been deleted or moved out of Opportunity. Fail-open on a config/5xx
  // check failure (checkRfpApprovalSourceEligibility returns eligible:true then), matching the normal path.
  const eligibility = await checkRfpApprovalSourceEligibility({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
  });
  if (!eligibility.eligible) {
    await enqueueFailedCallback(input, eligibility.reason || "Source CRM deal is no longer eligible for BidBoard creation", callbackAt);
    return "failed";
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
    return "failed";
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
    return "failed";
  }

  // (The same-deal revised-number guard, finding Y2, now runs FIRST via the mapping-first adopt block above — a
  // mapping-exists deal never reaches here.)

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

  await enqueueCreatedCallback(input, result.projectId, callbackAt);
  return "created";
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
  let lockClient: { query: (text: string, params?: any[]) => Promise<any>; release: () => void } | null = null;
  let locked = false;
  try {
    const dbModule: any = await import("../db");
    if (dbModule.pool?.connect) {
      lockClient = await dbModule.pool.connect();
      // Parameterized (not interpolated) even though CREATE_WORKER_LOCK_KEY is a constant — keeps the raw-SQL clean.
      const res = await lockClient!.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [CREATE_WORKER_LOCK_KEY]);
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
      let outcome: "created" | "adopted" | "failed";
      try {
        outcome = await perform(input, callbackAt);
      } catch (error: any) {
        const message = error?.message || String(error);
        // finding: if the project was ALREADY created (a mapping exists for this source deal) but a LATER step
        // threw — the 'created' callback persist, or a transient DB error — this is NOT a create failure. Emitting a
        // 'failed' callback here would tell the CRM the create failed even though the project exists. Leave the row
        // 'processing' (from claimNext) so the stale-reclaim re-runs it and adopts via perform's mapping-first path
        // (which re-sends the 'created' callback), rather than marking it failed + reporting a false failure.
        let createdMapping: any = null;
        try { createdMapping = await storage.getSyncMappingBySourceDealId(input.sourceSystem as any, input.sourceDealId); } catch { /* best-effort */ }
        if (createdMapping?.bidboardProjectId) {
          log(`[bidboard-create] Command ${row.id} created project ${createdMapping.bidboardProjectId} but a post-create step failed (${message}); leaving 'processing' for reclaim`, "sync");
          // finding: reset attempt_count so the callback-delivery recovery isn't capped by max_attempts.
          try { await resetCreateCommandForReclaim(row.id, `created ${createdMapping.bidboardProjectId}; callback pending reclaim: ${message}`); } catch { /* best-effort */ }
          processed += 1;
          continue;
        }
        // Genuine create failure (NO project created). Deliver the failure callback to the CRM BEFORE marking the
        // command terminal (finding): claimNextBidboardCreateCommand never re-picks a 'failed' row, so if we marked
        // it failed first and the failure callback couldn't be enqueued (e.g. TROCK_CRM_BASE_URL unset, or the
        // outbox insert throws), the accepted vote would strand with neither a project nor a failure callback. On a
        // callback-enqueue failure, leave the row 'processing' + reset attempt_count so reclaim re-runs and
        // re-attempts (the create may then succeed, or the failure callback finally enqueues once config is fixed).
        log(`[bidboard-create] Command ${row.id} create for deal ${input.sourceDealId} failed: ${message}`, "sync");
        try {
          await enqueueFailedCallback(input, message, callbackAt);
        } catch (cbErr: any) {
          log(`[bidboard-create] Command ${row.id} failed AND its failure callback could not be enqueued (${cbErr?.message || cbErr}); leaving 'processing' for reclaim`, "sync");
          try { await resetCreateCommandForReclaim(row.id, `create failed; failure callback pending reclaim: ${message}`); } catch { /* best-effort */ }
          processed += 1;
          continue;
        }
        await markCreateCommandFailed(row.id, message);
        processed += 1;
        continue;
      }
      // finding J: perform returned WITHOUT throwing. Distinguish a create from a pre-create terminal refusal — a
      // normal return does NOT imply a project was created. A "failed" outcome enqueued a 'failed' callback and made
      // NO project, so mark the command terminal via markCreateCommandFailed (NOT markCreateCommandDone): if that
      // bookkeeping then failed and the row were left 'processing', a reclaim could CREATE a project after the CRM
      // already received a terminal 'failed' result for this vote.
      if (outcome === "failed") {
        try {
          await markCreateCommandFailed(row.id, "create refused before project creation (ineligible / conflict / ownership / revised-number)");
        } catch (bookErr: any) {
          log(`[bidboard-create] Command ${row.id} refused (no project) but markFailed failed (${bookErr?.message || bookErr}); a reclaim will re-refuse idempotently`, "sync");
        }
        processed += 1;
        continue;
      }
      // "created" or "adopted" — the project exists + a 'created' callback was enqueued.
      try {
        await markCreateCommandDone(row.id);
      } catch (bookErr: any) {
        // Create + 'created' callback already happened; a failed markDone must NOT flip this to a failure. Leave it
        // 'processing' for the stale-reclaim to finish (re-running adopts idempotently via perform's mapping-first).
        log(`[bidboard-create] Command ${row.id} created OK but markDone failed (will re-reconcile): ${bookErr?.message || bookErr}`, "sync");
      }
      processed += 1;
    }
    return { processed };
  } finally {
    if (lockClient) {
      if (locked) {
        try { await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [CREATE_WORKER_LOCK_KEY]); } catch { /* connection may be gone */ }
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
