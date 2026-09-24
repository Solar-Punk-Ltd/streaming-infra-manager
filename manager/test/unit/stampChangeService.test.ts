/**
 * Topping up and diluting a batch on a deployment's own Bee node.
 *
 * Unit test, no database and no node: the node is a fake that records what it
 * was asked, so nothing reaches a Bee and no money moves. `pnpm test` in
 * manager/.
 *
 * bee answers a top-up of a batch it does not hold with a plain 500, "cannot
 * topup batch" (bee v2.7.0, pkg/api/postage.go), and its batch store holds
 * every batch on the chain rather than this node's own, so the service reads
 * the batch off the node's own list first. A batch the node does not hold is
 * then refused in words before anything is paid for. The same read gives a
 * dilute the batch's depth, and a depth that is not deeper is refused without
 * asking bee, which refuses only a shallower one and leaves an equal one to the
 * postage contract to refuse on chain.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { Router } from 'express';

import type { BeeClient, BeeStamp } from '../../src/domain/BeeClient.js';
import {
  BeeHttpError,
  BeeNodeError,
  DiluteDepthError,
  ProfileNotFoundError,
  StampNotFoundError,
} from '../../src/domain/errors/index.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { Logger } from '../../src/domain/Logger.js';
import { StampService } from '../../src/domain/StampService.js';
import { FakeContainers, InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';
import { call, startRouterTestApp } from '../support/routerTestApp.js';

const BATCH = 'a'.repeat(64);
const TX = `0x${'b'.repeat(64)}`;
const AMOUNT = '1571927040';

/** Slot 1 of the bee API port table, which is what `makeProfile` sits on. */
const NODE_URL = 'http://127.0.0.1:10015';

/** The host's full 1080p batch of 2026-09-24. */
const heldBatch: BeeStamp = {
  batchID: BATCH,
  utilization: 128,
  usable: true,
  depth: 23,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: 2 * 86_400,
};

interface NodeCalls {
  urls: string[];
  topUps: { batchId: string; amount: string }[];
  dilutes: { batchId: string; depth: number }[];
  stampLists: number;
}

/**
 * A service whose node holds what `getStamp` answers, and whose top-up answers
 * with a transaction unless `topUp` says otherwise. A dilute always does.
 */
function rig(
  t: TestContext,
  {
    getStamp = async () => heldBatch,
    topUp = async () => ({ batchID: BATCH, txHash: TX }),
  }: {
    getStamp?: () => Promise<BeeStamp>;
    topUp?: () => Promise<{ batchID: string; txHash: string }>;
  } = {},
) {
  const infoLines: string[] = [];
  t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => {
    infoLines.push(args.map(String).join(' '));
  });
  const calls: NodeCalls = { urls: [], topUps: [], dilutes: [], stampLists: 0 };
  const client = {
    getStamp,
    topUpStamp: async (batchId: string, amount: string) => {
      calls.topUps.push({ batchId, amount });
      return topUp();
    },
    diluteStamp: async (batchId: string, depth: number) => {
      calls.dilutes.push({ batchId, depth });
      return { batchID: BATCH, txHash: TX };
    },
    listStamps: async () => {
      calls.stampLists += 1;
      return [heldBatch];
    },
  } as unknown as BeeClient;
  const service = new StampService(
    new InMemoryProfiles([makeProfile({ name: 'stage', stamp_id: BATCH })]).asRepository(),
    new FakeContainers().asRepository(),
    new EventBus(),
    (url) => {
      calls.urls.push(url);
      return client;
    },
  );
  return { service, calls, infoLines };
}

describe('topping up a batch on a deployment’s own node', () => {
  it('sends the amount for the batch to that deployment’s own node, and answers the transaction', async (t) => {
    const { service, calls } = rig(t);

    const answer = await service.topUpStamp('stage', `0x${BATCH}`, AMOUNT);

    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
    assert.deepEqual(calls.topUps, [{ batchId: BATCH, amount: AMOUNT }]);
    assert.ok(calls.urls.length > 0 && calls.urls.every((url) => url === NODE_URL), JSON.stringify(calls.urls));
  });

  it('says so in one line that names the batch and the amount', async (t) => {
    const { service, infoLines } = rig(t);

    await service.topUpStamp('stage', BATCH, AMOUNT);

    const lines = infoLines.filter((line) => line.includes('topped up'));
    assert.equal(lines.length, 1, JSON.stringify(infoLines));
    assert.ok(lines[0]!.includes(BATCH), lines[0]);
    assert.ok(lines[0]!.includes(AMOUNT), lines[0]);
  });

  it('forgets what it read from the node, so the next read asks the node again', async (t) => {
    const { service, calls } = rig(t);
    await service.listStamps('stage');
    await service.listStamps('stage');
    assert.equal(calls.stampLists, 1, 'the second read joined the first');

    await service.topUpStamp('stage', BATCH, AMOUNT);
    await service.listStamps('stage');

    assert.equal(calls.stampLists, 2);
  });

  it('refuses a batch the node does not hold, before anything is paid for', async (t) => {
    const { service, calls } = rig(t, {
      getStamp: async () => {
        throw new BeeHttpError(404, 'bee GET /stamps/... → 404: issuer does not exist');
      },
    });

    await assert.rejects(
      () => service.topUpStamp('stage', BATCH, AMOUNT),
      (err: unknown) =>
        err instanceof StampNotFoundError && err.profileName === 'stage' && err.message.includes('aaaaaaaa'),
    );
    assert.deepEqual(calls.topUps, []);
  });

  it('reports a node that refuses the top-up in bee’s own words, the way a refused buy is', async (t) => {
    const { service } = rig(t, {
      topUp: async () => {
        throw new BeeHttpError(402, 'bee PATCH /stamps/topup/... → 402: out of funds');
      },
    });

    await assert.rejects(
      () => service.topUpStamp('stage', BATCH, AMOUNT),
      (err: unknown) => err instanceof BeeNodeError && /out of funds/.test(err.message),
    );
  });

  it('refuses a deployment it does not know', async (t) => {
    const { service, calls } = rig(t);

    await assert.rejects(() => service.topUpStamp('elsewhere', BATCH, AMOUNT), ProfileNotFoundError);
    assert.deepEqual(calls.topUps, []);
  });
});

describe('diluting a batch on a deployment’s own node', () => {
  it('sends the deeper depth for the batch to that deployment’s own node, and answers the transaction', async (t) => {
    const { service, calls } = rig(t);

    const answer = await service.diluteStamp('stage', `0x${BATCH}`, 24);

    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
    assert.deepEqual(calls.dilutes, [{ batchId: BATCH, depth: 24 }]);
    assert.ok(calls.urls.length > 0 && calls.urls.every((url) => url === NODE_URL), JSON.stringify(calls.urls));
  });

  it('says so in one line that names the batch and both depths', async (t) => {
    const { service, infoLines } = rig(t);

    await service.diluteStamp('stage', BATCH, 24);

    const lines = infoLines.filter((line) => line.includes('diluted'));
    assert.equal(lines.length, 1, JSON.stringify(infoLines));
    assert.ok(lines[0]!.includes(BATCH), lines[0]);
    assert.match(lines[0]!, /23\D+24/);
  });

  it('refuses a depth that is not deeper than the batch’s own, without asking bee to dilute', async (t) => {
    const { service, calls } = rig(t);

    for (const depth of [23, 22]) {
      await assert.rejects(
        () => service.diluteStamp('stage', BATCH, depth),
        (err: unknown) =>
          err instanceof DiluteDepthError &&
          err.currentDepth === 23 &&
          err.requestedDepth === depth &&
          /deeper than 23/.test(err.reason),
      );
    }
    assert.deepEqual(calls.dilutes, []);
  });

  it('refuses a batch the node does not hold, before anything is sent', async (t) => {
    const { service, calls } = rig(t, {
      getStamp: async () => {
        throw new BeeHttpError(404, 'bee GET /stamps/... → 404: issuer does not exist');
      },
    });

    await assert.rejects(() => service.diluteStamp('stage', BATCH, 24), StampNotFoundError);
    assert.deepEqual(calls.dilutes, []);
  });

  it('forgets what it read from the node, so the next read asks the node again', async (t) => {
    const { service, calls } = rig(t);
    await service.listStamps('stage');

    await service.diluteStamp('stage', BATCH, 24);
    await service.listStamps('stage');

    assert.equal(calls.stampLists, 2);
  });
});

describe('a depth a batch cannot be diluted to', () => {
  it('answers 400 with the reason where the page reads it', async (t) => {
    const router = Router();
    router.post('/dilute', (_req, _res, next) => next(new DiluteDepthError('stage', BATCH, 23, 23)));
    const app = await startRouterTestApp(router);
    t.after(() => app.close());

    const res = await call(app, 'POST', '/dilute', {});

    assert.equal(res.status, 400);
    const body = res.body as { error: string; errors: string[] };
    assert.equal(body.error, 'validation_error');
    assert.equal(body.errors.length, 1);
    assert.match(body.errors[0]!, /depth 23/);
    assert.doesNotMatch(body.errors[0]!, /[—;]/);
  });
});

describe('a batch its node does not hold', () => {
  it('answers 404 with the reason where the page reads it', async (t) => {
    const router = Router();
    router.post('/topup', (_req, _res, next) => next(new StampNotFoundError('stage', BATCH)));
    const app = await startRouterTestApp(router);
    t.after(() => app.close());

    const res = await call(app, 'POST', '/topup', {});

    assert.equal(res.status, 404);
    const body = res.body as { error: string; name: string; message: string };
    assert.equal(body.error, 'stamp_not_found');
    assert.equal(body.name, 'stage');
    assert.match(body.message, /does not hold/);
    assert.doesNotMatch(body.message, /[—;]/);
  });
});
