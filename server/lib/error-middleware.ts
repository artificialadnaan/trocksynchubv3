import type { Request, Response, NextFunction } from 'express';

/**
 * Global error handling middleware.
 * Must be registered AFTER all routes.
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error('[error]', err.message || err);

  const status = err.status || err.statusCode || 500;
  // A 4xx describes what the CALLER did wrong and carries no internals, so its reason must survive
  // into the response. Masking it is what turned body-parser's "request entity too large" into an
  // undiagnosable "Internal server error" for a rep whose RFP body was too big (TRK-2607-H3X6).
  // 5xx messages can carry connection strings or stack detail, so those stay masked in production.
  const isClientError = status >= 400 && status < 500;
  const message = process.env.NODE_ENV === 'production' && !isClientError
    ? 'Internal server error'
    : err.message || 'Internal server error';

  if (!res.headersSent) {
    res.status(status).json({ message });
  }
}
