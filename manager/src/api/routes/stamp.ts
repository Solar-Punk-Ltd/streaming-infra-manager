import { Request, Response, Router } from 'express';

import { StampService } from '../../domain/StampService.js';
import { profileNameSchema } from '../../schemas/profile.js';
import {
  BuyStampBody,
  SetStampBody,
  buyStampSchema,
  setStampSchema,
} from '../../schemas/stamp.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/**
 * Postage-stamp management against a profile's bee-uploader node. Read endpoints
 * proxy the bee HTTP API; buy creates a batch; set persists a stamp id on the
 * profile (no redeploy — the "deploy uploader" action brings the uploader up).
 */
export function createStampRouter(stampService: StampService): Router {
  const router = Router();

  router.get(
    '/profiles/:name/stamp/address',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const address = await stampService.getAddress(req.params.name as string);
      res.json(address);
    }),
  );

  router.get(
    '/profiles/:name/stamp/wallet',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const wallet = await stampService.getWallet(req.params.name as string);
      res.json(wallet);
    }),
  );

  router.get(
    '/profiles/:name/stamp/chainstate',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const chainState = await stampService.getChainState(
        req.params.name as string,
      );
      res.json(chainState);
    }),
  );

  router.get(
    '/profiles/:name/stamp/stamps',
    validateParams(profileNameSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const stamps = await stampService.listStamps(req.params.name as string);
      res.json({ stamps });
    }),
  );

  router.post(
    '/profiles/:name/stamp/buy',
    validateParams(profileNameSchema),
    validateBody(buyStampSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as BuyStampBody;
      const result = await stampService.buyStamp(req.params.name as string, {
        amount: body.amount,
        depth: body.depth,
        label: body.label ?? undefined,
        immutable: body.immutable ?? undefined,
      });
      res.status(202).json(result);
    }),
  );

  router.post(
    '/profiles/:name/stamp/set',
    validateParams(profileNameSchema),
    validateBody(setStampSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as SetStampBody;
      const profile = await stampService.setStamp(
        req.params.name as string,
        body.stamp_id,
      );
      res.json(profile);
    }),
  );

  return router;
}
