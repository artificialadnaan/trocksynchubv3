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
      SET status = 'pending', next_attempt_at = NOW(), attempt_count = 0, last_error = NULL
      WHERE bidboard_create_outbox.status = 'failed'
  `);
}

// Claim ONE pending/retryable command at a time (serial → satisfies the same-project-number ordering V1 needs +
// keeps at most one Playwright create in flight, matching withBrowserLock). FOR UPDATE SKIP LOCKED so overlapping
// ticks / a second process can't double-claim.
export async function claimNextBidboardCreateCommand(): Promise<any | null> {
  const db = await getDb();
  const result = await db.execute(sql`
    UPDATE bidboard_create_outbox
       SET status = 'processing', last_attempt_at = NOW(), attempt_count = attempt_count + 1
     WHERE id IN (
       SELECT id FROM bidboard_create_outbox
        WHERE status = 'pending' AND next_attempt_at <= NOW()
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
    log(`[bidboard-create] TROCK_CRM_BASE_URL not configured; cannot enqueue callback for deal ${input.sourceDealId}`, "sync");
    return;
  }
  await storage.enqueueBidboardCallback({
    sourceSystem: input.sourceSystem,
    sourceDealId: input.sourceDealId,
    rfpApprovalRequestId: null,
    payload,
    targetUrl,
  });
}

async function enqueueFailedCallback(input: CreateFromRfpInput, error: string): Promise<void> {
  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  await enqueueCreateFromRfpCallback(input, {
    status: "failed",
    sourceDealId: input.sourceDealId,
    projectNumber: input.deal.projectNumber,
    procoreCompanyId,
    error,
    createdAt: new Date().toISOString(),
  });
}

// The actual create work, run by the worker under serial processing. Throws on unexpected errors (the caller
// marks the command failed + delivers a failed callback); returns normally after enqueuing the created/failed
// callback for the create result.
export async function performCreateFromRfpVote(input: CreateFromRfpInput): Promise<void> {
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
    await enqueueFailedCallback(input, eligibility.reason || "Source CRM deal is no longer eligible for BidBoard creation");
    return;
  }

  // [Collision guard] (findings S3/S4) — block a conflicting email/override approval for the same project/deal.
  const inFlightApproval =
    (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "pending"))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, RFP_OVERRIDE_APPROVING_STATUS))
    ?? (await storage.getRfpApprovalRequestByProjectNumberAndStatus(projectNumber, "approved"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, "pending"))
    ?? (await storage.getRfpApprovalRequestBySourceDealAndStatus(input.sourceSystem, input.sourceDealId, RFP_OVERRIDE_APPROVING_STATUS));
  if (inFlightApproval) {
    await enqueueFailedCallback(
      input,
      `Project ${projectNumber} / deal ${input.sourceDealId} already has a conflicting RFP approval (request ${inFlightApproval.id}, status ${inFlightApproval.status}); not creating from vote`,
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

  if (!result.success) {
    log(`[bidboard-create] BidBoard create failed for deal ${input.sourceDealId}: ${result.error || "unknown"}`, "sync");
  }

  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();
  const payload = result.success && result.projectId
    ? {
        status: "created" as const,
        sourceDealId: input.sourceDealId,
        bidboardProjectId: result.projectId,
        projectNumber: input.deal.projectNumber,
        procoreCompanyId,
        createdAt: new Date().toISOString(),
      }
    : {
        status: "failed" as const,
        sourceDealId: input.sourceDealId,
        projectNumber: input.deal.projectNumber,
        procoreCompanyId,
        error: result.error || "BidBoard project creation failed",
        createdAt: new Date().toISOString(),
      };
  await enqueueCreateFromRfpCallback(input, payload);
}

export async function processBidboardCreateOutbox(deps: { performImpl?: typeof performCreateFromRfpVote } = {}): Promise<{ processed: number }> {
  if (createWorkerRunning) return { processed: 0 };
  createWorkerRunning = true;
  const perform = deps.performImpl ?? performCreateFromRfpVote;
  let processed = 0;
  try {
    // Drain the queue one command at a time (serial).
    for (;;) {
      const row = await claimNextBidboardCreateCommand();
      if (!row) break;
      const input = (row.payload ?? {}) as CreateFromRfpInput;
      try {
        await perform(input);
        await markCreateCommandDone(row.id);
      } catch (error: any) {
        const message = error?.message || String(error);
        log(`[bidboard-create] Command ${row.id} for deal ${input.sourceDealId} failed: ${message}`, "sync");
        await markCreateCommandFailed(row.id, message);
        // Best-effort: still tell the CRM this attempt failed so it isn't left waiting.
        try { await enqueueFailedCallback(input, message); } catch { /* logged upstream */ }
      }
      processed += 1;
    }
    return { processed };
  } finally {
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
