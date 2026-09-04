import { Request, Response, Router } from 'express';

import { ProfileService } from '../../domain/ProfileService.js';
import {
  AddMembersInput,
  CreateGroupInput,
  UpdateGroupConfigInput,
  addMembersSchema,
  createGroupSchema,
  groupIdParamSchema,
  updateGroupConfigSchema,
} from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';
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
        abr_ladder: body.abr_ladder ?? undefined,
        feed_owner: body.feed_owner ?? undefined,
        feed_topic: body.feed_topic ?? undefined,
        private_key: body.private_key ?? undefined,
        public_key: body.public_key ?? undefined,
        stamp_id: body.stamp_id ?? undefined,
        srt_passphrase: body.srt_passphrase ?? undefined,
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

  // The deliverable of an ABR ladder: the BEE_PUBLISHERS value to paste into the
  // stream-uploader's env, wherever that runs.
  router.get(
    '/:id/bee-publishers',
    validateParams(groupIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const result = await profileService.beePublishersForGroup(
        parseInt(req.params.id as string, 10),
      );
      res.json(result);
    }),
  );

  router.patch(
    '/:id/config',
    validateParams(groupIdParamSchema),
    validateBody(updateGroupConfigSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as UpdateGroupConfigInput;
      const result = await profileService.updateGroupConfig(
        parseInt(req.params.id as string, 10),
        {
          notes: body.notes,
          feed_owner: body.feed_owner,
          feed_topic: body.feed_topic,
          stamp_id: body.stamp_id,
          srt_passphrase: body.srt_passphrase,
        },
      );
      res.status(202).json(result);
    }),
  );

  router.post(
    '/:id/members',
    validateParams(groupIdParamSchema),
    validateBody(addMembersSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as AddMembersInput;
      const result = await profileService.addGroupMembers(
        parseInt(req.params.id as string, 10),
        body.count,
      );
      res.status(202).json(result);
    }),
  );

  return router;
}
