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

    // Check source eligibility synchronously (like the email-approval route) so an ineligible deal
    // gets a terminal 409 the CRM can act on — rather than a 202 followed by a silent background
    // cancellation with no callback. Fail-open on a CRM lookup error (eligibility.checkFailed).
    const eligibility = await checkRfpApprovalSourceEligibility(request);
    if (!eligibility.eligible) {
      return res.status(409).json({
        success: false,
        error: "Conflict",
        message: eligibility.reason || `RFP request ${id} source deal is no longer eligible`,
      });
    }

    // Durable, cross-instance claim: atomically transition declined → override_approving before
    // queueing the Playwright work (the create has no server-side dedup). The transitional status is
    // NOT 'pending', so the email-approval route can't also approve it; it IS blocked by
    // createRfpApprovalRequest's conflict checks, so a re-bid can't insert a duplicate request. A
    // concurrent override or a second app instance loses this race and gets 409; the claim also
    // deletes any stale callback row.
    const claimed = await storage.claimDeclinedRfpForOverride(id);
    if (!claimed) {
      return res.status(409).json({
        success: false,
        error: "Conflict",
        message: `RFP request ${id} could not be claimed for override (already in progress or no longer declined)`,
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
}
