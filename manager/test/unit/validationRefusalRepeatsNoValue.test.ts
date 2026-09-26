/**
 * A request refused for a value of the wrong type never repeats that value.
 * yup's own message for it quotes the value whole, and a password, a token or
 * a key sent as a list or an object is exactly such a value. The refusal goes
 * back to whoever sent it, which is often a script or a session whose output
 * is kept.
 *
 * Unit test, no database. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Router } from 'express';
import { object, string } from 'yup';

import { validateBody } from '../../src/api/middleware/validate.js';
import { call, startRouterTestApp } from '../support/routerTestApp.js';

const SYNTHETIC = 'SYNTHETIC-probe-0123456789';

const passwordBodySchema = object({
  username: string().required(),
  password: string().required(),
}).noUnknown(true);

async function refusalOf(body: unknown): Promise<{ status: number; text: string }> {
  const router = Router();
  router.post('/sign-in', validateBody(passwordBodySchema), (_req, res) => {
    res.json({ reached: true });
  });
  const app = await startRouterTestApp(router);
  try {
    const answer = await call(app, 'POST', '/sign-in', body);
    return { status: answer.status, text: JSON.stringify(answer.body) };
  } finally {
    await app.close();
  }
}

describe('a value of the wrong type', () => {
  it('is refused with 400 without repeating a list or an object where text belongs', async () => {
    for (const password of [[SYNTHETIC], { value: SYNTHETIC }]) {
      const refused = await refusalOf({ username: 'levi', password });

      assert.equal(refused.status, 400);
      assert.equal(refused.text.includes('SYNTHETIC'), false, 'the refusal repeats the value');
      assert.match(refused.text, /password/, 'the refusal still names the field');
    }
  });

  it('is refused with 400 without repeating a list sent as the whole body', async () => {
    const refused = await refusalOf(['levi', SYNTHETIC]);

    assert.equal(refused.status, 400);
    assert.equal(refused.text.includes('SYNTHETIC'), false, 'the refusal repeats the value');
  });

  it('keeps a message a schema wrote itself', async () => {
    const refused = await refusalOf({ username: 'levi' });

    assert.equal(refused.status, 400);
    assert.match(refused.text, /password is a required field/);
  });
});
