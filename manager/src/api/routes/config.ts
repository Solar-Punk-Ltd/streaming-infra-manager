import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { resolveServerHost } from '../../utils/serverHost.js';

const logger = Logger.getInstance();

/**
 * The host-wide facts the frontend needs before it can render anything.
 *
 * `chequebookFloorBzz` is passed in rather than read here, so the number the UI
 * shows is provably the one the deploy gate refuses on. The passphrase comes
 * from whoever knows where the bundled stack runs, its legacy tree or its
 * current build, rather than from a fixed path.
 */
export function createConfigRouter(
  chequebookFloorBzz: string,
  hostPassphrase: () => Promise<string | null>,
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next) => {
    try {
      const host = resolveServerHost();
      const srtPassphrase = await hostPassphrase();
      logger.info(`[config] GET /config → host=${host}`);
      res.json({ host, srtPassphrase, chequebookFloorBzz });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
