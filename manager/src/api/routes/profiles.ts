import { Request, Response, Router } from 'express';

import { ProfileService } from '../../domain/ProfileService.js';
import { UploaderHealthService } from '../../domain/UploaderHealthService.js';
import { definedSettingValues } from '../../schemas/engineSettingValues.js';
import {
  CreateProfileInput,
  UpdateNotesInput,
  UpdateProfileInput,
  RemoveProfileInput,
  createProfileSchema,
  profileNameSchema,
  updateNotesSchema,
  updateProfileSchema,
  removeProfileSchema,
} from '../../schemas/profile.js';
import { ProfileKind } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export function createProfilesRouter(
  profileService: ProfileService,
  uploaderHealth: UploaderHealthService,
): Router {
  const router = Router();

  router.post(
    '/',
    validateBody(createProfileSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CreateProfileInput;
      const profile = await profileService.create({
        name: body.name,
        kind: (body.kind ?? 'custom') as ProfileKind,
        notes: body.notes,
        host: body.host,
        components: body.components as string[] | undefined,
        feed_owner: body.feed_owner,
        feed_topic: body.feed_topic,
        private_key: body.private_key,
        public_key: body.public_key,
        stamp_id: body.stamp_id,
        bee_publishers: body.bee_publishers,
        bee_url: body.bee_url,
        rpc_endpoint: body.rpc_endpoint,
        srt_passphrase: body.srt_passphrase,
        stack_version_id: body.stack_version_id,
        engine_settings:
          body.engine_settings && definedSettingValues(body.engine_settings),
      });
      res.status(202).json(profile);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const profiles = await profileService.list();
      res.json({ profiles });
    }),
  );

  router.get(
    '/:name',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const profile = await profileService.getByName(req.params.name as string);
      res.json(profile);
    }),
  );

  // What this deployment's own stream-uploader says about itself, the Bee node
  // it may still be waiting for included. One deployment at a time and never on
  // a list, because a list would have to ask every uploader in turn.
  router.get(
    '/:name/uploader-health',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await uploaderHealth.read(req.params.name as string));
    }),
  );

  router.put(
    '/:name',
    validateParams(profileNameSchema),
    validateBody(updateProfileSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as UpdateProfileInput;
      const profile = await profileService.update(req.params.name as string, {
        notes: body.notes,
        notes_revision: body.notes_revision ?? undefined,
        feed_owner: body.feed_owner,
        feed_topic: body.feed_topic,
        private_key: body.private_key,
        public_key: body.public_key,
        stamp_id: body.stamp_id,
        bee_publishers: body.bee_publishers,
        bee_url: body.bee_url,
        rpc_endpoint: body.rpc_endpoint,
        srt_passphrase: body.srt_passphrase,
      });
      res.status(202).json(profile);
    }),
  );

  // The notes alone: no claim, no gate, no deploy, so 200 and not 202.
  router.patch(
    '/:name/notes',
    validateParams(profileNameSchema),
    validateBody(updateNotesSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as UpdateNotesInput;
      const profile = await profileService.updateNotes(
        req.params.name as string,
        body.notes,
        body.notes_revision,
      );
      res.json(profile);
    }),
  );

  router.delete(
    '/:name',
    validateParams(profileNameSchema),
    validateBody(removeProfileSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const profile = await profileService.remove(req.params.name as string, req.body as RemoveProfileInput);
      res.status(202).json(profile);
    }),
  );

  return router;
}
