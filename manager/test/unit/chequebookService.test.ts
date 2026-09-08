/**
 * Moving BZZ into and out of a node's chequebook, and the gate that refuses an
 * uploader whose node cannot pay for uploads.
 *
 * Unit test, no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Two properties carry the weight. A deposit is checked against the wallet
 * before it is submitted, so an operator gets a sentence about their own node
 * instead of a chain revert, and no gas is spent on a transaction that cannot
 * succeed. And the gate refuses only on an answer: a node that cannot be asked
 * lets the deploy through, because a failed probe says nothing about a
 * chequebook and blocking on one would stop work that has nothing wrong with it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLUR_PER_BZZ } from '@streaming-infra-manager/common';

import { BeeClient } from '../../src/domain/BeeClient.js';
import { ChequebookService } from '../../src/domain/ChequebookService.js';
import {
  BeeHttpError,
  BeeNodeError,
  BeeNotReadyError,
  ChequebookBusyError,
  ChequebookFundsError,
  ChequebookUnfundedError,
  ProfileNotFoundError,
} from '../../src/domain/errors/index.js';
import { EventBus, type ManagerEvent } from '../../src/domain/EventBus.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { Profile } from '../../src/types/index.js';

const FLOOR = PLUR_PER_BZZ / 2n;
const HALF_BZZ = PLUR_PER_BZZ / 2n;
const ONE_BZZ = PLUR_PER_BZZ;

const PROFILE: Profile = {
  name: 'main-stage',
  port_slot: 1,
  kind: 'streamer',
  notes: null,
  components: null,
  host: '10.0.0.9',
  feed_owner: null,
  feed_topic: null,
  private_key: null,
  public_key: null,
  stamp_id: null,
  bee_publishers: null,
  bee_url: null,
  srt_passphrase: null,
  engine_settings: {},
  has_engine_config: false,
  engine_config_error: null,
  engine_config_state: null,
  instance_id: 'instance-1',
  engine_config_revision: 0,
  intent_revision: 0,
  stack_version_id: 1,
  status: 'RUNNING',
  last_error: null,
  last_error_at: null,
  last_full_deploy_commit: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  group_id: null,
};

const wallet = (bzz: string, xdai: string) => ({
  bzzBalance: bzz,
  nativeTokenBalance: xdai,
});

const balance = (available: string, total = available) => ({
  totalBalance: total,
  availableBalance: available,
});

const failing = (what: string) => async () => {
  throw new Error(`bee request ${what} failed: connection refused`);
};

/** A ChequebookService whose only live dependency is a scripted bee node. */
function serviceAnswering(
  client: Partial<BeeClient>,
  floorPlur: bigint = FLOOR,
): ChequebookService {
  return build(client, floorPlur).service;
}

/** The same, with the events it published kept for the tests that read them. */
function build(client: Partial<BeeClient>, floorPlur: bigint = FLOOR) {
  const profiles = {
    findByName: async () => PROFILE,
  } as unknown as ProfileRepository;

  const events = new EventBus();
  const published: ManagerEvent[] = [];
  events.subscribe((event) => published.push(event));

  return {
    published,
    service: new ChequebookService(
      profiles,
      floorPlur,
      events,
      () => client as unknown as BeeClient,
    ),
  };
}

describe('ChequebookService.deposit', () => {
  it('refuses more than the wallet holds, without asking bee to try', async () => {
    let submitted = false;
    const service = serviceAnswering({
      getWallet: async () => wallet(HALF_BZZ.toString(), '400000000000000000'),
      depositChequebook: async () => {
        submitted = true;
        return { transactionHash: '0xshould-not-happen' };
      },
    });

    await assert.rejects(
      () => service.deposit(PROFILE.name, ONE_BZZ),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookFundsError);
        assert.match(err.reason, /holds 0\.5000 BZZ/);
        assert.match(err.reason, /asks for 1\.0000 BZZ/);
        return true;
      },
    );
    assert.equal(submitted, false, 'a doomed deposit must not reach the chain');
  });

  it('refuses when the wallet has no xDAI to pay the gas with', async () => {
    let submitted = false;
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '0'),
      depositChequebook: async () => {
        submitted = true;
        return { transactionHash: '0xshould-not-happen' };
      },
    });

    await assert.rejects(
      () => service.deposit(PROFILE.name, HALF_BZZ),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookFundsError);
        assert.match(err.reason, /no xDAI/);
        return true;
      },
    );
    assert.equal(submitted, false);
  });

  it('submits the exact PLUR amount when the wallet can cover it', async () => {
    const asked: bigint[] = [];
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '400000000000000000'),
      depositChequebook: async (amountPlur: bigint) => {
        asked.push(amountPlur);
        return { transactionHash: '0xdeposited' };
      },
    });

    const result = await service.deposit(PROFILE.name, HALF_BZZ);

    assert.deepEqual(asked, [HALF_BZZ]);
    assert.equal(result.transactionHash, '0xdeposited');
  });

  it('accepts a deposit of the whole wallet balance', async () => {
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '1'),
      depositChequebook: async () => ({ transactionHash: '0xall-of-it' }),
    });

    const result = await service.deposit(PROFILE.name, ONE_BZZ);
    assert.equal(result.transactionHash, '0xall-of-it');
  });

  it('reports an unreachable node as such, not as a funding problem', async () => {
    const service = serviceAnswering({ getWallet: failing('GET /wallet') });

    await assert.rejects(
      () => service.deposit(PROFILE.name, HALF_BZZ),
      BeeNodeError,
    );
  });

  it('reports a node that answered 503 as still starting, not unreachable', async () => {
    const service = serviceAnswering({
      getWallet: async () => {
        throw new BeeHttpError(503, 'bee GET /wallet → 503: Node is syncing');
      },
    });

    await assert.rejects(
      () => service.deposit(PROFILE.name, HALF_BZZ),
      BeeNotReadyError,
    );
  });

  it('refuses a profile this manager does not have', async () => {
    const service = new ChequebookService(
      { findByName: async () => null } as unknown as ProfileRepository,
      FLOOR,
      new EventBus(),
      () => ({}) as unknown as BeeClient,
    );

    await assert.rejects(
      () => service.deposit('nobody', HALF_BZZ),
      ProfileNotFoundError,
    );
  });
});

describe('ChequebookService.withdraw', () => {
  it('refuses more than the chequebook has available', async () => {
    let submitted = false;
    const service = serviceAnswering({
      getChequebookBalance: async () =>
        balance('300000000000000', ONE_BZZ.toString()),
      withdrawChequebook: async () => {
        submitted = true;
        return { transactionHash: '0xshould-not-happen' };
      },
    });

    await assert.rejects(
      () => service.withdraw(PROFILE.name, HALF_BZZ),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookFundsError);
        assert.match(err.reason, /has 0\.0300 BZZ available/);
        return true;
      },
    );
    assert.equal(submitted, false);
  });

  it('answers on what is available, not on the total', async () => {
    // The gap is cheques already handed out and not yet cashed. A withdrawal
    // against the total would be refused by the contract itself.
    const service = serviceAnswering({
      getChequebookBalance: async () =>
        balance(ONE_BZZ.toString(), (ONE_BZZ * 3n).toString()),
      withdrawChequebook: async () => ({ transactionHash: '0xwithdrawn' }),
    });

    const result = await service.withdraw(PROFILE.name, ONE_BZZ);
    assert.equal(result.transactionHash, '0xwithdrawn');
  });
});

describe('one transfer per node at a time', () => {
  /** A promise this test decides when to settle, standing in for the chain. */
  function held<T>() {
    let release: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('refuses a second deposit while the first has not been answered', async () => {
    const submit = held<{ transactionHash: string }>();
    let submitted = 0;
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '400000000000000000'),
      depositChequebook: async () => {
        submitted += 1;
        return submit.promise;
      },
    });

    const first = service.deposit(PROFILE.name, HALF_BZZ);
    // The wallet read and the submit are two awaits, so let the first request
    // reach the point a second one would overtake it at.
    await Promise.resolve();
    await Promise.resolve();

    await assert.rejects(
      () => service.deposit(PROFILE.name, HALF_BZZ),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookBusyError);
        assert.equal(
          err.message,
          'A transfer for this node is already in flight. Wait for it to confirm, then try again.',
        );
        return true;
      },
    );

    submit.release({ transactionHash: '0xfirst' });
    assert.equal((await first).transactionHash, '0xfirst');
    assert.equal(submitted, 1, 'only one deposit may reach the chain');
  });

  it('refuses a withdrawal while a deposit is outstanding', async () => {
    const submit = held<{ transactionHash: string }>();
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '400000000000000000'),
      depositChequebook: async () => submit.promise,
      getChequebookBalance: async () => balance(ONE_BZZ.toString()),
      withdrawChequebook: async () => ({ transactionHash: '0xshould-not' }),
    });

    const deposit = service.deposit(PROFILE.name, HALF_BZZ);
    await Promise.resolve();
    await Promise.resolve();

    await assert.rejects(
      () => service.withdraw(PROFILE.name, HALF_BZZ),
      ChequebookBusyError,
    );

    submit.release({ transactionHash: '0xdeposited' });
    await deposit;
  });

  it('lets the next transfer through once bee has answered the submit', async () => {
    const service = serviceAnswering({
      getWallet: async () => wallet(ONE_BZZ.toString(), '400000000000000000'),
      depositChequebook: async () => ({ transactionHash: '0xdeposited' }),
    });

    await service.deposit(PROFILE.name, HALF_BZZ);
    const second = await service.deposit(PROFILE.name, HALF_BZZ);

    assert.equal(second.transactionHash, '0xdeposited');
  });

  it('releases the node when the transfer was refused', async () => {
    const service = serviceAnswering({
      getWallet: async () => wallet(HALF_BZZ.toString(), '400000000000000000'),
      depositChequebook: async () => ({ transactionHash: '0xdeposited' }),
    });

    await assert.rejects(
      () => service.deposit(PROFILE.name, ONE_BZZ),
      ChequebookFundsError,
    );
    // A refusal that left the node marked busy would need a manager restart to
    // clear, which is a worse failure than the one being prevented.
    await assert.rejects(
      () => service.deposit(PROFILE.name, ONE_BZZ),
      ChequebookFundsError,
    );
  });
});

describe('ChequebookService.assertFunded', () => {
  it('throws below the floor, quoting both numbers', async () => {
    const service = serviceAnswering({
      getChequebookBalance: async () => balance('1200000000000000'),
    });

    await assert.rejects(
      () => service.assertFunded(PROFILE.name),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookUnfundedError);
        assert.equal(
          err.message,
          "This deployment's Bee node has 0.1200 BZZ available in its chequebook and the floor is 0.5000 BZZ. Fill the chequebook, then start the uploader.",
        );
        return true;
      },
    );
  });

  it('throws on an empty chequebook', async () => {
    const service = serviceAnswering({
      getChequebookBalance: async () => balance('0'),
    });

    await assert.rejects(
      () => service.assertFunded(PROFILE.name),
      ChequebookUnfundedError,
    );
  });

  it('lets a node exactly at the floor through', async () => {
    const service = serviceAnswering({
      getChequebookBalance: async () => balance(FLOOR.toString()),
    });

    await service.assertFunded(PROFILE.name);
  });

  it('proceeds when the node cannot be asked', async () => {
    // A failed probe is not evidence of an empty chequebook, and refusing on
    // one would stop a deploy for a reason the operator cannot see or fix.
    const service = serviceAnswering({
      getChequebookBalance: failing('GET /chequebook/balance'),
    });

    await service.assertFunded(PROFILE.name);
  });

  it('says on screen that it started without checking', async () => {
    // Proceeding silently is the whole problem: an uploader running on an
    // unverified chequebook looks exactly like one that was checked.
    const { service, published } = build({
      getChequebookBalance: failing('GET /chequebook/balance'),
    });

    await service.assertFunded(PROFILE.name);

    assert.deepEqual(published, [
      {
        type: 'profile.notice',
        profile: PROFILE.name,
        text: 'Started without checking the chequebook of main-stage: its node did not answer.',
        tone: 'warn',
      },
    ]);
  });

  it('says nothing when the node answered', async () => {
    const { service, published } = build({
      getChequebookBalance: async () => balance(FLOOR.toString()),
    });

    await service.assertFunded(PROFILE.name);

    assert.deepEqual(published, []);
  });

  it('proceeds when the node answers with something unreadable', async () => {
    const service = serviceAnswering({
      getChequebookBalance: async () => balance('not a number'),
    });

    await service.assertFunded(PROFILE.name);
  });

  it('reads the floor it was built with, not a hardcoded one', async () => {
    const twoBzz = PLUR_PER_BZZ * 2n;
    const service = serviceAnswering(
      { getChequebookBalance: async () => balance(ONE_BZZ.toString()) },
      twoBzz,
    );

    await assert.rejects(
      () => service.assertFunded(PROFILE.name),
      (err: unknown) => {
        assert.ok(err instanceof ChequebookUnfundedError);
        assert.match(err.message, /floor is 2\.0000 BZZ/);
        return true;
      },
    );
  });
});

describe('ChequebookService.summary', () => {
  it('carries every piece the node reported', async () => {
    const service = serviceAnswering({
      getChequebookAddress: async () => ({ chequebookAddress: '0xcheques' }),
      getChequebookBalance: async () =>
        balance('12400000000000000', '13100000000000000'),
      getSettlements: async () => ({
        totalSent: '700000000000000',
        totalReceived: '0',
      }),
    });

    const summary = await service.summary(PROFILE.name);

    assert.deepEqual(summary, {
      address: '0xcheques',
      totalBalance: '13100000000000000',
      availableBalance: '12400000000000000',
      totalSent: '700000000000000',
      totalReceived: '0',
      health: {
        state: 'ok',
        availablePlur: '12400000000000000',
        floorPlur: FLOOR.toString(),
      },
    });
  });

  it('nulls only the piece that failed, and never the whole answer', async () => {
    const service = serviceAnswering({
      getChequebookAddress: async () => ({ chequebookAddress: '0xcheques' }),
      getChequebookBalance: async () => balance('0'),
      getSettlements: failing('GET /settlements'),
    });

    const summary = await service.summary(PROFILE.name);

    assert.equal(summary.address, '0xcheques');
    assert.equal(summary.health.state, 'empty');
    assert.equal(summary.totalSent, null);
    assert.equal(summary.totalReceived, null);
  });

  it('reports unknown, not empty, when the balance could not be read', async () => {
    const service = serviceAnswering({
      getChequebookAddress: failing('GET /chequebook/address'),
      getChequebookBalance: failing('GET /chequebook/balance'),
      getSettlements: failing('GET /settlements'),
    });

    const summary = await service.summary(PROFILE.name);

    assert.equal(summary.health.state, 'unknown');
    assert.equal(summary.health.availablePlur, null);
    assert.equal(summary.availableBalance, null);
  });
});

describe('ChequebookService.floorBzz', () => {
  it('reads back the floor the gate uses, for the UI to quote', () => {
    assert.equal(serviceAnswering({}).floorBzz, '0.5000');
    assert.equal(serviceAnswering({}, 40_000_000_000_000n).floorBzz, '0.0040');
  });
});
