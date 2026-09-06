import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { BUNDLED_STACK_ROOT, parseBaseEnv } from '../../utils/envUtils.js';
import { resolveServerHost } from '../../utils/serverHost.js';

const logger = Logger.getInstance();

/**
 * The host-wide facts the frontend needs before it can render anything.
 *
 * `chequebookFloorBzz` is passed in rather than read here, so the number the UI
 * shows is provably the one the deploy gate refuses on.
 */
export function createConfigRouter(chequebookFloorBzz: string): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const host = resolveServerHost();
    // The host-wide passphrase, which lives in the bundled checkout's base .env.
    const srtPassphrase =
      parseBaseEnv(BUNDLED_STACK_ROOT).SRT_PASSPHRASE?.trim() || null;
    logger.info(`[config] GET /config → host=${host}`);
    res.json({ host, srtPassphrase, chequebookFloorBzz });
  });

  return router;
}
