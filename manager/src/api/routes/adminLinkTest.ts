import { Request, Response, Router } from 'express';

import type { AdminLinkTester } from '../../domain/adminLink/AdminLinkTester.js';
import { type TestAdminLinkBody, testAdminLinkSchema } from '../../schemas/managerSettings.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBodyRefusingUnknown, validateParams } from '../middleware/validate.js';

/**
 * Test connection: whether a web2 admin answers the address and token the
 * stream uploader would be given, asked from where the manager runs.
 *
 * Two routes. One tests an address typed on the Manager settings page or in
 * the new-deployment wizard, with a typed token or the manager's stored one.
 * The other tests what a deployment's next deploy would give its uploader,
 * whose token never leaves the manager. Both answer an outcome code and
 * nothing the admin said, and sit behind the session like every router here.
 * A POST, because each one reaches out to another service.
 */
export function createAdminLinkTestRouter(tester: AdminLinkTester): Router {
  const router = Router();

  router.post(
    '/manager-settings/admin-link/test',
    validateBodyRefusingUnknown(testAdminLinkSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const body = req.body as TestAdminLinkBody;
      const answer = await tester.testTyped(
        { url: body.url as string, token: body.token as NonNullable<TestAdminLinkBody['token']>, feedOwner: body.feedOwner ?? null },
        username,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  router.post(
    '/profiles/:name/settings/admin-link/test',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { username } = signedInUser(req);
      const answer = await tester.testDeployment(req.params.name as string, username);
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    }),
  );

  return router;
}
