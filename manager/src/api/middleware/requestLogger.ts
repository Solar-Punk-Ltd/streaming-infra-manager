import { NextFunction, Request, Response } from 'express';

import { Logger } from '../../domain/Logger.js';

const logger = Logger.getInstance();

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info(
      `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`,
    );
  });
  next();
}
