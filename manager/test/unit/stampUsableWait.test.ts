/**
 * What happens to a batch bought on a deployment's Storage card once bee calls
 * it usable.
 *
 * Unit test, no database and no node. `pnpm test` in manager/.
 *
 * On 2026-09-24 the tester bought a fresh batch for the pool's 1080p rung, whose
 * immutable batch was full, and the card's promise that a new batch "is set on
 * this deployment automatically" did not hold: the wait saw a stamp already
 * recorded and logged "not overriding", so the full batch stayed set until the
 * operator clicked Use. The operator bought it on that deployment's page for that
 * deployment, so the wait sets it, unless the operator chose another batch while
 * it settled.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import type { BeeClient } from '../../src/domain/BeeClient.js';
import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import { Logger } from '../../src/domain/Logger.js';
import { StampService } from '../../src/domain/StampService.js';
import { FakeContainers, InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

const FULL = `0x${'a'.repeat(64)}`;
const BOUGHT = 'b'.repeat(64);
const CHOSEN = 'c'.repeat(64);

/** The batch the fake node answers about, usable once `settled` says so. */
const batchAnswer = (settled: boolean) => ({
  batchID: BOUGHT,
  utilization: 0,
  usable: settled,
  depth: 23,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: settled ? 30 * 86_400 : -1,
});

interface Rig {
  service: StampService;
  profiles: InMemoryProfiles;
  published: ManagerEvent[];
  infoLines: string[];
  /** Makes the bought batch usable from the node's next answer on. */
  settle: () => void;
}

/**
 * A service whose node sells one batch and reports it usable once told to, and
 * whose wait between polls hands the event loop back rather than taking three
 * seconds, so a test settles a batch in milliseconds.
 */
function rigFor(t: TestContext, recorded: string | null): Rig {
  const infoLines: string[] = [];
  t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => {
    infoLines.push(args.map(String).join(' '));
  });

  let settled = false;
  const profiles = new InMemoryProfiles([makeProfile({ name: 'stage', stamp_id: recorded })]);
  const events = new EventBus();
  const published: ManagerEvent[] = [];
  events.subscribe((event) => published.push(event));
  const client = {
    buyStamp: async () => ({ batchID: BOUGHT }),
    getStamp: async () => batchAnswer(settled),
  } as unknown as BeeClient;

  const service = new StampService(
    profiles.asRepository(),
    new FakeContainers().asRepository(),
    events,
    () => client,
    undefined,
    undefined,
    () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      }),
  );
  return { service, profiles, published, infoLines, settle: () => { settled = true; } };
}

/**
 * Waits until the fire-and-forget wait has decided, which it always logs, on
 * the clock rather than on a count of turns, because before this fix the wait
 * slept three real seconds between polls.
 */
async function decided(infoLines: readonly string[], batchId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = infoLines.find((entry) => entry.includes(`stamp ${batchId} usable`));
    if (line) return line;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`the wait for ${batchId} never logged a decision: ${JSON.stringify(infoLines)}`);
}

const buyOn = (service: StampService) =>
  service.buyStamp('stage', { amount: '1000000000', depth: 23, immutable: true });

describe('a batch bought on a deployment', () => {
  it('is set on that deployment once usable, even though it already records one', async (t) => {
    const { service, profiles, published, infoLines, settle } = rigFor(t, FULL);

    await buyOn(service);
    settle();
    await decided(infoLines, BOUGHT);

    assert.equal(profiles.rows.get('stage')?.stamp_id, BOUGHT);
    assert.ok(
      published.some(
        (event) => event.type === 'profile.changed' && event.profile.stamp_id === BOUGHT,
      ),
      'the pages hear about the new stamp',
    );
  });

  it('keeps a batch the operator set with Use while it settled, and says why', async (t) => {
    const { service, profiles, infoLines, settle } = rigFor(t, FULL);

    await buyOn(service);
    await service.setStamp('stage', CHOSEN);
    settle();
    const line = await decided(infoLines, BOUGHT);

    assert.equal(profiles.rows.get('stage')?.stamp_id, CHOSEN);
    assert.match(line, /changed/);
    assert.ok(line.includes(CHOSEN), `the log names the batch that was kept: ${line}`);
  });

  it('is set on a deployment that records none, as before', async (t) => {
    const { service, profiles, infoLines, settle } = rigFor(t, null);

    await buyOn(service);
    settle();
    await decided(infoLines, BOUGHT);

    assert.equal(profiles.rows.get('stage')?.stamp_id, BOUGHT);
  });
});
