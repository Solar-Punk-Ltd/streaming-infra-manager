/**
 * The body a refused deploy attempt answers with, as the page reads it.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/. The page
 * shows `errors`, then `message`, so a refusal whose reason sits in any
 * other field reaches the operator as its error code and nothing else.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Router } from 'express';

import { DeployAttemptRefusedError } from '../../src/domain/errors/index.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';

let app: RouterTestApp;

before(async () => {
  const router = Router();
  router.post('/deploy', (_req, _res, next) =>
    next(
      new DeployAttemptRefusedError(
        'stage',
        'stage has an unresolved deploy attempt, job-abc123 (still running).',
      ),
    ),
  );
  app = await startRouterTestApp(router);
});

after(() => app.close());

describe('a refused deploy attempt', () => {
  it('answers 409 with the reason where the page reads it', async () => {
    const res = await call(app, 'POST', '/deploy', {});

    assert.equal(res.status, 409);
    const body = res.body as { error: string; name: string; message?: string };
    assert.equal(body.error, 'deploy_attempt_refused');
    assert.equal(body.name, 'stage');
    assert.match(String(body.message), /unresolved deploy attempt/);
  });
});
