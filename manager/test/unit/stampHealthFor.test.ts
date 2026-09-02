/**
 * Turning bee's answer about one batch into a state the UI can act on.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Two mappings carry the weight. A 404 is bee saying it has no such batch, which
 * for a batch we hold an id for means it expired and was dropped — an answer, not
 * a failure. Anything else (timeout, refused connection) is a failure to answer,
 * and must come back `unknown`: reporting an unreachable node as an expired batch
 * would trade one wrong claim for another.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeeStampClient } from '../../src/domain/BeeStampClient.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { BeeHttpError } from '../../src/domain/errors/index.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { StampService } from '../../src/domain/StampService.js';
import { Profile } from '../../src/types/index.js';

const BATCH = 'a'.repeat(64);

const PROFILE: Profile = {
  name: 'stage-360p',
  port_slot: 3,
  kind: 'custom',
  notes: null,
  components: ['bee-uploader'],
  host: '10.0.0.9',
  feed_owner: null,
  feed_topic: null,
  private_key: null,
  public_key: null,
  stamp_id: BATCH,
  bee_publishers: null,
  bee_url: null,
  status: 'RUNNING',
  last_error: null,
  last_error_at: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  group_id: 1,
};

const stamp = (over: Record<string, unknown> = {}) => ({
  batchID: BATCH,
  utilization: 0,
  usable: true,
  depth: 17,
  amount: '100000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: false,
  exists: true,
  batchTTL: 86_400,
  ...over,
});

/** A StampService whose only live dependency is a scripted `getStamp`. */
function serviceAnswering(getStamp: (batchId: string) => Promise<unknown>): {
  service: StampService;
  timeouts: (number | undefined)[];
} {
  const timeouts: (number | undefined)[] = [];
  const service = new StampService(
    {} as ProfileRepository,
    {} as ContainerRepository,
    {} as EventBus,
    (_url, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { getStamp } as unknown as BeeStampClient;
    },
  );
  return { service, timeouts };
}

describe('StampService.stampHealthFor', () => {
  it('reports none without asking when nothing is recorded', async () => {
    let asked = false;
    const { service } = serviceAnswering(async () => {
      asked = true;
      return stamp();
    });
    for (const id of [null, undefined, '', '  ']) {
      assert.equal((await service.stampHealthFor(PROFILE, id)).state, 'none');
    }
    assert.equal(asked, false);
  });

  it('reports active for a usable batch with time left', async () => {
    const { service } = serviceAnswering(async () => stamp());
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'active');
  });

  it('reports expired at zero TTL', async () => {
    const { service } = serviceAnswering(async () =>
      stamp({ batchTTL: 0, usable: false }),
    );
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'expired');
  });

  it('reports gone when bee has never heard of the batch', async () => {
    const { service } = serviceAnswering(async () => {
      throw new BeeHttpError(404, 'bee GET /stamps/... -> 404: not found');
    });
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'gone');
  });

  it('reports pending for a batch bee has not settled yet', async () => {
    const { service } = serviceAnswering(async () => stamp({ usable: false }));
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'pending');
  });

  it('reports unknown when the node cannot be reached', async () => {
    const { service } = serviceAnswering(async () => {
      throw new Error('bee request GET /stamps/... failed: timeout');
    });
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'unknown');
  });

  it('reports unknown on any other bee error, never expired', async () => {
    const { service } = serviceAnswering(async () => {
      throw new BeeHttpError(500, 'bee GET /stamps/... -> 500: boom');
    });
    assert.equal((await service.stampHealthFor(PROFILE, BATCH)).state, 'unknown');
  });

  it('strips a 0x prefix before asking bee', async () => {
    const seen: string[] = [];
    const { service } = serviceAnswering(async (batchId) => {
      seen.push(batchId);
      return stamp();
    });
    await service.stampHealthFor(PROFILE, `0x${BATCH}`);
    assert.deepEqual(seen, [BATCH]);
  });

  it('asks on a short timeout, so a dead node cannot hold the page', async () => {
    const { service, timeouts } = serviceAnswering(async () => stamp());
    (await service.stampHealthFor(PROFILE, BATCH)).state;
    assert.equal(timeouts.length, 1);
    assert.ok(timeouts[0]! > 0 && timeouts[0]! <= 5_000);
  });

  it('carries the TTL back, so expiry can be warned about before it happens', () => {
    // Discarded previously, which left no way to say "6h left" — only "expired".
    return (async () => {
      const { service } = serviceAnswering(async () => stamp({ batchTTL: 7_200 }));
      const health = await service.stampHealthFor(PROFILE, BATCH);
      assert.equal(health.state, 'active');
      assert.equal(health.ttl, 7_200);
    })();
  });
});
