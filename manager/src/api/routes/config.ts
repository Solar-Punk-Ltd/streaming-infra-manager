import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { parseBaseEnv } from '../../utils/envUtils.js';
import { resolveServerHost } from '../../utils/serverHost.js';

const logger = Logger.getInstance();

export function createConfigRouter(): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const host = resolveServerHost();
    // Global SRT encryption passphrase from the submodule base .env (empty =
    // SRT runs unencrypted). Surfaced so the UI can build a complete publish URL.
    const srtPassphrase = parseBaseEnv().SRT_PASSPHRASE?.trim() || null;
    logger.info(`[config] GET /config → host=${host}`);
    res.json({ host, srtPassphrase });
  });

  return router;
}
