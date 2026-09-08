import { Request, Response, Router } from 'express';

import { ContainerControl } from '../../domain/ContainerControl.js';
import { ProfileBusyError } from '../../domain/errors/index.js';
import { ProfileService } from '../../domain/ProfileService.js';
import {
  containerParamsSchema,
  type EngineSettingsBody,
  engineSettingsSchema,
  logsQuerySchema,
} from '../../schemas/engine.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

const DEFAULT_LOG_LINES = 200;

const TEXT_PLAIN = 'text/plain; charset=utf-8';

/**
 * The media server of one deployment: what it is configured with, what it is
 * running, and the two things an operator does to it by hand.
 *
 * Mounted after the session gate like every other router here, so none of it is
 * reachable signed out.
 */
export function createEngineRouter(
  profileService: ProfileService,
  containers: ContainerControl,
): Router {
  const router = Router();

  router.get(
    '/profiles/:name/engine',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const overview = await profileService.engineOverview(req.params.name as string);
      res.json({ ...overview, live: null });
    }),
  );

  router.put(
    '/profiles/:name/engine-settings',
    validateParams(profileNameSchema),
    validateBody(engineSettingsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { expectedInstanceId, ...settings } = req.body as EngineSettingsBody;
      const profile = await profileService.updateEngineSettings(
        req.params.name as string,
        definedValues(settings),
        expectedInstanceId,
      );
      res.status(202).json(profile);
    }),
  );

  router.post(
    '/profiles/:name/containers/:service/restart',
    validateParams(containerParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const name = req.params.name as string;
      const service = req.params.service as string;
      // Confirms the deployment exists before the daemon is asked about it, so
      // a typo in the name answers "no such deployment" and not "no container".
      const profile = await profileService.getByName(name);
      // The same refusal saving settings gives: a deploy is already recreating
      // these containers, and a restart in the middle of one bounces a
      // container compose is about to replace anyway.
      if ((TRANSITIONAL_STATUSES as readonly string[]).includes(profile.status)) {
        throw new ProfileBusyError(name, profile.status);
      }
      await containers.restart(name, service);
      res.status(202).json({ status: 'accepted', name, service });
    }),
  );

  router.get(
    '/profiles/:name/containers/:service/logs',
    validateParams(containerParamsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { tail } = await logsQuerySchema.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
      });
      const name = req.params.name as string;
      await profileService.getByName(name);
      const text = await containers.logs(
        name,
        req.params.service as string,
        tail ?? DEFAULT_LOG_LINES,
      );
      res.type(TEXT_PLAIN).send(text);
    }),
  );

  router.get(
    '/profiles/:name/engine/config',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const name = req.params.name as string;
      const { engine } = await profileService.engineOverview(name);
      const text = await containers.effectiveConfig(name, engine);
      // The generated config carries the SRT passphrase in clear. The profile
      // JSON already does, so nothing new is exposed, but there is no reason
      // for it to sit in a browser or proxy cache.
      res.setHeader('Cache-Control', 'no-store');
      res.type(TEXT_PLAIN).send(text);
    }),
  );

  return router;
}

/**
 * Drops the keys yup left as `undefined`.
 *
 * The schema declares every known key so unknown ones are stripped, and yup
 * hands back the absent ones as `undefined`. Stored as they are, they would
 * become JSON nulls in the column and then values the engine tries to read.
 */
function definedValues(body: EngineSettingsBody): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') settings[key] = value;
  }
  return settings;
}
