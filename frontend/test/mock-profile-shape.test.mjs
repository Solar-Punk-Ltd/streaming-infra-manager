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
