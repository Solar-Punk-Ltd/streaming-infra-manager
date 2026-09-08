import { Router } from 'express';
import { ChequebookAccountChangedError } from '../../domain/errors/ChequebookAccountChangedError.js';
import type { ChequebookService } from '../../domain/ChequebookService.js';
import type { ChequebookOperationsService } from '../../domain/chequebook/ChequebookOperationsService.js';
import { assertChequebookSchema, checkChequebookSchema, chequebookHistoryQuery, resolveChequebookSchema, submitChequebookSchema,
  type AssertChequebookBody, type CheckChequebookBody, type ResolveChequebookBody, type SubmitChequebookBody } from '../../schemas/chequebookOperations.js';
import { profileNameSchema } from '../../schemas/profile.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInUser } from '../middleware/requireSession.js';
import { validateBody, validateParams } from '../middleware/validate.js';

/** Mounted behind the session and same-site gates. Accepted submission is not verified settlement. */
export function createChequebookRouter(chequebookService: ChequebookService, operations: ChequebookOperationsService): Router {
  const router = Router();
  router.get('/profiles/:name/chequebook', validateParams(profileNameSchema), asyncHandler(async (req, res) => {
    res.json(await chequebookService.summary(req.params.name as string));
  }));
  for (const direction of ['deposit', 'withdraw'] as const) {
    router.post(`/profiles/:name/chequebook/${direction}`, validateParams(profileNameSchema), validateBody(submitChequebookSchema), asyncHandler(async (req, res) => {
      const body = req.body as SubmitChequebookBody;
      const user = signedInUser(req);
      if (body.expectedAccountId !== user.id) throw new ChequebookAccountChangedError();
      const result = await operations.submit({ requestId: body.requestId, profileInstanceId: body.profileInstanceId, amountPlur: body.amount, direction,
        profileName: req.params.name as string, requestedBy: `user:${user.id}` });
      res.status(result.kind === 'busy' || result.kind === 'conflict' ? 409 : 202).json(result);
    }));
  }
  router.get('/chequebook/operations', asyncHandler(async (req, res) => {
    res.json(await operations.history(chequebookHistoryQuery(req.query)));
  }));
  router.get('/chequebook/operations/by-request/:requestId', asyncHandler(async (req, res) => {
    res.json(await operations.byRequestId(req.params.requestId as string));
  }));
  router.get('/chequebook/operations/:id', asyncHandler(async (req, res) => {
    res.json(await operations.detail(req.params.id as string));
  }));
  router.post('/chequebook/operations/:id/check', validateBody(checkChequebookSchema), asyncHandler(async (req, res) => {
    if ((req.body as CheckChequebookBody).expectedAccountId !== signedInUser(req).id) throw new ChequebookAccountChangedError('recovery');
    res.json(await operations.check(req.params.id as string));
  }));
  router.post('/chequebook/operations/:id/resolve', validateBody(resolveChequebookSchema), asyncHandler(async (req, res) => {
    const body = req.body as ResolveChequebookBody;
    if (body.expectedAccountId !== signedInUser(req).id) throw new ChequebookAccountChangedError('recovery');
    res.json(await operations.resolve(req.params.id as string, body.transactionHash));
  }));
  router.post('/chequebook/operations/:id/assert', validateBody(assertChequebookSchema), asyncHandler(async (req, res) => {
    const body = req.body as AssertChequebookBody;
    const user = signedInUser(req);
    if (body.expectedAccountId !== user.id) throw new ChequebookAccountChangedError('recovery');
    res.json(await operations.assertNoSubmission(req.params.id as string, { amountPlur: body.amountPlur, confirmation: body.confirmation, actor: `user:${user.id}` }, body.expectedRevision));
  }));
  return router;
}
