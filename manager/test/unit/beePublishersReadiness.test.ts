/**
 * A ladder is only ready when its four batches are still alive.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * Two regressions of the same shape. `profiles.stamp_id` records which batch a
 * rung was pointed at, not that the batch still pays — batches are finite leases
 * that expire on their own and nothing writes that back. And the rung's URL is
 * composed arithmetically from a field that holds a *deploy* target, so it always
 * parses whether or not a bee node is there. A ladder whose four batches had run
 * out a week earlier reported ready and handed out a paste-ready BEE_PUBLISHERS
 * built from dead ids and unchecked addresses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_NODE_POOL_GROUP_KIND,
  DEFAULT_ABR_RUNGS,
  type PublishUrlState,
  stampHealthFrom,
  type StampLike,
  type StampState,
} from '@streaming-infra-manager/common';

import type { DeployTargets } from '../../src/domain/ports/DeployTargets.js';
import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { DeploymentOrchestrator } from '../../src/domain/DeploymentOrchestrator.js';
import { EventBus } from '../../src/domain/EventBus.js';
import {
  ProfileService,
  type PublishUrlProbe,
  type StampHealthProbe,
} from '../../src/domain/ProfileService.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import type { StackVersionRepository } from '../../src/domain/versions/StackVersionRepository.js';
import { DeploymentGroup, Profile } from '../../src/types/index.js';

/**
 * The address a container on this host reaches a locally deployed node on, which
 * is what localHost.ts resolves for real. Injected here, so no test needs Docker.
 */
const LOCAL_PUBLISHER_HOST = '10.200.0.1';

/** These tests never allocate: a reader that answers one daemon is enough to build the service. */
function localTargets(): DeployTargets {
  return { daemonIdFor: async () => 'daemon-1' };
}


const GROUP: DeploymentGroup = {
  id: 7,
  name: 'stage',
  size: DEFAULT_ABR_RUNGS.length,
  kind: ABR_NODE_POOL_GROUP_KIND,
  created_at: new Date(0),
};

const BATCH = (rung: string) => rung.padEnd(64, '0');

function member(rung: string, index: number): Profile {
  return {
    name: `${GROUP.name}-${rung}`,
    port_slot: index,
    kind: 'custom',
    notes: null,
    notes_revision: 0,
    components: ['bee-uploader'],
    host: '10.0.0.9',
    feed_owner: null,
    feed_topic: null,
    has_private_key: false,
    public_key: null,
    stamp_id: BATCH(rung),
    bee_publishers: null,
    bee_url: null,
    has_rpc_endpoint: false,
    rpc_endpoint_host: null,
    rpc_endpoint_source: 'stack',
    node_mode: null,
    has_srt_passphrase: false,
    engine_settings: {},
    has_engine_config: false,
    engine_config_error: null,
    engine_config_state: null,
    instance_id: 'instance-1',
    engine_config_revision: 0,
    intent_revision: 0,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    last_full_deploy_commit: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    group_id: GROUP.id,
    stack_version_id: 1,
  };
}

/**
 * A live batch with the given state, as a node would report it.
 *
 * Built through `stampHealthFrom` rather than by hand so the tests exercise the
 * same classification the manager does.
 */
function healthOf(state: StampState, ttl = 30 * 24 * 3_600, fill: BatchFill = {}) {
  const id = 'a'.repeat(64);
  switch (state) {
    case 'none':
      return stampHealthFrom(null, []);
    case 'unknown':
      return stampHealthFrom(id, null);
    case 'gone':
      return stampHealthFrom(id, []);
    default:
      return stampHealthFrom(id, [
        {
          batchID: id,
          usable: state !== 'pending' && state !== 'expired',
          batchTTL: state === 'expired' ? 0 : ttl,
          ...fill,
        },
      ]);
  }
}

/** What bee says about how full a batch is, which a test adds to a live one. */
type BatchFill = Pick<StampLike, 'utilization' | 'depth' | 'bucketDepth' | 'immutableFlag'>;

interface Scripted {
  /** Per member name. Defaults to a healthy, long-lived batch. */
  stamps?: Record<string, StampState>;
  /** Per member name. Defaults to an address something answers at. */
  urls?: Record<string, PublishUrlState>;
  /** Per member name, seconds. Only meaningful for a live batch. */
  ttls?: Record<string, number>;
  /** Per member name. Only meaningful for a batch the node answered about. */
  fills?: Record<string, BatchFill>;
  members?: Profile[];
  /** What a container on this host reaches a locally deployed node on. */
  localHost?: string;
}

interface ScriptedService {
  service: ProfileService;
  askedStamps: string[];
  askedUrls: string[];
  localHostReads: () => number;
}

/** A ProfileService wired to one ladder and a scripted answer per rung. */
function serviceFor(scripted: Scripted = {}): ScriptedService {
  const members = scripted.members ?? DEFAULT_ABR_RUNGS.map(member);
  const askedStamps: string[] = [];
  const askedUrls: string[] = [];
  let localHostReads = 0;

  const stampProbe: StampHealthProbe = async (profile) => {
    askedStamps.push(profile.name);
    return healthOf(
      scripted.stamps?.[profile.name] ?? 'active',
      scripted.ttls?.[profile.name],
      scripted.fills?.[profile.name],
    );
  };

  const urlProbe: PublishUrlProbe = async (url) => {
    askedUrls.push(url);
    const owner = members.find((m) => url.includes(String(10005 + m.port_slot * 10)));
    return (owner && scripted.urls?.[owner.name]) ?? 'ok';
  };

  const groupRepo = {
    findById: async (id: number) => (id === GROUP.id ? GROUP : null),
    listMembers: async () => members,
  } as unknown as DeploymentGroupRepository;

  const service = new ProfileService(
    {} as ProfileRepository,
    {} as ContainerRepository,
    {} as DeploymentOrchestrator,
    {} as EventBus,
    groupRepo,
    {} as StackVersionRepository,
    localTargets(),
    stampProbe,
    urlProbe,
    undefined,
    async () => {
      localHostReads += 1;
      return scripted.localHost ?? LOCAL_PUBLISHER_HOST;
    },
  );

  return { service, askedStamps, askedUrls, localHostReads: () => localHostReads };
}

const forEveryRung = <T,>(value: T): Record<string, T> =>
  Object.fromEntries(
    DEFAULT_ABR_RUNGS.map((rung) => [`${GROUP.name}-${rung}`, value]),
  );

describe('beePublishersForGroup — live batch state', () => {
  it('asks every rung’s own node about its batch', async () => {
    const { service, askedStamps } = serviceFor();
    await service.beePublishersForGroup(GROUP.id);
    assert.deepEqual(
      askedStamps.sort(),
      DEFAULT_ABR_RUNGS.map((r) => `${GROUP.name}-${r}`).sort(),
    );
  });

  // The address the uploader is handed, not the one the manager verifies batches
  // through — those differ for a local profile, and only this one is published.
  it('probes the exact address that goes into the string', async () => {
    const { service, askedUrls } = serviceFor();
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.deepEqual(
      askedUrls.sort(),
      result.rungs.map((r) => r.url).sort(),
    );
  });

  it('emits the value when every batch is alive', async () => {
    const { service } = serviceFor();
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.equal(result.value?.split(' ').length, DEFAULT_ABR_RUNGS.length);
  });

  it('refuses the value when every batch has expired', async () => {
    const { service } = serviceFor({ stamps: forEveryRung('expired') });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.equal(result.missing.length, DEFAULT_ABR_RUNGS.length);
  });

  it('refuses the value when a single batch has expired', async () => {
    const { service } = serviceFor({ stamps: { [`${GROUP.name}-1080p`]: 'expired' } });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.missing.map((m) => m.rung),
      ['1080p'],
    );
  });

  it('refuses a batch the node has dropped entirely', async () => {
    const { service } = serviceFor({ stamps: { [`${GROUP.name}-360p`]: 'gone' } });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.missing.map((m) => m.rung),
      ['360p'],
    );
  });

  it('reports each rung’s state so the UI can name the broken one', async () => {
    const { service } = serviceFor({ stamps: { [`${GROUP.name}-720p`]: 'expired' } });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(
      result.rungs.find((r) => r.rung === '720p')?.stampState,
      'expired',
    );
    assert.equal(
      result.rungs.find((r) => r.rung === '480p')?.stampState,
      'active',
    );
  });

  // An unreachable node is not evidence that its batch is dead: the operator
  // still gets a value, and the card flags it as unverified.
  it('stays ready when a node could not be reached', async () => {
    const { service } = serviceFor({ stamps: forEveryRung('unknown') });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.ok(result.value);
  });

  it('survives a probe that throws, treating that rung as unverified', async () => {
    const groupRepo = {
      findById: async () => GROUP,
      listMembers: async () => DEFAULT_ABR_RUNGS.map(member),
    } as unknown as DeploymentGroupRepository;
    const service = new ProfileService(
      {} as ProfileRepository,
      {} as ContainerRepository,
      {} as DeploymentOrchestrator,
      {} as EventBus,
      groupRepo,
      {} as StackVersionRepository,
      localTargets(),
      async () => {
        throw new Error('bee node on fire');
      },
      async () => 'ok',
    );

    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.ok(result.rungs.every((r) => r.stampState === 'unknown'));
  });

  it('still names a rung with no batch recorded at all', async () => {
    const members = DEFAULT_ABR_RUNGS.map(member).map((p) =>
      p.name.endsWith('-480p') ? { ...p, stamp_id: null } : p,
    );
    const { service } = serviceFor({ members });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.missing.map((m) => m.rung),
      ['480p'],
    );
  });

  it('reports a rung with no member ahead of anything about batches', async () => {
    const members = DEFAULT_ABR_RUNGS.filter((r) => r !== '1080p').map(member);
    const { service } = serviceFor({ stamps: forEveryRung('expired'), members });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.equal(result.missing.length, DEFAULT_ABR_RUNGS.length);
    assert.ok(
      result.missing
        .find((m) => m.rung === '1080p')
        ?.reason.includes('no member'),
    );
  });
});

/** The tester's 1080p batch on 2026-09-24: 128 chunks a bucket, the fullest holding all 128. */
const FULL_IMMUTABLE: BatchFill = { depth: 23, bucketDepth: 16, utilization: 128, immutableFlag: true };

describe('beePublishersForGroup — how full each batch is', () => {
  it('refuses the value while a rung’s immutable batch is full, as its node does', async () => {
    const { service } = serviceFor({ fills: { [`${GROUP.name}-1080p`]: FULL_IMMUTABLE } });
    const result = await service.beePublishersForGroup(GROUP.id);

    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.deepEqual(result.missing.map((m) => m.rung), ['1080p']);
    assert.equal(result.rungs.find((r) => r.rung === '1080p')?.stampState, 'full');
  });

  it('carries each rung’s fill and immutability, so the pages can show them', async () => {
    const { service } = serviceFor({
      fills: {
        [`${GROUP.name}-1080p`]: FULL_IMMUTABLE,
        [`${GROUP.name}-720p`]: { ...FULL_IMMUTABLE, utilization: 32, immutableFlag: false },
      },
    });
    const result = await service.beePublishersForGroup(GROUP.id);
    const rung = (name: string) => result.rungs.find((r) => r.rung === name);

    assert.equal(rung('1080p')?.stampFillRatio, 1);
    assert.equal(rung('1080p')?.stampImmutable, true);
    assert.equal(rung('720p')?.stampFillRatio, 0.25);
    assert.equal(rung('720p')?.stampImmutable, false);
    assert.equal(rung('360p')?.stampFillRatio, null);
    assert.equal(rung('360p')?.stampImmutable, null);
  });

  it('warns about a nearly full immutable rung and still hands the value over', async () => {
    const { service } = serviceFor({
      fills: { [`${GROUP.name}-1080p`]: { ...FULL_IMMUTABLE, utilization: 122 } },
    });
    const result = await service.beePublishersForGroup(GROUP.id);

    assert.equal(result.ready, true);
    assert.ok(result.value);
    assert.deepEqual(result.warnings.map((w) => w.rung), ['1080p']);
    assert.match(result.warnings[0]!.reason, /95% full/);
  });
});

describe('beePublishersForGroup — rung address and status', () => {
  it('refuses a rung whose node is not running', async () => {
    const members = DEFAULT_ABR_RUNGS.map(member).map((p) =>
      p.name.endsWith('-720p') ? { ...p, status: 'STOPPED' as const } : p,
    );
    const { service } = serviceFor({ members });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.equal(result.value, null);
    assert.deepEqual(
      result.missing.map((m) => m.rung),
      ['720p'],
    );
  });

  // BEE_LOCAL_HOST=127.0.0.1, or a native manager: every rung composes to
  // http://127.0.0.1:100N5, which works nowhere but the manager's own machine,
  // and used to be served as finished.
  it('refuses a loopback address without needing a probe to say so', async () => {
    const { service } = serviceFor({ urls: forEveryRung('loopback') });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.equal(result.missing.length, DEFAULT_ABR_RUNGS.length);
    assert.ok(result.missing.every((m) => m.reason.includes('BEE_LOCAL_HOST')));
  });

  // An uploader is a container on this host and T06 binds every local bee API to
  // the docker bridge, so a local rung carries the bridge address and never the
  // manager's public one, which answers on those ports from nowhere at all.
  it('composes a local rung from the address a container here reaches it on', async () => {
    const members = DEFAULT_ABR_RUNGS.map(member).map((p) => ({ ...p, host: 'localhost' }));
    const { service, askedUrls } = serviceFor({ members, localHost: '10.200.0.1' });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.ok(
      result.rungs.every((r) => r.url.startsWith('http://10.200.0.1:')),
      JSON.stringify(result.rungs.map((r) => r.url)),
    );
    assert.ok(askedUrls.every((u) => u.startsWith('http://10.200.0.1:')));
  });

  it('leaves a rung on a declared remote host at that host’s own address', async () => {
    const { service } = serviceFor();
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.ok(
      result.rungs.every((r) => r.url.startsWith('http://10.0.0.9:')),
      JSON.stringify(result.rungs.map((r) => r.url)),
    );
  });

  it('reads the local address once for the whole pool', async () => {
    const members = DEFAULT_ABR_RUNGS.map(member).map((p) => ({ ...p, host: 'localhost' }));
    const { service, localHostReads } = serviceFor({ members });
    await service.beePublishersForGroup(GROUP.id);
    assert.equal(localHostReads(), 1);
  });

  it('refuses an ssh target used as an address', async () => {
    const { service } = serviceFor({
      urls: { [`${GROUP.name}-480p`]: 'ssh-target' },
    });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.missing.map((m) => m.rung),
      ['480p'],
    );
  });

  // Hairpinning explains a failed probe of a public address just as well as a
  // wrong one, so this warns and still hands the value over.
  it('warns but still emits the value when nothing answered at an address', async () => {
    const { service } = serviceFor({
      urls: { [`${GROUP.name}-360p`]: 'unreachable' },
    });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.ok(result.value);
    assert.deepEqual(
      result.warnings.map((w) => w.rung),
      ['360p'],
    );
  });

  it('survives a url probe that throws, treating that address as unchecked', async () => {
    const groupRepo = {
      findById: async () => GROUP,
      listMembers: async () => DEFAULT_ABR_RUNGS.map(member),
    } as unknown as DeploymentGroupRepository;
    const service = new ProfileService(
      {} as ProfileRepository,
      {} as ContainerRepository,
      {} as DeploymentOrchestrator,
      {} as EventBus,
      groupRepo,
      {} as StackVersionRepository,
      localTargets(),
      async () => healthOf('active'),
      async () => {
        throw new Error('dns exploded');
      },
    );

    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.ok(result.rungs.every((r) => r.urlState === 'unknown'));
  });

  it('warns while a batch is alive but nearly spent', async () => {
    const { service } = serviceFor({
      ttls: { [`${GROUP.name}-1080p`]: 4 * 3_600 },
    });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(result.ready, true);
    assert.deepEqual(
      result.warnings.map((w) => w.rung),
      ['1080p'],
    );
    assert.ok(result.warnings[0]!.reason.includes('4h'));
  });

  it('carries each rung’s TTL through for the UI to show', async () => {
    const { service } = serviceFor({
      ttls: { [`${GROUP.name}-360p`]: 12 * 3_600 },
    });
    const result = await service.beePublishersForGroup(GROUP.id);
    assert.equal(
      result.rungs.find((r) => r.rung === '360p')?.stampTtl,
      12 * 3_600,
    );
  });
});
