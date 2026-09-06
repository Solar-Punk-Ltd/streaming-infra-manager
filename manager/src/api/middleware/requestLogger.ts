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
    // The username, never the session token: this line goes to the container
    // log, and a token there would be a spare key to the manager.
    const who = req.user ? ` user=${req.user.username}` : '';
    logger.info(
      `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms${who}`,
    );
  });
  next();
}
