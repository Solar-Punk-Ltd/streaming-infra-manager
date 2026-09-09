import { Request, Response, Router } from 'express';

import type { StackSettingsSave } from '@streaming-infra-manager/common';

import { StackVersionService } from '../../domain/versions/StackVersionService.js';
import {
  CreateVersionBody,
  PatchVersionBody,
  createVersionSchema,
  patchVersionSchema,
  saveVersionSettingsSchema,
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

  // The values come back in the clear, secrets included: the page is behind
  // the session gate, the operator is the only reader, and a value they cannot
  // see is one they cannot check. Never logged, here or anywhere below.
  router.get(
    '/:id/settings',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await versions.settingsOf(versionIdOf(req)));
    }),
  );

  router.put(
    '/:id/settings',
    validateParams(versionIdSchema),
    validateBody(saveVersionSettingsSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await versions.saveSettings(versionIdOf(req), req.body as StackSettingsSave));
    }),
  );

  // Publishes another build of the same commit rather than fetching and
  // building the stack again, so a changed line is minutes cheaper. Under the
  // build mutex, because what comes out of it is a build like any other.
  router.post(
    '/:id/settings/apply',
    validateParams(versionIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await versions.applySettings(versionIdOf(req)));
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
