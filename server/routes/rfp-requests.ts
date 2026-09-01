import crypto from "crypto";
import { redriveServiceRfpToCore } from "../sync/service-rfp-core-redrive";
import express, { type Express, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { createRfpApprovalRequestFromNormalizedInput, processRfpApproval, checkRfpApprovalSourceEligibility } from "../rfp-approval";
import { storage } from "../storage";
import { sanitizeEstimatorList } from "../../shared/estimators";
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
    // The CRM's customer / job-site uuids. zod STRIPS unknown keys, so without these two lines the
    // CRM's identity fields would be accepted by the endpoint and then silently dropped before ever
    // reaching deal_data — the Core handoff would then take its terminal-skip path on every RFP.
    // Soft in the same way as ownerName/ownerEmail: a malformed value is DROPPED rather than 422'd,
    // because an unusable uuid must not stop an RFP reaching its approver. The consequence of a drop
    // is loud, not silent — the Core handoff records a terminal row and alerts.
    companyId: z.string().trim().nullable().optional().catch(undefined),
    propertyId: z.string().trim().nullable().optional().catch(undefined),
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
    // The CRM's rendered activity log (calls, notes, site visits…), posted as a NOTE on the Bid Board
    // project — never into Procore's Project Description. Soft exactly like ownerName/ownerEmail above:
    // optional (bodies predating the field), nullable (no activity to show) and .catch(undefined) so a
    // malformed value is DROPPED rather than 422'd — a display extra must never block RFP ingestion.
    crmActivityLog: z.string().nullable().optional().catch(undefined),
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
export const createFromRfpBodySchema = rfpRequestBodySchema.extend({
  decision: z.literal("approved"),
});
export type CreateFromRfpInput = z.infer<typeof createFromRfpBodySchema>;

export function signRfpRequestPayload(body: Buffer | string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function getRawBody(req: Request): Buffer | undefined {
  const raw = (req as any).rfpRawBody ?? (req as any).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw);
  return undefined;
}

function verifyRfpRequestSignature(
  req: Request,
  payload?: Buffer,
): { ok: true } | { ok: false; status: 401 | 500; message: string } {
  const secret = process.env.RFP_REQUEST_SYNC_SECRET;
  if (!secret) {
    return { ok: false, status: 500, message: SECRET_MISSING_MESSAGE };
  }

  const provided = req.header(SIGNATURE_HEADER);
  if (!provided) {
    return { ok: false, status: 401, message: "Invalid RFP request signature" };
  }

  // Body routes verify against the captured raw body; a bodyless GET (e.g. /api/rfp/estimators) passes an explicit
  // empty payload so every signature comparison stays centralized in this one helper.
  const body = payload ?? getRawBody(req);
  if (!body) {
    return { ok: false, status: 401, message: "Invalid RFP request signature" };
  }

  const expected = signRfpRequestPayload(body, secret);
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
    // Match the app-level parser's raised cap (server/index.ts): create-from-rfp carries the deal's full
    // attachments list, which for a many-file project exceeds body-parser's 100 KB default → a pre-handler
    // 413 that stranded the Bid Board create. Set here too so this route parses large bodies even if reached
    // before / without the global parser (and so the endpoint is self-contained + testable).
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as any).rfpRawBody = Buffer.from(buf);
    },
  });

  // GET /api/rfp/estimators — expose the SAME curated estimator list the SyncHub Settings page + /rfp-review
  // dropdown use (automation_config['estimator_list']) so the CRM's RFP vote form can mirror it (and reflect edits
  // made here). HMAC-authed with an EMPTY-body signature — a GET has no body, so the caller signs "" — meaning only
  // a caller sharing RFP_REQUEST_SYNC_SECRET (the CRM) can read it; distinct from the session-authed
  // /api/settings/estimators the SyncHub UI uses.
  app.get("/api/rfp/estimators", asyncHandler(async (req, res) => {
    // A GET has no body, so verify the signature over the empty string (only a caller sharing the secret can read).
    const signature = verifyRfpRequestSignature(req, Buffer.from(""));
    if (!signature.ok) {
      const body = signature.status === 401
        ? { success: false, error: "Unauthorized", message: signature.message }
        : { success: false, error: "Internal Server Error", message: signature.message };
      return res.status(signature.status).json(body);
    }
    const config = await storage.getAutomationConfig("estimator_list");
    const estimators = sanitizeEstimatorList(
      ((config?.value as any)?.estimators || []) as Array<{ name: string; email: string }>,
    );
    res.json({ estimators });
  }));

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
  // Re-drive a Core delivery that never landed, for an ALREADY-APPROVED request.
  //
  // The gap this closes: when a delivery fails for a correctable reason — a customer that existed in
  // Core's directory without its CRM id, an office the handoff wrongly refused, CRM uuids not yet
  // deployed — every other entry point refuses the request because it is already `approved`.
  // processRfpApproval rejects non-pending, override-approve accepts only declined, the force path
  // rejects approved. So the job never reached Core and the only recovery was editing the outbox by
  // hand. That happened three times before this existed.
  //
  // SAFE TO CALL ON AN APPROVAL THAT ALREADY LANDED. The unique index + upsert guard mean a re-drive
  // may only replace a row that NEVER LEFT; a sent or queued row is untouched and the caller gets
  // `duplicate`. Idempotent by construction, which matters because `bid` has no deleted_at — a
  // duplicate card could not be removed.
  //
  // HMAC-signed like override-approve beside it, so the same operator tooling reaches it.
  app.post("/api/rfp-requests/:id/redrive-core", jsonWithRawBody, asyncHandler(async (req, res) => {
    // Verified against an EMPTY payload, like the bodyless route above [Codex #83]. This endpoint takes
    // no body, and Express's JSON parser skips a request that has none — so its `verify` callback never
    // runs, `rfpRawBody` stays unset, and a correctly-signed empty request 401s. That would have forced
    // operators to discover an undocumented `{}` body to authenticate a call with no parameters.
    const signature = verifyRfpRequestSignature(req, Buffer.from(""));
    if (!signature.ok) {
      return res.status(signature.status).json({
        success: false,
        error: signature.status === 401 ? "Unauthorized" : "Internal Server Error",
        message: signature.message,
      });
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: "Bad Request", message: "Invalid RFP request id" });
    }

    const outcome = await redriveServiceRfpToCore(id);
    if (!outcome.ok) {
      // 409 rather than 400: the request exists and the input was well formed — it is the request's
      // STATE that makes a re-drive wrong, which is a conflict, and the reason names which state.
      const status = outcome.reason === "not_found" ? 404 : 409;
      return res.status(status).json({ success: false, error: outcome.reason, message: outcome.detail });
    }
    return res.status(200).json({ success: true, status: outcome.status });
  }));

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

    // create-from-rfp is a trock_crm VOTING command only (the CRM's 2/3-approve / override-approve
    // vote). Reject any other source before the 202 — a hubspot-shaped payload reaching here would
    // otherwise mint a trock_crm BidBoard project + callback for a deal this endpoint doesn't own.
    // finding: return 422 (not 409) — this endpoint's contract with the CRM delivery job is 401/500/422/202, so a
    // 409 reads as an unhandled conflict. An unsupported sourceSystem is a payload-validation failure -> 422.
    if (input.sourceSystem !== "trock_crm") {
      return res.status(422).json({
        success: false,
        error: "Unprocessable Entity",
        message: "create-from-rfp is only supported for trock_crm voting requests",
      });
    }

    // Persist the create command BEFORE acknowledging (finding V3): a crash after this 202 still resumes,
    // because the durable command row exists and the serial bidboard-create worker will pick it up. The worker
    // does the eligibility recheck + guards + Playwright create + durable callback (findings V1/V2/V4). Idempotent
    // on sourceEventId — a duplicate delivery is a no-op; a previously-failed command is re-queued.
    try {
      // finding: lazy-load the create worker so it's only imported when a create-from-rfp actually arrives. A
      // top-level import pulls in bidboard-create-worker -> ../index -> server/db.ts for EVERY rfp-requests route
      // (override-approve, etc.), which throws at import time in environments where DATABASE_URL is intentionally
      // unset — stranding unrelated routes. The dynamic import keeps that cost on this handler only.
      const { enqueueBidboardCreateCommand } = await import("../sync/bidboard-create-worker");
      await enqueueBidboardCreateCommand(input);
    } catch (err: any) {
      console.error(`[rfp-requests] failed to enqueue create-from-rfp command for deal ${input.sourceDealId}:`, err?.message || err);
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
        message: "Failed to enqueue create-from-rfp command",
      });
    }

    return res.status(202).json({
      success: true,
      queued: true,
      sourceDealId: input.sourceDealId,
      projectNumber: input.deal.projectNumber,
    });
  }));
}
