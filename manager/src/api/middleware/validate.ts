import { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AnySchema } from 'yup';

/**
 * Validate-and-coerce middleware. The validated, type-narrowed result replaces
 * the original `req.body` (or params) so downstream handlers see clean data.
 *
 * Yup's ValidationError is caught by errorHandler and mapped to HTTP 400.
 */
/**
 * @param context facts about the manager that no request body carries and every
 *   body is judged against, such as whether this manager has a chain endpoint
 *   of its own. Read once per request, so a schema test sees what the process
 *   is configured with rather than a copy taken at startup.
 */
export function validateBody(
  schema: AnySchema,
  context?: () => object,
): RequestHandler {
  return bodyValidator(schema, { stripUnknown: true, context });
}

/**
 * `validateBody` for a body that replaces a whole set, where a key the schema
 * does not declare is refused by the schema's own `noUnknown` rather than
 * dropped. Dropped, it reads as a request to reset whatever it meant.
 */
export function validateBodyRefusingUnknown(schema: AnySchema): RequestHandler {
  return bodyValidator(schema, { stripUnknown: false });
}

function bodyValidator(
  schema: AnySchema,
  options: { stripUnknown: boolean; context?: () => object },
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = await schema.validate(req.body ?? {}, {
        abortEarly: false,
        stripUnknown: options.stripUnknown,
        context: options.context?.(),
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
