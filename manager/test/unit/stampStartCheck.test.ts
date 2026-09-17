/**
 * The stamp check before an uploader starts, when the node does not answer.
 *
 * Unit test, no database and no node. `pnpm test` in manager/.
 *
 * D02 refused the start outright when the node said nothing, so an uploader
 * whose node was down could not be started at all. Decision D16 of 2026-09-17
 * turned that half into a warning: the start proceeds, the uploader waits for
 * its node and says so on its own health route. A batch the node answered
 * about and called unknown, expired or not usable yet is still a refusal,
 * because that is the node's own verdict rather than its silence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BeeClient } from '../../src/domain/BeeClient.js';
import type { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import {
  BeeHttpError,
  StampNotUsableError,
} from '../../src/domain/errors/index.js';
import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import { StampService } from '../../src/domain/StampService.js';
import { InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

const BATCH = 'a'.repeat(64);

/** Slot 1 of the bee API port table, which is what `makeProfile` sits on. */
const NODE_URL = 'http://127.0.0.1:10015';

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

const usableStamp = {
  batchID: BATCH,
  utilization: 0,
  usable: true,
  depth: 20,
  amount: '1',
  bucketDepth: 16,
  blockNumber: 1,
};

describe('the stamp check before an uploader starts', () => {
  it('lets the start proceed when the node does not answer, warning with the node URL', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    const { service, published } = serviceWhoseNode(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:10015');
    });

    await service.assertStampUsable('stage', BATCH);

    const warned = warnings.find((line) => /did not answer the stamp check/.test(line));
    assert.ok(warned, `expected a warning about the silent node, got ${JSON.stringify(warnings)}`);
    assert.match(warned, /stage/);
    assert.ok(warned.includes(NODE_URL), `expected the node URL in ${warned}`);
    assert.deepEqual(published, [], 'a warning changes nothing on screen on its own');
  });

  it('still refuses a batch the node does not know as not usable', async () => {
    const { service } = serviceWhoseNode(async () => {
      throw new BeeHttpError(404, 'bee GET /stamps/... -> 404: not found');
    });

    await assert.rejects(() => service.assertStampUsable('stage', BATCH), StampNotUsableError);
  });

  it('still refuses a batch the node reports as expired', async () => {
    const { service } = serviceWhoseNode(async () => ({
      ...usableStamp,
      usable: false,
      batchTTL: 0,
    }));

    await assert.rejects(
      () => service.assertStampUsable('stage', BATCH),
      (err: unknown) =>
        err instanceof StampNotUsableError && /expired/.test(err.message),
    );
  });

  it('lets a usable batch through', async () => {
    const { service } = serviceWhoseNode(async () => usableStamp);

    await service.assertStampUsable('stage', BATCH);
  });
});
