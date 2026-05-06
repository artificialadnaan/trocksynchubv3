import crypto from "crypto";
import express, { type Express, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { createRfpApprovalRequestFromNormalizedInput } from "../rfp-approval";

const SIGNATURE_HEADER = "x-rfp-request-signature";
const SECRET_MISSING_MESSAGE = "RFP_REQUEST_SYNC_SECRET not configured — POST /api/rfp-requests will reject all requests with 500";

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
}
