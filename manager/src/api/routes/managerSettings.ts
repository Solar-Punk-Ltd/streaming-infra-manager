import { Request, Response, Router } from 'express';

import type { ManagerAdminLinkService } from '../../domain/adminLink/ManagerAdminLinkService.js';
import { type SaveManagerAdminLinkBody, saveManagerAdminLinkSchema } from '../../schemas/managerSettings.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBodyRefusingUnknown } from '../middleware/validate.js';

/**
 * The manager's own settings, which its Manager settings page edits: today
 * the web2 admin link every new uploader deployment starts with.
 *
 * Mounted after the session gate like every other router here. The token is
 * never answered, only whether one is stored, and the answer is never cached,
 * because another operator's save changes it.
 */
export function createManagerSettingsRouter(adminLink: ManagerAdminLinkService): Router {
  const router = Router();

  router.get(
    '/manager-settings/admin-link',
    asyncHandler(async (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await adminLink.read());
    }),
  );

  router.put(
    '/manager-settings/admin-link',
    validateBodyRefusingUnknown(saveManagerAdminLinkSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as SaveManagerAdminLinkBody;
      const saved = await adminLink.save(
        { expectedRevision: body.expectedRevision, url: body.url as string, ...(body.token !== undefined ? { token: body.token } : {}) },
        username,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(saved);
    }),
  );

  return router;
}
