import crypto from "crypto";
import express, { type Express, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { createRfpApprovalRequestFromNormalizedInput, processRfpApproval, checkRfpApprovalSourceEligibility } from "../rfp-approval";
import { storage } from "../storage";
import { RFP_OVERRIDE_APPROVING_STATUS } from "@shared/schema";

const SIGNATURE_HEADER = "x-rfp-request-signature";
const SECRET_MISSING_MESSAGE = "RFP_REQUEST_SYNC_SECRET not configured — POST /api/rfp-requests will reject all requests with 500";

const overrideApproveBodySchema = z.object({
  approverEmail: z.string().trim().email(),
});

export const rfpRequestBodySchema = z.object({
  sourceSystem: z.enum(["hubspot", "trock_crm"]),
  sourceDealId: z.string().trim().min(1),
  sourceEventId: z.string().trim().min(1),
  deal: z.object({
    name: z.string().trim().min(1),
    projectNumber: z.string().trim().min(1),
    projectType: z.string().trim().min(1),
    amount: z.number().finite().nullable(),
    estimator: z.string().trim().nullable(),
    // Deal owner / rep — the "Requested by" person. Truly non-rejecting: a malformed value
    // (e.g. an object/id sent mid-rollout) is DROPPED via .catch(undefined), not 422'd — a soft
    // display field must never block RFP ingestion. The CRM resolves it from assigned_rep → owner.
    ownerName: z.string().trim().nullable().optional().catch(undefined),
    ownerEmail: z.string().trim().nullable().optional().catch(undefined),
    companyName: z.string().trim().nullable(),
    contactName: z.string().trim().nullable(),
    clientEmail: z.string().trim().email().nullable(),
    clientPhone: z.string().trim().nullable(),
    address: z.object({
      street: z.string().trim().nullable(),
      city: z.string().trim().nullable(),
      state: z.string().trim().nullable(),
      zip: z.string().trim().nullable(),
      country: z.string().trim().nullable(),
    }).nullable(),
    description: z.string().trim().nullable(),
    dueDate: z.string().trim().datetime({ offset: true }).nullable(),
    workflowRoute: z.string().trim().nullable(),
  }),
  attachments: z.array(z.object({
    name: z.string().trim().min(1),
    url: z.string().trim().url(),
    contentType: z.string().trim().min(1),
  })).default([]),
});

export type RfpRequestBody = z.infer<typeof rfpRequestBodySchema>;

// Body for POST /api/bid-board/create-from-rfp: the CRM's normalized RFP body plus an explicit
// decision guard. The CRM only calls this on a 2/3-approve vote (or override-approve), so decision
// must be exactly "approved".
const createFromRfpBodySchema = rfpRequestBodySchema.extend({
  decision: z.literal("approved"),
});

export function signRfpRequestPayload(body: Buffer | string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function getRawBody(req: Request): Buffer | undefined {
  const raw = (req as any).rfpRawBody ?? (req as any).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw);
  return undefined;
}

function verifyRfpRequestSignature(req: Request): { ok: true } | { ok: false; status: 401 | 500; message: string } {
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    return { ok: false, status: 500, message: SECRET_MISSING_MESSAGE };
  }

  const provided = req.header(SIGNATURE_HEADER);
  if (!provided) {
    return { ok: false, status: 401, message: "Invalid RFP request signature" };
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    return { ok: false, status: 401, message: "Invalid RFP request signature" };
  }

  const expected = signRfpRequestPayload(rawBody, secret);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return { ok: false, status: 401, message: "Invalid RFP request signature" };
  }

  return { ok: true };
}

function responseBodyForResult(result: Awaited<ReturnType<typeof createRfpApprovalRequestFromNormalizedInput>>, body: RfpRequestBody) {
  if (result.success) {
    return {
      success: true,
      idempotent: result.idempotent || undefined,
      requestId: result.requestId,
      token: result.token,
      status: result.status,
      sourceSystem: body.sourceSystem,
      sourceDealId: body.sourceDealId,
      sourceEventId: body.sourceEventId,
      projectNumber: body.deal.projectNumber,
    };
  }

  if ("code" in result) {
    return {
      success: false,
      error: result.code,
      message: result.message,
      projectNumber: result.projectNumber,
      conflict: result.conflict,
    };
  }

  if (result.statusCode === 409) {
    return {
      success: false,
      error: result.error,
      message: "message" in result ? result.message : result.error,
      conflict: "conflict" in result ? result.conflict : undefined,
    };
  }

  return {
    success: false,
    error: "Internal Server Error",
    message: result.error,
  };
}

export function logMissingRfpRequestSecret(): void {
  if (!process.env.RFP_REQUEST_SYNC_SECRET) {
    console.error(`[rfp-requests] ERROR ${SECRET_MISSING_MESSAGE}`);
  }
}

export function registerRfpRequestRoutes(app: Express): void {
  logMissingRfpRequestSecret();

  const jsonWithRawBody = express.json({
    verify: (req, _res, buf) => {
      (req as any).rfpRawBody = Buffer.from(buf);
    },
  });

  app.post("/api/rfp-requests", jsonWithRawBody, asyncHandler(async (req, res) => {
    const signature = verifyRfpRequestSignature(req);
    if (!signature.ok) {
      const body = signature.status === 401
        ? { success: false, error: "Unauthorized", message: signature.message }
        : { success: false, error: "Internal Server Error", message: signature.message };
      return res.status(signature.status).json(body);
    }

    const parsed = rfpRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: "Unprocessable Entity",
        message: "RFP request validation failed",
        issues: parsed.error.issues,
      });
    }

    const result = await createRfpApprovalRequestFromNormalizedInput(parsed.data);
    const body = responseBodyForResult(result, parsed.data);

    if (result.success) {
      return res.status(result.idempotent ? 200 : 201).json(body);
    }

    if (result.statusCode === 409) {
      return res.status(409).json(body);
    }

    return res.status(result.statusCode || 500).json(body);
  }));

  // Override-approve: when a CRM reviewer (e.g. Adam/Takashi) approves a previously-declined RFP,
  // fire the REAL authoritative approval — the Playwright Bid Board project creation — so the deal
  // links Procore and advances to estimating, exactly like a normal approval. HMAC-secured (no
  // requireAuth), runs in the background (202), and on a Playwright failure leaves the request
  // re-tryable (it is NOT marked approved) and emits a 'failed' callback to the CRM.
  app.post("/api/rfp-requests/:id/override-approve", jsonWithRawBody, asyncHandler(async (req, res) => {
    const signature = verifyRfpRequestSignature(req);
    if (!signature.ok) {
      const body = signature.status === 401
        ? { success: false, error: "Unauthorized", message: signature.message }
        : { success: false, error: "Internal Server Error", message: signature.message };
      return res.status(signature.status).json(body);
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: "Bad Request", message: "Invalid RFP request id" });
    }

    const parsed = overrideApproveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: "Unprocessable Entity",
        message: "approverEmail is required and must be a valid email",
        issues: parsed.error.issues,
      });
    }
    const approverEmail = parsed.data.approverEmail.trim();

    const request = await storage.getRfpApprovalRequestById(id);
    if (!request) {
      return res.status(404).json({ success: false, error: "Not Found", message: `RFP request ${id} not found` });
    }

    // Guards. Only a declined trock_crm request with no existing BidBoard project may be overridden.
    // (status='declined' ⇒ bidboardProjectId IS NULL is an invariant; the bidboardProjectId check is
    // defense-in-depth that also prevents double-creating a Procore project — the create has no dedup.)
    if ((request.sourceSystem || "hubspot") !== "trock_crm") {
      return res.status(409).json({ success: false, error: "Conflict", message: "Override-approve is only supported for trock_crm RFP requests" });
    }
    // A duplicate override for a request already mid-flight is idempotently accepted (202 in-progress),
    // not a conflict — the BidBoard creation is already queued/running.
    if (request.status === RFP_OVERRIDE_APPROVING_STATUS) {
      return res.status(202).json({ success: true, queued: true, message: `RFP request ${id} override approval is already in progress.` });
    }
    if (request.status !== "declined") {
      return res.status(409).json({ success: false, error: "Conflict", message: `RFP request ${id} is ${request.status}; override-approve requires a declined request` });
    }
    if (request.bidboardProjectId) {
      return res.status(409).json({ success: false, error: "Conflict", message: `RFP request ${id} already has BidBoard project ${request.bidboardProjectId}; refusing to double-create` });
    }
    // A re-bid may have created a NEWER request for the same project number that is already approved
    // (with its own BidBoard project). This stale declined row has no bidboardProjectId of its own, so
    // overriding it would create a SECOND project for that project number — mirror createRfpApprovalRequest's
    // approved_collision and refuse.
    if (request.projectNumber) {
      const approvedSibling = await storage.getRfpApprovalRequestByProjectNumberAndStatus(request.projectNumber, "approved");
      if (approvedSibling && approvedSibling.id !== request.id) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message: `Project ${request.projectNumber} already has an approved RFP (request ${approvedSibling.id}); refusing to double-create`,
        });
      }
    }

    // Durable, cross-instance claim FIRST — before the awaited eligibility call — so a re-bid webhook
    // can't slip in during the check while the row is still 'declined'. Atomically transition declined
    // → override_approving (NOT 'pending', so the email route can't also approve it; createRfpApproval's
    // conflict checks DO block it, so a re-bid can't insert a duplicate). A concurrent override or a
    // second app instance loses this race and gets 409; the claim also deletes any stale callback row.
    const claimed = await storage.claimDeclinedRfpForOverride(id);
    if (!claimed) {
      // Lost the claim race. If the winner is already mid-flight (override_approving), this is an
      // idempotent duplicate → 202 in-progress, not a conflict. Otherwise the row is no longer
      // claimable (e.g. concurrently approved/resolved) → 409.
      const current = await storage.getRfpApprovalRequestById(id);
      if (current?.status === RFP_OVERRIDE_APPROVING_STATUS) {
        return res.status(202).json({ success: true, queued: true, message: `RFP request ${id} override approval is already in progress.` });
      }
      return res.status(409).json({
        success: false,
        error: "Conflict",
        message: `RFP request ${id} could not be claimed for override (already in progress or no longer declined)`,
      });
    }

    // Now check source eligibility (like the email-approval route) so an ineligible deal gets a
    // terminal 409 rather than a 202 + silent background cancel. Release the claim back to 'declined'
    // on rejection — this is safe (no Playwright has run yet, so no project can exist). Fail-open on a
    // CRM lookup error (eligibility.checkFailed).
    const eligibility = await checkRfpApprovalSourceEligibility(claimed);
    if (!eligibility.eligible) {
      await storage.updateRfpApprovalRequest(id, { status: "declined" });
      return res.status(409).json({
        success: false,
        error: "Conflict",
        message: eligibility.reason || `RFP request ${id} source deal is no longer eligible`,
      });
    }

    res.status(202).json({
      success: true,
      queued: true,
      message: "Override approval queued; BidBoard project creation will run in the background.",
    });

    // No blanket claim-release here: a release that fires after the Playwright job already created a
    // project (but a later step threw before persisting it) would wrongly re-open the request for a
    // retry and create a SECOND project. Instead processRfpApproval restores 'declined' only in the
    // branch where it KNOWS no project was created; an unexpected mid-create error leaves the request
    // claimed ('override_approving') — a safe, indeterminate state needing manual resolution.
    setImmediate(async () => {
      try {
        const result = await processRfpApproval(claimed.token, {}, approverEmail, { force: true });
        if (!result.success) {
          console.error(`[rfp-requests] Override approval failed for request ${id}: ${result.error || "unknown error"}`);
        }
      } catch (err: any) {
        console.error(`[rfp-requests] Override approval error for request ${id}:`, err?.message || err);
      }
    });
  }));

  // Create-on-command from a CRM RFP VOTE (2/3-approve or override-approve). The CRM already decided, so
  // this creates the BidBoard project immediately (no email, no rfp_approval_requests row, no vote storage
  // here) and posts the existing bid-board-created callback keyed by sourceDealId. HMAC-secured; 202 + async.
  // NOTE: this endpoint NEVER returns 409 — duplicate creates are absorbed by the syncMappings adopt-guard
  // inside createBidBoardProjectFromDeal (returns success), so the CRM's fire-and-forget delivery job needs
  // no 409 handling.
  app.post("/api/bid-board/create-from-rfp", jsonWithRawBody, asyncHandler(async (req, res) => {
    const signature = verifyRfpRequestSignature(req);
    if (!signature.ok) {
      const body = signature.status === 401
        ? { success: false, error: "Unauthorized", message: signature.message }
        : { success: false, error: "Internal Server Error", message: signature.message };
      return res.status(signature.status).json(body);
    }

    const parsed = createFromRfpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: "Unprocessable Entity",
        message: "create-from-rfp validation failed",
        issues: parsed.error.issues,
      });
    }
    const input = parsed.data;

    res.status(202).json({
      success: true,
      queued: true,
      sourceDealId: input.sourceDealId,
      projectNumber: input.deal.projectNumber,
    });

    setImmediate(async () => {
      try {
        await createBidBoardFromRfpVote(input);
      } catch (err: any) {
        console.error(`[rfp-requests] create-from-rfp failed for deal ${input.sourceDealId}:`, err?.message || err);
      }
    });
  }));
}

async function createBidBoardFromRfpVote(input: z.infer<typeof createFromRfpBodySchema>): Promise<void> {
  const { createBidBoardProjectFromDeal } = await import("../playwright/bidboard");
  const { buildBidBoardCreatedCallbackTargetUrl } = await import("../sync/bidboard-callback-worker");

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
  };

  // Reuses the syncMappings adopt-guard inside createBidBoardProjectFromDeal (one deal -> one project).
  const result = await createBidBoardProjectFromDeal({
    sourceSystem: "trock_crm",
    sourceDealId: input.sourceDealId,
    bidboardStage: "Estimate in Progress",
    normalizedDealData,
    options: { syncDocuments: true },
  });

  const targetUrl = buildBidBoardCreatedCallbackTargetUrl();
  if (!targetUrl) {
    console.error(`[rfp-requests] TROCK_CRM_BASE_URL not configured; cannot deliver create-from-rfp callback for deal ${input.sourceDealId}`);
    return;
  }
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    console.error("[rfp-requests] RFP_REQUEST_SYNC_SECRET not configured; cannot deliver create-from-rfp callback");
    return;
  }

  const procoreCompanyId = await resolveProcoreCompanyIdForCallback();

  // Voting-path callback: NO rfpApprovalRequestId (no request row). The CRM resolves by sourceDealId.
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

  await deliverCreateFromRfpCallback(targetUrl, payload, secret);
}

async function resolveProcoreCompanyIdForCallback(): Promise<string | undefined> {
  const getAutomationConfig = (storage as any).getAutomationConfig;
  const config = typeof getAutomationConfig === "function"
    ? await getAutomationConfig.call(storage, "procore_config")
    : null;
  return String((config?.value as any)?.companyId || process.env.PROCORE_COMPANY_ID || "").trim() || undefined;
}

async function deliverCreateFromRfpCallback(targetUrl: string, payload: Record<string, any>, secret: string): Promise<void> {
  const { fetchWithTimeout } = await import("../lib/fetch-with-timeout");
  const rawBody = JSON.stringify(payload);
  const sig = signRfpRequestPayload(rawBody, secret);
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const resp = await fetchWithTimeout(targetUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rfp-request-signature": sig },
        body: rawBody,
      });
      if (resp.ok) return;
      if (attempt === MAX) console.error(`[rfp-requests] create-from-rfp callback failed with ${resp.status}`);
    } catch (err: any) {
      if (attempt === MAX) console.error(`[rfp-requests] create-from-rfp callback error: ${err?.message || err}`);
    }
    if (attempt < MAX) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}
