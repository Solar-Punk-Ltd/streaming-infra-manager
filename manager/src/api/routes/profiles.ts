import { Request, Response, Router } from 'express';

import { ProfileService } from '../../domain/ProfileService.js';
import {
  CreateProfileInput,
  createProfileSchema,
  profileNameSchema,
} from '../../schemas/profile.js';
import { ProfileKind } from '../../types.js';
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
        notes: body.notes ?? null,
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
