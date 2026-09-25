/**
 * The two routes that change a batch a deployment's node holds, from the
 * request body to the service and back.
 *
 * Unit test, no database and no node: the service is a recorder, so nothing
 * reaches a Bee and no money moves. `pnpm test` in manager/.
 *
 * The session gate in front of these is the one in front of every stamp route,
 * because they are mounted on the same router, and serverGateOrder.test.ts
 * holds that router below the gate.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createStampRouter } from '../../src/api/routes/stamp.js';
import type { StampService } from '../../src/domain/StampService.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';

const BATCH = 'a'.repeat(64);
const TX = `0x${'b'.repeat(64)}`;

/** What each route handed the service, and nothing else. */
class RecordingStampService {
  readonly topUps: unknown[][] = [];

  readonly dilutes: unknown[][] = [];

  asService(): StampService {
    return this as unknown as StampService;
  }

  async topUpStamp(...args: unknown[]) {
    this.topUps.push(args);
    return { batchID: BATCH, txHash: TX };
  }

  async diluteStamp(...args: unknown[]) {
    this.dilutes.push(args);
    return { batchID: BATCH, txHash: TX };
  }
}

const service = new RecordingStampService();
let app: RouterTestApp;

before(async () => {
  app = await startRouterTestApp(createStampRouter(service.asService()));
});

after(() => app.close());

describe('POST /profiles/:name/stamp/topup', () => {
  const path = '/profiles/stage/stamp/topup';

  it('hands the batch and the amount to the service, and answers 202 with the transaction', async () => {
    const res = await call(app, 'POST', path, { batch_id: `0x${BATCH}`, amount: '1571927040' });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { batchID: BATCH, txHash: TX });
    assert.deepEqual(service.topUps.at(-1), ['stage', `0x${BATCH}`, '1571927040']);
  });

  it('refuses a body without a 32-byte hex batch id or a positive whole amount, before the service', async () => {
    const before = service.topUps.length;
    for (const body of [
      {},
      { amount: '1571927040' },
      { batch_id: 'a'.repeat(63), amount: '1571927040' },
      { batch_id: 'z'.repeat(64), amount: '1571927040' },
      { batch_id: BATCH },
      { batch_id: BATCH, amount: '0' },
      { batch_id: BATCH, amount: '01' },
      { batch_id: BATCH, amount: '1.5' },
      { batch_id: BATCH, amount: '-1' },
      { batch_id: BATCH, amount: 'a day' },
    ]) {
      const res = await call(app, 'POST', path, body);

      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(service.topUps.length, before);
  });
});

describe('POST /profiles/:name/stamp/dilute', () => {
  const path = '/profiles/stage/stamp/dilute';

  it('hands the batch and the depth to the service, and answers 202 with the transaction', async () => {
    const res = await call(app, 'POST', path, { batch_id: BATCH, depth: 24 });

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { batchID: BATCH, txHash: TX });
    assert.deepEqual(service.dilutes.at(-1), ['stage', BATCH, 24]);
  });

  it('refuses a body without a batch id or a whole depth from 17 to 40, before the service', async () => {
    const before = service.dilutes.length;
    for (const body of [
      {},
      { depth: 24 },
      { batch_id: 'a'.repeat(63), depth: 24 },
      { batch_id: BATCH },
      { batch_id: BATCH, depth: 16 },
      { batch_id: BATCH, depth: 41 },
      { batch_id: BATCH, depth: 24.5 },
      { batch_id: BATCH, depth: 'deeper' },
    ]) {
      const res = await call(app, 'POST', path, body);

      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as { error: string }).error, 'validation_error');
    }
    assert.equal(service.dilutes.length, before);
  });
});

describe('the name in the path', () => {
  it('is checked the way every stamp route checks it', async () => {
    const topUps = service.topUps.length;

    const res = await call(app, 'POST', '/profiles/Not%20a%20name/stamp/topup', {
      batch_id: BATCH,
      amount: '1',
    });

    assert.equal(res.status, 400);
    assert.equal(service.topUps.length, topUps);
  });
});
