import { Request, Response, Router } from 'express';

import { ProfileService } from '../../domain/ProfileService.js';
import {
  CreateProfileInput,
  UpdateProfileInput,
  createProfileSchema,
  profileNameSchema,
  updateProfileSchema,
} from '../../schemas/profile.js';
import { ProfileKind } from '../../types/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

export function createProfilesRouter(profileService: ProfileService): Router {
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
        srt_passphrase: body.srt_passphrase,
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

  router.put(
    '/:name',
    validateParams(profileNameSchema),
    validateBody(updateProfileSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as UpdateProfileInput;
      const profile = await profileService.update(req.params.name as string, {
        notes: body.notes,
        feed_owner: body.feed_owner,
        feed_topic: body.feed_topic,
        private_key: body.private_key,
        public_key: body.public_key,
        stamp_id: body.stamp_id,
        bee_publishers: body.bee_publishers,
        bee_url: body.bee_url,
        srt_passphrase: body.srt_passphrase,
      });
      res.status(202).json(profile);
    }),
  );

  router.delete(
    '/:name',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const profile = await profileService.remove(req.params.name as string);
      res.status(202).json(profile);
    }),
  );

  return router;
}
