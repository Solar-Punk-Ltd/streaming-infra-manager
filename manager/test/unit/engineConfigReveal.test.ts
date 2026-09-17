/**
 * Who read a deployment's effective engine config, and what happens when
 * nobody signed in asks.
 *
 * Unit test: the engine router on a random port, the profile service in memory,
 * a scratch stack root standing in for the deploy server's. `pnpm test` in
 * manager/.
 *
 * The generated config carries the SRT passphrase in clear, because the
 * engine's entrypoint splices it into the file. It is therefore the second door
 * that value leaves by, beside `GET /profiles/:name/srt-passphrase`, and the
 * two now answer the same two questions the same way: the user is read before
 * anything else, so a request without a session is refused rather than answered
 * and then recorded, and a reveal leaves a line naming who asked for which
 * deployment.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { ContainerControl } from '../../src/domain/ContainerControl.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('engine-config-reveal-');
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { createEngineRouter } = await import('../../src/api/routes/engine.js');
const { harnessFor, profileRow } = await import(
  '../support/profileServiceHarness.js'
);
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const CONFIG = 'listen 1935;\nsrt_passphrase stage-passphrase-1;\n';

/** What `requireSession` puts on a request, which is all this route reads of it. */
function sessionFor(username: string): SessionInfo {
  return {
    user: { id: 1, username, isAdmin: false },
    tokenHash: 'not-a-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/** Counts the reads, so a refusal that still read the file is visible. */
function recordingContainers(reads: string[]): ContainerControl {
  return {
    effectiveConfig: async (name: string) => {
      reads.push(name);
      return CONFIG;
    },
  } as unknown as ContainerControl;
}

/** The router as `api/server.ts` mounts it, with or without a session in front. */
async function appFor(signedInAs: string | null, reads: string[]) {
  const harness = harnessFor(profileRow({ name: 'stage', kind: 'streamer' }));
  const outer = Router();
  if (signedInAs !== null) {
    const session = sessionFor(signedInAs);
    outer.use((req, _res, next) => {
      req.authSession = session;
      req.user = session.user;
      next();
    });
  }
  outer.use(createEngineRouter(harness.service, recordingContainers(reads), null));
  return startRouterTestApp(outer);
}

describe('GET /profiles/:name/engine/config', () => {
  it('answers the effective config to the operator who asked', async () => {
    const reads: string[] = [];
    const app = await appFor('operator', reads);

    try {
      const answered = await call(app, 'GET', '/profiles/stage/engine/config');

      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal(answered.body, CONFIG);
      assert.deepEqual(reads, ['stage']);
    } finally {
      await app.close();
    }
  });

  it('refuses a request that carries no session, without reading anything', async () => {
    const reads: string[] = [];
    const app = await appFor(null, reads);

    try {
      const refused = await call(app, 'GET', '/profiles/stage/engine/config');

      assert.equal(refused.status, 401, JSON.stringify(refused.body));
      assert.deepEqual(reads, [], 'a refusal must not have read the config');
      assert.ok(
        !JSON.stringify(refused.body).includes('passphrase'),
        'a refusal must not carry what it refused',
      );
    } finally {
      await app.close();
    }
  });
});
