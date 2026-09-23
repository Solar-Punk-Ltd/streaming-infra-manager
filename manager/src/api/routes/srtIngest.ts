import { Request, Response, Router } from 'express';

import { SrtIngestHealthService } from '../../domain/srtIngest/SrtIngestHealthService.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateParams } from '../middleware/validate.js';

/**
 * How one deployment's SRT ingest is holding up, from SRS's own statistics.
 *
 * One deployment at a time and never on a list, because every answer reads
 * the engine's log. The answer is numbers and a verdict. The log it was worked
 * out from never reaches this router.
 */
export function createSrtIngestRouter(srtIngest: SrtIngestHealthService): Router {
  const router = Router();

  router.get(
    '/:name/srt-ingest',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await srtIngest.read(req.params.name as string));
    }),
  );

  return router;
}
