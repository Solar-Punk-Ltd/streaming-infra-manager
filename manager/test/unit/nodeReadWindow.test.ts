/**
 * One call to a bee node per reading per window, however many pages are asking.
 *
 * Unit test, no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * A deployment page asks six readiness routes per node card every ten seconds,
 * and each of those routes used to build its own client and ask the node. Two
 * open pages on a four rung pool cost the node about eighty requests every ten
 * seconds, four of which make it call its chain RPC. The window collapses that
 * to one call per reading.
 *
 * The other half is what must never read it. A page rendering a reading three
 * seconds old is fine. Starting an uploader, or refusing to, on a reading three
 * seconds old is not, so the gates ask the node themselves and drop whatever
 * window they stepped around.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLUR_PER_BZZ } from '@streaming-infra-manager/common';

import { BeeClient } from '../../src/domain/BeeClient.js';
import { ChequebookService } from '../../src/domain/ChequebookService.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { NodeReadCache } from '../../src/domain/nodeReadCache.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { StampService } from '../../src/domain/StampService.js';
import { makeProfile } from '../support/profileFixtures.js';

const FLOOR = PLUR_PER_BZZ / 2n;
const BATCH = 'b'.repeat(64);
const PROFILE = makeProfile({
  name: 'main-stage',
  host: '10.0.0.9',
  stamp_id: BATCH,
});

const ADDRESS = { chequebookAddress: '0xcheques' };
const SETTLEMENTS = { totalSent: '0', totalReceived: '0' };
const plur = (amount: bigint) => ({
  totalBalance: amount.toString(),
  availableBalance: amount.toString(),
});
const usableStamp = {
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
};

/** A clock the test moves, so a window can pass without the suite waiting. */
function clock(windowMs = 3_000) {
  let at = 1_000;
  return {
    windowMs,
    cache: new NodeReadCache({ windowMs, now: () => at }),
    pass: (ms: number) => {
      at += ms;
    },
  };
}

/** A bee node that records what it was asked, so a window can be seen working. */
function countingNode(answers: Record<string, (...args: never[]) => Promise<unknown>>) {
  const calls: string[] = [];
  const node: Record<string, unknown> = {};
  for (const [route, answer] of Object.entries(answers)) {
    node[route] = (...args: never[]) => {
      calls.push(route);
      return answer(...args);
    };
  }
  return {
    calls,
    node: node as unknown as BeeClient,
    asked: (route: string) => calls.filter((call) => call === route).length,
  };
}

const profiles = () =>
  ({ findByName: async () => PROFILE }) as unknown as ProfileRepository;

function chequebooks(node: BeeClient, cache: NodeReadCache): ChequebookService {
  return new ChequebookService(
    profiles(),
    FLOOR,
    new EventBus(),
    () => node,
    cache,
  );
}

function stamps(node: BeeClient, cache: NodeReadCache): StampService {
  return new StampService(
    profiles(),
    {} as ContainerRepository,
    new EventBus(),
    () => node,
    cache,
  );
}

const answeringNode = (available = PLUR_PER_BZZ) =>
  countingNode({
    getChequebookAddress: async () => ADDRESS,
    getChequebookBalance: async () => plur(available),
    getSettlements: async () => SETTLEMENTS,
  });

describe('the node read window', () => {
  it('costs the node one call when two pages ask at once', async () => {
    const bee = answeringNode();
    const service = chequebooks(bee.node, clock().cache);

    const [first, second] = await Promise.all([
      service.summary(PROFILE.name),
      service.summary(PROFILE.name),
    ]);

    assert.equal(bee.asked('getChequebookBalance'), 1);
    assert.equal(bee.asked('getSettlements'), 1);
    assert.deepEqual(first, second);
  });

  it('holds the answer for the window and asks again after it', async () => {
    const bee = answeringNode();
    const time = clock();
    const service = chequebooks(bee.node, time.cache);

    await service.summary(PROFILE.name);
    time.pass(time.windowMs - 1);
    await service.summary(PROFILE.name);
    assert.equal(bee.asked('getChequebookBalance'), 1);

    time.pass(2);
    await service.summary(PROFILE.name);
    assert.equal(bee.asked('getChequebookBalance'), 2);
  });

  it('does not keep serving a refusal once the window has passed', async () => {
    let refusing = true;
    const bee = countingNode({
      getChequebookAddress: async () => ADDRESS,
      getChequebookBalance: async () => {
        if (refusing) {
          throw new Error(
            'bee request GET /chequebook/balance failed: connection refused',
          );
        }
        return plur(PLUR_PER_BZZ);
      },
      getSettlements: async () => SETTLEMENTS,
    });
    const time = clock();
    const service = chequebooks(bee.node, time.cache);

    assert.equal((await service.summary(PROFILE.name)).health.state, 'unknown');
    refusing = false;
    assert.equal(
      (await service.summary(PROFILE.name)).health.state,
      'unknown',
      'inside the window the refusal is what there is to report',
    );

    time.pass(time.windowMs);
    assert.equal((await service.summary(PROFILE.name)).health.state, 'ok');
    assert.equal(bee.asked('getChequebookBalance'), 2);
  });

  it('lets the uploader gate ask the node rather than read the window', async () => {
    let available = 0n;
    const bee = countingNode({
      getChequebookAddress: async () => ADDRESS,
      getChequebookBalance: async () => plur(available),
      getSettlements: async () => SETTLEMENTS,
    });
    const time = clock();
    const service = chequebooks(bee.node, time.cache);

    assert.equal((await service.summary(PROFILE.name)).health.state, 'empty');
    available = PLUR_PER_BZZ;
    await service.assertFunded(PROFILE.name);

    assert.equal(bee.asked('getChequebookBalance'), 2);
    assert.equal(
      (await service.summary(PROFILE.name)).health.state,
      'ok',
      'the window the gate stepped around is dropped, not left to expire',
    );
  });

  it('costs the node one wallet call when two cards ask at once', async () => {
    const bee = countingNode({
      getWallet: async () => ({ bzzBalance: '1', nativeTokenBalance: '1' }),
    });
    const service = stamps(bee.node, clock().cache);

    await Promise.all([
      service.getWallet(PROFILE.name),
      service.getWallet(PROFILE.name),
    ]);

    assert.equal(bee.asked('getWallet'), 1);
  });

  it('lets the stamp gate ask the node rather than read the window', async () => {
    const bee = countingNode({ getStamp: async () => usableStamp });
    const time = clock();
    const service = stamps(bee.node, time.cache);

    assert.equal(
      (await service.stampHealthFor(PROFILE, BATCH)).state,
      'active',
    );
    await service.assertStampUsable(PROFILE.name, BATCH);

    assert.equal(bee.asked('getStamp'), 2);
  });
});
