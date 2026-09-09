/**
 * What GET /config answers about the host, read from where the bundled stack
 * is rather than from a fixed path.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createConfigRouter } from '../../src/api/routes/config.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';

let app: RouterTestApp;
let passphrase: string | null = 'pass-one';

before(async () => {
  app = await startRouterTestApp(createConfigRouter('0.5', async () => passphrase));
});

after(() => app.close());

describe('GET /config', () => {
  it('answers the passphrase the bundled stack runs with, and the chequebook floor it was given', async () => {
    const res = await call(app, 'GET', '/');

    assert.equal(res.status, 200);
    const body = res.body as { srtPassphrase: string | null; chequebookFloorBzz: string };
    assert.equal(body.srtPassphrase, 'pass-one');
    assert.equal(body.chequebookFloorBzz, '0.5');
  });

  it('answers null when the bundled stack has no passphrase', async () => {
    passphrase = null;

    const res = await call(app, 'GET', '/');

    assert.equal((res.body as { srtPassphrase: string | null }).srtPassphrase, null);
  });
});
