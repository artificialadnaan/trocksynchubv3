import express, { type Express, type NextFunction, type Request, type Response } from "express";

// The endpoints that legitimately receive a large body: the CRM's HMAC-authed RFP POSTs, which carry the
// deal's normalized RFP body PLUS its full attachments list (one presigned URL per deal file). Both routes
// mount a SCOPED 10mb parser (see registerRfpRequestRoutes), so the GLOBAL parser below must SKIP them.
// Raising the global cap instead would let ANY unauthenticated JSON request to ANY route buffer up to 10mb —
// a memory-exhaustion surface, since this parser runs before auth/HMAC. Everything else keeps body-parser's
// small 100 KB default.
//
// /api/rfp-requests was MISSED when this skip was introduced: it takes the same body from the same builder,
// so a file-heavy deal's RFP trigger was rejected at the global parser before its own 10mb parser ever ran,
// and before the HMAC check. The rep saw a masked "413: Internal server error" and the deal never advanced
// to service_estimating (TRK-2607-H3X6).
export const CREATE_FROM_RFP_PATH = "/api/bid-board/create-from-rfp";
export const RFP_REQUESTS_PATH = "/api/rfp-requests";

/** Paths whose own scoped 10mb parser must not be pre-empted by the global 100 KB parser. */
export const LARGE_BODY_PATHS: ReadonlySet<string> = new Set([CREATE_FROM_RFP_PATH, RFP_REQUESTS_PATH]);

/**
 * Mount the app-level JSON + urlencoded body parsers. Extracted so the real production config (the global cap +
 * the large-body skips) is exercised by tests rather than approximated. The global JSON parser captures the
 * raw body (for HMAC verification on the RFP routes) and skips LARGE_BODY_PATHS so each of those routes is
 * parsed by its own scoped 10mb parser instead.
 */
/**
 * Express routes with default `strict: false` / `caseSensitive: false`, so `/api/rfp-requests/`,
 * `/API/RFP-Requests` and `/api/rfp-requests//` all reach the same handler. An exact, case-sensitive
 * lookup would miss those and send them through the 100 KB global parser — reintroducing the very
 * 413 this skip exists to prevent — so match on the same normalization Express itself applies.
 */
export function normalizeRoutePath(path: string): string {
  const lowered = path.toLowerCase();
  const trimmed = lowered.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function mountJsonBodyParsers(app: Express): void {
  const globalJson = express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (LARGE_BODY_PATHS.has(normalizeRoutePath(req.path))) return next();
    return globalJson(req, res, next);
  });
  app.use(express.urlencoded({ extended: false }));
}
