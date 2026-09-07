/**
 * The blocked deploy attempts, as the Versions page reads them, and the
 * typed release that ends one.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/. The
 * orchestrator is stood in for: what is under test is which route reaches
 * which call, what the release requires typed, and the statuses.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAttemptsRouter } from '../../src/api/routes/attempts.js';
import type { DeploymentOrchestrator } from '../../src/domain/DeploymentOrchestrator.js';
import type { DeployAttempt } from '../../src/domain/deployAttempts.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';

const BLOCKED: DeployAttempt = {
  id: 7,
  daemonId: 'daemon-1',
  project: 'stage',
  jobId: 'job-abc123',
  kind: 'shared',
  services: ['srs', 'stream-uploader'],
  preJobContainerIds: ['c1'],
  state: 'blocked',
  reason: 'stream-uploader of stage was never seen with a container created by attempt job-abc123.',
  startedAt: new Date(0),
  resolvedAt: new Date(1),
  releasedBy: null,
};

const released: { id: number; by: string }[] = [];

const orchestrator = {
  async unresolvedAttempts() {
    return [BLOCKED];
  },
  async releaseAttempt(id: number, by: string) {
    if (id !== BLOCKED.id) return null;
    released.push({ id, by });
    return { ...BLOCKED, state: 'released', releasedBy: by };
  },
} as unknown as DeploymentOrchestrator;

let app: RouterTestApp;

before(async () => {
  app = await startRouterTestApp(createAttemptsRouter(orchestrator, () => 'levi'));
});

after(() => app.close());

describe('GET /', () => {
  it('lists the unresolved attempts with their reason, and nothing a page cannot use', async () => {
    const res = await call(app, 'GET', '/');

    assert.equal(res.status, 200);
    const body = res.body as { attempts: Record<string, unknown>[] };
    assert.equal(body.attempts.length, 1);
    assert.equal(body.attempts[0]?.jobId, 'job-abc123');
    assert.equal(body.attempts[0]?.state, 'blocked');
    assert.match(String(body.attempts[0]?.reason), /never seen/);
    assert.equal('preJobContainerIds' in (body.attempts[0] ?? {}), false, 'container ids stay in the manager');
  });
});

describe('POST /:id/release', () => {
  it('releases when the job id typed matches, recording who', async () => {
    const res = await call(app, 'POST', '/7/release', { jobId: 'job-abc123' });

    assert.equal(res.status, 200);
    assert.equal((res.body as { attempt: { state: string; releasedBy: string } }).attempt.state, 'released');
    assert.deepEqual(released, [{ id: 7, by: 'levi' }]);
  });

  it('refuses a job id that does not match, releasing nothing', async () => {
    const res = await call(app, 'POST', '/7/release', { jobId: 'job-other' });

    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /job id/i);
    assert.equal(released.length, 1);
  });

  it('answers 404 for an attempt that is not there', async () => {
    const res = await call(app, 'POST', '/99/release', { jobId: 'job-abc123' });

    assert.equal(res.status, 404);
  });

  it('refuses a body without the job id', async () => {
    const res = await call(app, 'POST', '/7/release', {});

    assert.equal(res.status, 400);
  });
});
