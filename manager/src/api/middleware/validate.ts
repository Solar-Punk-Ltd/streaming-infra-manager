import { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AnySchema } from 'yup';

/**
 * Validate-and-coerce middleware. The validated, type-narrowed result replaces
 * the original `req.body` (or params) so downstream handlers see clean data.
 *
 * Yup's ValidationError is caught by errorHandler and mapped to HTTP 400.
 */
export function validateBody(schema: AnySchema): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = await schema.validate(req.body ?? {}, {
        abortEarly: false,
        stripUnknown: true,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function validateParams(schema: AnySchema): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const validated = await schema.validate(req.params, {
        abortEarly: false,
        stripUnknown: true,
      });
      Object.assign(req.params, validated);
      next();
    } catch (err) {
      next(err);
    }
  };
}
