import { Request, Response, Router } from 'express';

import { EngineConfigService } from '../../domain/engineConfig/EngineConfigService.js';
import {
  type EngineConfigBody,
  engineConfigBodySchema,
} from '../../schemas/engineConfig.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/**
 * A config file of the deployment's own for its media engine.
 *
 * Mounted after the session gate like every other router here. The answers
 * are marked no-store: the template carries nothing secret, but a file the
 * operator is editing has no business in a proxy cache either.
 */
export function createEngineConfigRouter(
  engineConfig: EngineConfigService,
): Router {
  const router = Router();

  router.get(
    '/profiles/:name/engine-config',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await engineConfig.view(req.params.name as string));
    }),
  );

  router.put(
    '/profiles/:name/engine-config',
    validateParams(profileNameSchema),
    validateBody(engineConfigBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as EngineConfigBody;
      const profile = await engineConfig.apply(
        req.params.name as string,
        body.config,
      );
      res.status(202).json(profile);
    }),
  );

  router.delete(
    '/profiles/:name/engine-config',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const profile = await engineConfig.reset(req.params.name as string);
      res.status(202).json(profile);
    }),
  );

  return router;
}
