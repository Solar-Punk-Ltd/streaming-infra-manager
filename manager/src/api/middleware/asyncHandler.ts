import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async route handler so a thrown / rejected promise is forwarded to
 * Express's error pipeline instead of becoming an unhandled rejection.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
