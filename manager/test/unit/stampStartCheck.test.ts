/**
 * The stamp check before an uploader starts, when the node does not answer.
 *
 * Unit test, no database and no node. `pnpm test` in manager/.
 *
 * A node that could not be asked used to let the uploader start, with a
 * notice that it had started unchecked. An uploader started on an unverified
 * batch reports RUNNING and fails every upload, so it is refused instead,
 * with the retry in words.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BeeClient } from '../../src/domain/BeeClient.js';
import type { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import {
  BeeHttpError,
  BeeNodeError,
  StampNotUsableError,
} from '../../src/domain/errors/index.js';
import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import { StampService } from '../../src/domain/StampService.js';
import { InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

const BATCH = 'a'.repeat(64);

/** A service whose node answers the stamp lookup with whatever the test says. */
function serviceWhoseNode(getStamp: () => Promise<unknown>) {
  const profiles = new InMemoryProfiles([makeProfile({ name: 'stage', stamp_id: BATCH })]);
  const events = new EventBus();
  const published: ManagerEvent[] = [];
  events.subscribe((event) => published.push(event));
  const service = new StampService(
    profiles.asRepository(),
    {} as ContainerRepository,
    events,
    () => ({ getStamp }) as unknown as BeeClient,
  );
  return { service, published };
}

describe('the stamp check before an uploader starts', () => {
  it('refuses when the node does not answer, naming the node and how to try again', async () => {
    const { service, published } = serviceWhoseNode(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:10015');
    });

    await assert.rejects(
      () => service.assertStampUsable('stage', BATCH),
      (err: unknown) =>
        err instanceof BeeNodeError &&
        /did not answer the stamp check/.test(err.message) &&
        /try again/i.test(err.message),
    );
    assert.deepEqual(published, [], 'nothing started, so nothing to say on screen');
  });

  it('still refuses a batch the node does not know as not usable', async () => {
    const { service } = serviceWhoseNode(async () => {
      throw new BeeHttpError(404, 'bee GET /stamps/... -> 404: not found');
    });

    await assert.rejects(() => service.assertStampUsable('stage', BATCH), StampNotUsableError);
  });

  it('lets a usable batch through', async () => {
    const { service } = serviceWhoseNode(async () => ({
      batchID: BATCH,
      utilization: 0,
      usable: true,
      depth: 20,
      amount: '1',
      bucketDepth: 16,
      blockNumber: 1,
    }));

    await service.assertStampUsable('stage', BATCH);
  });
});
