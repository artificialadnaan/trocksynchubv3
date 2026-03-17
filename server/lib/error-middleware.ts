import type { Request, Response, NextFunction } from 'express';

/**
 * Global error handling middleware.
 * Must be registered AFTER all routes.
 */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error('[error]', err.message || err);

  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';

  if (!res.headersSent) {
    res.status(status).json({ message });
  }
}
