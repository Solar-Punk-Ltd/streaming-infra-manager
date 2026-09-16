/**
 * Where a deployment's SRT passphrase goes, and where it must not.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The passphrase encrypts the ingest an operator publishes into, so whoever
 * holds it can publish into that deployment. It travelled as a column of the
 * shared profile SELECT list, which meant every profile read and every
 * `profile.changed` event handed every deployment's passphrase to every
 * signed-in page, admin or not, whether or not anybody was about to publish.
 *
 * Unlike the signing key it has a reader that has to see it: the page builds
 * the broadcaster's SRT URL with the passphrase in its query. So the row says
 * only whether one is stored, and a page that is about to show or copy a URL
 * asks for that one deployment's passphrase through a route of its own, which
 * writes a line naming who asked and for which deployment.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import { createSrtPassphraseRouter } from '../../src/api/routes/srtPassphrase.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';
import { call, startRouterTestApp } from '../support/routerTestApp.js';

const PASS = 'stage-passphrase-1';
const OTHER = 'stage-passphrase-2';

/** What `requireSession` puts on a request, which is all these routes read of it. */
function sessionFor(username: string): SessionInfo {
  return {
    user: { id: 1, username, isAdmin: false },
    tokenHash: 'not-a-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/**
 * The routers as `api/server.ts` mounts them, with or without a session in
 * front. `server.ts` puts `requireSession` above both, and serverGateOrder
 * holds it there; what this decides is what the reveal route does when it is
 * reached without one.
 */
function mounted(routers: Router[], signedInAs: string | null): Router {
  const outer = Router();
  if (signedInAs !== null) {
    const session = sessionFor(signedInAs);
    outer.use((req, _res, next) => {
      req.authSession = session;
      req.user = session.user;
      next();
    });
  }
  for (const router of routers) outer.use(router);
  return outer;
}

describe('what a page is told about a deployment that holds an SRT passphrase', () => {
  it('hears that there is one, and never hears the passphrase', async () => {
    const harness = profileServiceHarness([]);
    const published: unknown[] = [];
    harness.events.subscribe((event) => {
      if (event.type === 'profile.changed') published.push(event.profile);
    });
    const app = await startRouterTestApp(
      mounted([createProfilesRouter(harness.service)], 'operator'),
      '/profiles',
    );

    try {
      const created = await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });
      assert.equal(created.status, 202, JSON.stringify(created.body));

      const list = await call(app, 'GET', '/profiles');
      const one = await call(app, 'GET', '/profiles/stage');

      const answers: [string, unknown][] = [
        ['POST /profiles', created.body],
        ['GET /profiles', list.body],
        ['GET /profiles/stage', one.body],
        ['the profile.changed events', published],
      ];
      for (const [door, body] of answers) {
        assert.ok(
          !JSON.stringify(body).includes(PASS),
          `${door} carried the SRT passphrase`,
        );
      }

      const profile = one.body as { has_srt_passphrase: boolean };
      assert.equal(
        profile.has_srt_passphrase,
        true,
        'the page is told a passphrase is stored',
      );
    } finally {
      await app.close();
    }
  });

  it('keeps the stored passphrase when a save leaves it out', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted([createProfilesRouter(harness.service)], 'operator'),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });

      const saved = await call(app, 'PUT', '/profiles/stage', {
        kind: 'streamer',
        notes: 'a note, and nothing about the passphrase',
      });

      assert.equal(saved.status, 202, JSON.stringify(saved.body));
      assert.equal(
        (saved.body as { has_srt_passphrase: boolean }).has_srt_passphrase,
        true,
        'a save that says nothing about the passphrase must not clear it',
      );
      assert.equal(await harness.profiles.srtPassphraseOf('stage'), PASS);
    } finally {
      await app.close();
    }
  });

  it('puts the deployment back on the host-wide one when the save says null', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted([createProfilesRouter(harness.service)], 'operator'),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });

      const saved = await call(app, 'PUT', '/profiles/stage', {
        kind: 'streamer',
        srt_passphrase: null,
      });

      assert.equal(saved.status, 202, JSON.stringify(saved.body));
      assert.equal(
        (saved.body as { has_srt_passphrase: boolean }).has_srt_passphrase,
        false,
        'an explicit null is the operator choosing the host-wide passphrase',
      );
      assert.equal(await harness.profiles.srtPassphraseOf('stage'), null);
    } finally {
      await app.close();
    }
  });

  it('replaces the stored passphrase when a save names another', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted([createProfilesRouter(harness.service)], 'operator'),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });

      const saved = await call(app, 'PUT', '/profiles/stage', {
        kind: 'streamer',
        srt_passphrase: OTHER,
      });

      assert.equal(saved.status, 202, JSON.stringify(saved.body));
      assert.equal(await harness.profiles.srtPassphraseOf('stage'), OTHER);
    } finally {
      await app.close();
    }
  });
});

describe('GET /profiles/:name/srt-passphrase', () => {
  it('answers the passphrase of the one deployment asked for', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted(
        [
          createProfilesRouter(harness.service),
          createSrtPassphraseRouter(harness.service),
        ],
        'operator',
      ),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });
      await call(app, 'POST', '/profiles', {
        name: 'spare',
        kind: 'streamer',
        srt_passphrase: OTHER,
      });

      const revealed = await call(app, 'GET', '/profiles/stage/srt-passphrase');

      assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
      assert.deepEqual(revealed.body, { srt_passphrase: PASS });
    } finally {
      await app.close();
    }
  });

  it('answers null for a deployment that is on the host-wide passphrase', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted(
        [
          createProfilesRouter(harness.service),
          createSrtPassphraseRouter(harness.service),
        ],
        'operator',
      ),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', { name: 'stage', kind: 'streamer' });

      const revealed = await call(app, 'GET', '/profiles/stage/srt-passphrase');

      assert.equal(revealed.status, 200, JSON.stringify(revealed.body));
      assert.deepEqual(revealed.body, { srt_passphrase: null });
    } finally {
      await app.close();
    }
  });

  it('refuses a request that carries no session, without reading anything', async () => {
    const harness = profileServiceHarness([]);
    const signedIn = await startRouterTestApp(
      mounted([createProfilesRouter(harness.service)], 'operator'),
      '/profiles',
    );
    try {
      await call(signedIn, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });
    } finally {
      await signedIn.close();
    }

    const open = await startRouterTestApp(
      mounted([createSrtPassphraseRouter(harness.service)], null),
      '/profiles',
    );

    try {
      const refused = await call(open, 'GET', '/profiles/stage/srt-passphrase');

      assert.equal(refused.status, 401, JSON.stringify(refused.body));
      assert.ok(
        !JSON.stringify(refused.body).includes(PASS),
        'a refusal must not carry the value it refused',
      );
    } finally {
      await open.close();
    }
  });

  it('is never cached, so a revoked reader cannot read it from a store', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted(
        [
          createProfilesRouter(harness.service),
          createSrtPassphraseRouter(harness.service),
        ],
        'operator',
      ),
      '/profiles',
    );

    try {
      await call(app, 'POST', '/profiles', {
        name: 'stage',
        kind: 'streamer',
        srt_passphrase: PASS,
      });

      const res = await fetch(`${app.url}/profiles/stage/srt-passphrase`);

      assert.equal(res.headers.get('cache-control'), 'no-store');
      await res.text();
    } finally {
      await app.close();
    }
  });

  it('answers 404 for a deployment that does not exist', async () => {
    const harness = profileServiceHarness([]);
    const app = await startRouterTestApp(
      mounted([createSrtPassphraseRouter(harness.service)], 'operator'),
      '/profiles',
    );

    try {
      const missing = await call(app, 'GET', '/profiles/ghost/srt-passphrase');

      assert.equal(missing.status, 404, JSON.stringify(missing.body));
    } finally {
      await app.close();
    }
  });
});
