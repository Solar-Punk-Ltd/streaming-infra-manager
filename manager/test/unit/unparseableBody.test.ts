/**
 * A request body that is not JSON is refused as the client's mistake, and
 * nothing of it reaches the answer or the manager's log. The JSON parser's
 * own message quotes the body around the point it failed, which is where a
 * hand-made body carries its password or token.
 *
 * Unit test, no database. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Router } from 'express';

import { startRouterTestApp } from '../support/routerTestApp.js';

const SYNTHETIC = 'SYNTHETIC-probe-0123456789';
const LOG_METHODS = ['log', 'info', 'warn', 'error'] as const;

describe('a request body that is not JSON', () => {
  it('is refused with 400, and neither the answer nor the log quotes it', async (t) => {
    const logged: unknown[][] = [];
    for (const method of LOG_METHODS) t.mock.method(console, method, (...args: unknown[]) => logged.push(args));
    const router = Router();
    router.post('/anything', (_req, res) => {
      res.json({ reached: true });
    });
    const app = await startRouterTestApp(router);
    try {
      const response = await fetch(`${app.url}/anything`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"name":"stage","value":${SYNTHETIC}}`,
      });
      const text = await response.text();

      assert.equal(response.status, 400);
      assert.equal((JSON.parse(text) as { error: string }).error, 'validation_error');
      assert.equal(text.includes('SYNTHETIC'), false, 'the answer quotes the body');
      assert.equal(JSON.stringify(logged).includes('SYNTHETIC'), false, 'the log quotes the body');
    } finally {
      await app.close();
    }
  });
});
