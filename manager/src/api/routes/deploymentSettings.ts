import { Request, Response, Router } from 'express';

import type { DeploymentSettingEdit } from '@streaming-infra-manager/common';

import type { DeploymentSettingsService } from '../../domain/settings/DeploymentSettingsService.js';
import {
  type ApplyDeploymentSettingsBody,
  applyDeploymentSettingsSchema,
  type SaveDeploymentSettingsBody,
  saveDeploymentSettingsSchema,
} from '../../schemas/deploymentSettings.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/**
 * A deployment's own stack settings: the list, a save, and Apply.
 *
 * Mounted after the session gate like every other router here. The list never
 * carries a secret's value, only that one is stored, and it is not cached,
 * because it names what the running containers are behind on.
 */
export function createDeploymentSettingsRouter(settings: DeploymentSettingsService): Router {
  const router = Router();

  router.get(
    '/profiles/:name/settings',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const catalog = await settings.catalog(req.params.name as string);
      res.setHeader('Cache-Control', 'no-store');
      res.json(catalog);
    }),
  );

  router.put(
    '/profiles/:name/settings',
    validateParams(profileNameSchema),
    validateBody(saveDeploymentSettingsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as SaveDeploymentSettingsBody;
      const saved = await settings.save(
        req.params.name as string,
        {
          expectedInstanceId: body.expectedInstanceId,
          expectedRevision: body.expectedRevision,
          entries: body.entries as DeploymentSettingEdit[],
        },
        username,
      );
      res.json(saved);
    }),
  );

  router.post(
    '/profiles/:name/settings/apply',
    validateParams(profileNameSchema),
    validateBody(applyDeploymentSettingsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as ApplyDeploymentSettingsBody;
      const applied = await settings.apply(req.params.name as string, body.expectedInstanceId, username);
      res.status(applied.recreated.length === 0 ? 200 : 202).json(applied);
    }),
  );

  return router;
}
