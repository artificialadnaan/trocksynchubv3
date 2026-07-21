import express, { type Express, type NextFunction, type Request, type Response } from "express";

// The ONE endpoint that legitimately receives a large body: the CRM's HMAC-authed create-from-rfp POST carries
// the deal's normalized RFP body PLUS its full attachments list (one presigned URL per deal file). Its route
// mounts a SCOPED 10mb parser (see registerRfpRequestRoutes), so the GLOBAL parser below must SKIP this path.
// Raising the global cap instead would let ANY unauthenticated JSON request to ANY route buffer up to 10mb —
// a memory-exhaustion surface, since this parser runs before auth/HMAC. Everything else keeps body-parser's
// small 100 KB default.
export const CREATE_FROM_RFP_PATH = "/api/bid-board/create-from-rfp";

/**
 * Mount the app-level JSON + urlencoded body parsers. Extracted so the real production config (the global cap +
 * the create-from-rfp skip) is exercised by tests rather than approximated. The global JSON parser captures the
 * raw body (for HMAC verification on the RFP routes) and skips CREATE_FROM_RFP_PATH so that route's own 10mb
 * parser handles it.
 */
export function mountJsonBodyParsers(app: Express): void {
  const globalJson = express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      req.rawBody = buf;
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === CREATE_FROM_RFP_PATH) return next();
    return globalJson(req, res, next);
  });
  app.use(express.urlencoded({ extended: false }));
}
