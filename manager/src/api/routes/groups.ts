import { Request, Response, Router } from 'express';

import { ProfileService } from '../../domain/ProfileService.js';
import { CreateGroupInput, createGroupSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody } from '../middleware/validate.js';
import { ProfileKind } from '../../types/types.js';

export function createGroupsRouter(profileService: ProfileService): Router {
  const router = Router();

  router.post(
    '/',
    validateBody(createGroupSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CreateGroupInput;
      const result = await profileService.createGroup({
        group_name: body.group_name,
        size: body.size,
        kind: (body.kind ?? 'custom') as ProfileKind,
        notes: body.notes ?? null,
        host: body.host ?? undefined,
        components: body.components as string[] | undefined,
        feed_owner: body.feed_owner ?? undefined,
        feed_topic: body.feed_topic ?? undefined,
        private_key: body.private_key ?? undefined,
        public_key: body.public_key ?? undefined,
        stamp_id: body.stamp_id ?? undefined,
      });
      res.status(202).json(result);
    }),
  );

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      const groups = await profileService.listGroups();
      res.json({ groups });
    }),
  );

  return router;
}
