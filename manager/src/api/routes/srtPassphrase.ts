import { Request, Response, Router } from 'express';

import { Logger } from '../../domain/Logger.js';
import { ProfileService } from '../../domain/ProfileService.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateParams } from '../middleware/validate.js';

const logger = Logger.getInstance();

/**
 * One deployment's SRT passphrase, on request.
 *
 * The passphrase encrypts the ingest an operator publishes into, and it used
 * to ride on the profile row, which handed every deployment's to every
 * signed-in page on every list and every status change. It has a reader the
 * other secrets do not, though: the page builds the broadcaster's SRT URL with
 * the passphrase in its query, so it cannot simply stop being answered.
 *
 * This is the whole of that answer. One deployment at a time, asked for at the
 * moment an operator opens or copies the URL, never on a list and never on an
 * event, never cached, and each reveal leaves a line saying who asked for
 * which deployment.
 *
 * A router of its own rather than another route on the profiles one, so that
 * the one door the value leaves by is a file somebody can read whole.
 */
export function createSrtPassphraseRouter(
  profileService: ProfileService,
): Router {
  const router = Router();

  router.get(
    '/:name/srt-passphrase',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      // Before the read, so a request that arrived without a session is
      // refused rather than answered and then logged.
      const { username } = signedInUser(req);
      const name = req.params.name as string;
      const passphrase = await profileService.srtPassphraseOf(name);

      logger.info(`[SrtPassphrase] ${username} read the SRT passphrase of ${name}`);
      res.set('Cache-Control', 'no-store').json({ srt_passphrase: passphrase });
    }),
  );

  return router;
}
