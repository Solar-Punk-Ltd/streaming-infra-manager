import { Request, Response, Router } from 'express';

import { ChequebookService } from '../../domain/ChequebookService.js';
import { MoveBzzBody, moveBzzSchema } from '../../schemas/chequebook.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/**
 * The chequebook of a profile's own bee node: what it can still pay peers with,
 * and the two moves between the node's wallet and it.
 *
 * Both writes answer 202, because bee answers them once the transaction is
 * submitted rather than once it is mined. The balance moves a few seconds
 * later, which is what the caller polls the read endpoint for.
 */
export function createChequebookRouter(
  chequebookService: ChequebookService,
): Router {
  const router = Router();

  router.get(
    '/profiles/:name/chequebook',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const summary = await chequebookService.summary(
        req.params.name as string,
      );
      res.json(summary);
    }),
  );

  router.post(
    '/profiles/:name/chequebook/deposit',
    validateParams(profileNameSchema),
    validateBody(moveBzzSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as MoveBzzBody;
      const result = await chequebookService.deposit(
        req.params.name as string,
        BigInt(body.amount),
      );
      res.status(202).json(result);
    }),
  );

  router.post(
    '/profiles/:name/chequebook/withdraw',
    validateParams(profileNameSchema),
    validateBody(moveBzzSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as MoveBzzBody;
      const result = await chequebookService.withdraw(
        req.params.name as string,
        BigInt(body.amount),
      );
      res.status(202).json(result);
    }),
  );

  return router;
}
