/**
 * The profile rows the dev mock serves have the shape the manager's rows have.
 *
 * Runs with the other suites here under `pnpm test:browser`, and needs no
 * browser: it reads the seeded state directly.
 *
 * The mock is what the pages are built against, so a field it answers and the
 * manager does not, or the other way round, is a page that works here and
 * breaks on a host. The two secrets are what matter most. The manager answers
 * whether a deployment holds a signing key and never the key, because whoever
 * holds it can publish to that feed for good. It answers whether a deployment
 * holds an SRT passphrase and never the passphrase on the row, because whoever
 * holds that can publish into the ingest, and it hands the value over one
 * deployment at a time to the page building a publish URL.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effectiveNodeMode,
  LIGHT_NODE_MODE,
  RPC_ENDPOINT_SOURCES,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import { seed, srtPassphraseOf, state } from '../dev/mock-seed.mjs';

seed();

describe('the profile rows the dev mock serves', () => {
  it('never carries the signing key', () => {
    const carrying = state.profiles
      .filter((profile) => 'private_key' in profile)
      .map((profile) => profile.name);

    assert.deepEqual(carrying, [], 'the manager answers no key, so neither does the mock');
  });

  it('says of every deployment whether it holds one', () => {
    for (const profile of state.profiles) {
      assert.equal(
        typeof profile.has_private_key,
        'boolean',
        `${profile.name} must say whether it holds a key`,
      );
    }
  });

  it('says yes for a stream that signs its own feed, and no for a viewer', () => {
    const holding = state.profiles
      .filter((profile) => profile.has_private_key)
      .map((profile) => profile.name);

    assert.ok(holding.includes('main-stage'), 'the main stage signs its own feed');
    assert.ok(!holding.includes('viewer-eu'), 'a viewer signs nothing');
  });

  it('never carries the SRT passphrase', () => {
    const carrying = state.profiles
      .filter((profile) => 'srt_passphrase' in profile)
      .map((profile) => profile.name);

    assert.deepEqual(
      carrying,
      [],
      'the manager answers no passphrase on the row, so neither does the mock',
    );
  });

  it('says of every deployment whether it holds one', () => {
    for (const profile of state.profiles) {
      assert.equal(
        typeof profile.has_srt_passphrase,
        'boolean',
        `${profile.name} must say whether it holds a passphrase`,
      );
    }
  });

  it('keeps the seeded passphrase where the reveal route can read it', () => {
    const holding = state.profiles
      .filter((profile) => profile.has_srt_passphrase)
      .map((profile) => profile.name);

    assert.ok(
      holding.includes('main-stage'),
      'the main stage publishes under a passphrase of its own',
    );
    for (const name of holding) {
      assert.equal(
        typeof srtPassphraseOf(name),
        'string',
        `${name} says it holds a passphrase, so one has to be there to reveal`,
      );
    }
  });

  it('answers nothing for a deployment on the host-wide passphrase', () => {
    const onTheHost = state.profiles.find(
      (profile) => !profile.has_srt_passphrase,
    );

    assert.ok(onTheHost, 'the seed has to hold one of each for this to say anything');
    assert.equal(srtPassphraseOf(onTheHost.name), null);
  });
});

describe('what the dev mock says about each deployment\'s Bee node', () => {
  it('says of every deployment where its node reaches the chain', () => {
    for (const profile of state.profiles) {
      assert.ok(
        RPC_ENDPOINT_SOURCES.includes(profile.rpc_endpoint_source),
        `${profile.name} must name one of the three sources, not ${profile.rpc_endpoint_source}`,
      );
    }
  });

  /**
   * The manager stores nothing for a deployment that never chose, and every
   * page reads such a row through `effectiveNodeMode`. A mock that filled the
   * column in would hide the one case every deployment made before T27 is in.
   */
  it('stores no mode for a deployment that was never asked', () => {
    for (const profile of state.profiles) {
      assert.ok(
        profile.node_mode === null || profile.node_mode === undefined ||
          profile.node_mode === LIGHT_NODE_MODE || profile.node_mode === ULTRA_LIGHT_NODE_MODE,
        `${profile.name} carries ${profile.node_mode}`,
      );
    }
  });

  it('reads a seeded stream as light and a seeded viewer as ultra-light', () => {
    const stream = state.profiles.find((profile) => profile.name === 'main-stage');
    const viewer = state.profiles.find((profile) => profile.name === 'viewer-eu');

    assert.equal(effectiveNodeMode(stream), LIGHT_NODE_MODE);
    assert.equal(effectiveNodeMode(viewer), ULTRA_LIGHT_NODE_MODE);
  });

  /**
   * The manager's own column pairing, mirrored here: the source `custom` and a
   * stored address travel together and only together, so a row can never say
   * it takes the manager's endpoint while carrying one of its own.
   */
  it('pairs a stored address with the custom source and with nothing else', () => {
    for (const profile of state.profiles) {
      assert.equal(
        profile.rpc_endpoint_source === 'custom',
        Boolean(profile.rpc_endpoint),
        `${profile.name} says ${profile.rpc_endpoint_source} and holds ${profile.rpc_endpoint}`,
      );
    }
  });
});
