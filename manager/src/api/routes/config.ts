import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { resolveServerHost } from '../../utils/serverHost.js';

const logger = Logger.getInstance();

export function createConfigRouter(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const host = resolveServerHost();
    logger.info(`[config] GET /config → host=${host}`);
    res.json({ host });
  });

  return router;
}
