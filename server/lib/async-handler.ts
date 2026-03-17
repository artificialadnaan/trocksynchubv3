import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so that rejected promises are passed to next().
 * Eliminates the need for try/catch in every route handler.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
