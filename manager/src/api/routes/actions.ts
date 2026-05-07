import { Request, Response, Router } from 'express';

import { DeployService } from '../../domain/DeployService.js';
import {
  cleanBodySchema,
  CleanBody,
  deployBodySchema,
  DeployBody,
  stopBodySchema,
  StopBody,
} from '../../schemas/action.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { ALL_SERVICES, ActionKind } from '../../types.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { pipeRunHandleToSSE } from '../sse.js';

/**
 * Profile-scoped actions: deploy / stop / clean / health.
 * All four stream their script's output back as SSE.
 */
export function createActionsRouter(deployService: DeployService): Router {
  const router = Router();

  const runAction = async (
    req: Request,
    res: Response,
    action: ActionKind,
    input: { services?: string[]; volumes?: boolean; all?: boolean } = {},
  ) => {
    const profileName = req.params.name as string;
    const handle = await deployService.run(profileName, action, input);
    pipeRunHandleToSSE(res, handle, {
      script: `${action}.sh`,
      args: [`--profile=${profileName}`, ...(input.services ?? [])],
    });
  };

  router.post(
    '/profiles/:name/deploy',
    validateParams(profileNameSchema),
    validateBody(deployBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as DeployBody;
      await runAction(req, res, 'deploy', {
        services: body.services as string[] | undefined,
      });
    }),
  );

  router.post(
    '/profiles/:name/stop',
    validateParams(profileNameSchema),
    validateBody(stopBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as StopBody;
      await runAction(req, res, 'stop', {
        services: body.services as string[] | undefined,
      });
    }),
  );

  router.post(
    '/profiles/:name/clean',
    validateParams(profileNameSchema),
    validateBody(cleanBodySchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CleanBody;
      await runAction(req, res, 'clean', {
        services: body.services as string[] | undefined,
        volumes: body.volumes ?? undefined,
        all: body.all ?? undefined,
      });
    }),
  );

  router.get(
    '/profiles/:name/health',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await runAction(req, res, 'health');
    }),
  );

  /** GET /services — handy for clients that want the canonical list. */
  router.get('/services', (_req: Request, res: Response) => {
    res.json({ services: [...ALL_SERVICES] });
  });

  return router;
}
