import { Request, Response, Router } from 'express';

import { StackVersionService } from '../../domain/versions/StackVersionService.js';
import {
  CreateVersionBody,
  PatchVersionBody,
  createVersionSchema,
  patchVersionSchema,
  versionIdSchema,
} from '../../schemas/version.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { pipeRunHandleToSSE } from '../sse.js';

const BUILD_SCRIPT_NAME = 'stack-version-build.sh';

function versionIdOf(req: Request): number {
  return Number.parseInt(req.params.id as string, 10);
}

/**
 * The versions of the streaming stack this manager holds.
 *
 * Adding and updating stream their build the way a deploy streams its script,
 * so the operator watches a clone and a `pnpm -r build` happen rather than
 * waiting on a spinner for several minutes. The stream is not killed when the
 * browser goes away: the build carries on and the row lands ready or failed
 * either way.
 */
export function createVersionsRouter(versions: StackVersionService): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await versions.list());
    }),
  );

  router.post(
    '/',
    validateBody(createVersionSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CreateVersionBody;
      const build = await versions.add(body.name, body.ref);
      pipeRunHandleToSSE(res, build.handle, {
        script: BUILD_SCRIPT_NAME,
        args: [build.version.name, build.version.gitRef],
      });
    }),
  );

  router.post(
    '/:id/update',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const build = await versions.update(versionIdOf(req));
      pipeRunHandleToSSE(res, build.handle, {
        script: BUILD_SCRIPT_NAME,
        args: [build.version.name, build.version.gitRef],
      });
    }),
  );

  router.post(
    '/:id/default',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await versions.setDefault(versionIdOf(req));
      res.status(204).end();
    }),
  );

  router.patch(
    '/:id',
    validateParams(versionIdSchema),
    validateBody(patchVersionSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as PatchVersionBody;
      res.json(
        await versions.setTested(versionIdOf(req), body.tested, body.commitSha ?? null, body.buildId ?? null),
      );
    }),
  );

  router.delete(
    '/:id',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await versions.remove(versionIdOf(req));
      res.status(204).end();
    }),
  );

  return router;
}
