import { Request, Response, Router } from 'express';

import type { DeploymentSettingEdit } from '@streaming-infra-manager/common';

import type { DeploymentSettingsService } from '../../domain/settings/DeploymentSettingsService.js';
import {
  type ApplyDeploymentSettingsBody,
  applyDeploymentSettingsSchema,
  type SaveDeploymentSettingsBody,
  saveDeploymentSettingsSchema,
} from '../../schemas/deploymentSettings.js';
import { newDeploymentShapeQuerySchema, profileNameSchema, servicesOfList } from '../../schemas/profile.js';
import { versionIdSchema } from '../../schemas/version.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/**
 * A deployment's own stack settings: the list, a save, and Apply, and the list
 * the new-deployment wizard edits before the deployment exists.
 *
 * Mounted after the session gate like every other router here. No list ever
 * carries a secret's value, only that one is stored or set, and none is
 * cached, because a deployment's names what its running containers are behind
 * on and a version's follows its current build.
 */
export function createDeploymentSettingsRouter(settings: DeploymentSettingsService): Router {
  const router = Router();

  router.get(
    '/versions/:id/settings-catalog',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const shape = await newDeploymentShapeQuerySchema.validate(req.query, { abortEarly: false, stripUnknown: true });
      const components = servicesOfList(shape.components);
      const catalog = await settings.newDeploymentCatalog(Number.parseInt(req.params.id as string, 10), {
        kind: shape.kind,
        components: components.length > 0 ? components : null,
        host: shape.host ?? null,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(catalog);
    }),
  );

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
