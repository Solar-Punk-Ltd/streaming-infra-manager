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
  app = await startRouterTestApp(
    createConfigRouter('0.5', async () => passphrase, 'https://user:key@rpc.example.org:8545/v1/secret'),
  );
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

  it('answers the host of the manager’s RPC endpoint and nothing after it', async () => {
    // The wizard offers this endpoint first, so a page has to be able to say
    // which one it is. The URL itself may carry an API key in its userinfo or
    // its path, and this answer reaches every signed-in browser.
    const res = await call(app, 'GET', '/');

    const body = res.body as { beeRpcEndpoint: { configured: boolean; host: string | null } };
    assert.deepEqual(body.beeRpcEndpoint, { configured: true, host: 'rpc.example.org:8545' });
    assert.doesNotMatch(JSON.stringify(res.body), /secret|key/);
  });

  it('says the manager has none when it was given none', async () => {
    const bare = await startRouterTestApp(createConfigRouter('0.5', async () => null, null));
    try {
      const res = await call(bare, 'GET', '/');

      assert.deepEqual(
        (res.body as { beeRpcEndpoint: unknown }).beeRpcEndpoint,
        { configured: false, host: null },
      );
    } finally {
      bare.close();
    }
  });
});
