import { NextFunction, Request, Response } from 'express';
import { ValidationError as YupValidationError } from 'yup';

import { Logger } from '../../domain/Logger.js';
import {
  AllPrefixesUsedError,
  ProfileExistsError,
  ProfileNotFoundError,
} from '../../domain/ProfileService.js';

const logger = Logger.getInstance();

/**
 * Centralised error → HTTP mapping. Domain errors get specific status codes;
 * everything else becomes a 500 with the message logged but not echoed back.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof YupValidationError) {
    res.status(400).json({ error: 'validation_error', errors: err.errors });
    return;
  }
  if (err instanceof ProfileNotFoundError) {
    res.status(404).json({ error: 'profile_not_found', name: err.name });
    return;
  }
  if (err instanceof ProfileExistsError) {
    res.status(409).json({ error: 'profile_exists', name: err.name });
    return;
  }
  if (err instanceof AllPrefixesUsedError) {
    res.status(503).json({ error: 'all_prefixes_used', message: err.message });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error(`[HTTP] ${req.method} ${req.originalUrl} unhandled:`, message);
  if (err instanceof Error && err.stack) logger.error(err.stack);
  res.status(500).json({ error: 'internal_error' });
}
