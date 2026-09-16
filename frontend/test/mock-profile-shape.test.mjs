/**
 * The profile rows the dev mock serves have the shape the manager's rows have.
 *
 * Runs with the other suites here under `pnpm test:browser`, and needs no
 * browser: it reads the seeded state directly.
 *
 * The mock is what the pages are built against, so a field it answers and the
 * manager does not, or the other way round, is a page that works here and
 * breaks on a host. The stream signing key is the one that matters most. The
 * manager answers whether a deployment holds one and never the key itself,
 * because whoever holds it can publish to that feed for good.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { seed, state } from '../dev/mock-seed.mjs';

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
});
