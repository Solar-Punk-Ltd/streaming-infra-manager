import { Request, Response, Router } from 'express';

import { ContainerControl } from '../../domain/ContainerControl.js';
import { ProfileBusyError } from '../../domain/errors/index.js';
import { Logger } from '../../domain/Logger.js';
import { ProfileService } from '../../domain/ProfileService.js';
import {
  containerParamsSchema,
  type EngineSettingsBody,
  engineSettingsSchema,
  logsQuerySchema,
} from '../../schemas/engine.js';
import { definedSettingValues } from '../../schemas/engineSettingValues.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBody, validateParams } from '../middleware/validate.js';

const logger = Logger.getInstance();

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
        definedSettingValues(settings),
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
      // Before the read, so a request that arrived without a session is refused
      // rather than answered and then logged, as the reveal route does it.
      const { username } = signedInUser(req);
      const name = req.params.name as string;
      const { engine } = await profileService.engineOverview(name);
      const text = await containers.effectiveConfig(name, engine);
      // The generated config carries the SRT passphrase in clear, because the
      // engine's entrypoint splices it into the file. The profile row no
      // longer carries it, so this is the other door that value leaves by,
      // one deployment at a time and on request, and there is no reason for it
      // to sit in a browser or proxy cache. Both doors leave the same line, so
      // who read a passphrase is one search rather than two.
      logger.info(
        `[Engine] ${username} read the effective ${engine} config of ${name}, which carries its SRT passphrase`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.type(TEXT_PLAIN).send(text);
    }),
  );

  return router;
}
