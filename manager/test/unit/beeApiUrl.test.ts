/**
 * Composing a rung's bee API address.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * The port half is arithmetic and safe (`port_slot` is `CHECK BETWEEN 1 AND 999`,
 * so the slot-0 case where deploy.sh keeps the env's own ports cannot occur). The
 * host half is not: `profiles.host` holds a *deploy* target, validated to allow
 * `@` and documented as "localhost, an ssh alias, or user@host". Dropped verbatim
 * into `http://{host}:{port}` a `user@host` target yields an address that is not a
 * bee base URL — and whose stray `@` lands inside a BEE_PUBLISHERS entry format
 * that already separates the rung from the URL on `@`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeApiUrlFor, beePublicApiUrlFor } from '../../src/domain/StampService.js';
import { Profile } from '../../src/types/index.js';

function profile(over: Partial<Profile> = {}): Profile {
  return {
    name: 'stage-360p',
    port_slot: 5,
    kind: 'custom',
    notes: null,
    components: ['bee-uploader'],
    host: '65.108.40.58',
    feed_owner: null,
    feed_topic: null,
    private_key: null,
    public_key: null,
    stamp_id: null,
    status: 'RUNNING',
    last_error: null,
    last_error_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    group_id: 1,
    ...over,
  };
}

describe('beePublicApiUrlFor', () => {
  it('puts the node on 10005 + slot*10, matching deploy.sh’s port bands', () => {
    assert.equal(
      beePublicApiUrlFor(profile({ port_slot: 5 })),
      'http://65.108.40.58:10055',
    );
    assert.equal(
      beePublicApiUrlFor(profile({ port_slot: 8 })),
      'http://65.108.40.58:10085',
    );
  });

  it('strips ssh user info, which addresses an account and not the node', () => {
    assert.equal(
      beePublicApiUrlFor(profile({ host: 'deploy@65.108.40.58' })),
      'http://65.108.40.58:10055',
    );
  });

  it('leaves no stray @ for the entry format to trip over', () => {
    // `rung@url<batch>` splits on the first @; a second one in the URL makes the
    // entry ambiguous to any consumer that does not split exactly that way.
    const url = beePublicApiUrlFor(profile({ host: 'deploy@65.108.40.58' }));
    assert.equal(url.includes('@'), false);
  });

  it('resolves a stripped local target the same as a bare one', () => {
    // 'deploy@localhost' is still local, so it must take the public host too.
    const bare = beePublicApiUrlFor(profile({ host: 'localhost' }));
    assert.equal(beePublicApiUrlFor(profile({ host: 'deploy@localhost' })), bare);
  });

  it('leaves an ssh alias alone — it may well resolve for the uploader', () => {
    assert.equal(
      beePublicApiUrlFor(profile({ host: 'streamer1' })),
      'http://streamer1:10055',
    );
  });
});

describe('beeApiUrlFor', () => {
  it('strips ssh user info as well — the manager cannot use it either', () => {
    assert.equal(
      beeApiUrlFor(profile({ host: 'deploy@65.108.40.58' })),
      'http://65.108.40.58:10055',
    );
  });

  it('keeps resolving a local profile to a locally reachable host', () => {
    // Not the public host: the manager reaches a local node through the docker
    // host alias or loopback, which is exactly why the published URL needs its
    // own check.
    const url = beeApiUrlFor(profile({ host: 'localhost' }));
    assert.ok(
      url === 'http://127.0.0.1:10055' ||
        url === 'http://host.docker.internal:10055',
      url,
    );
  });
});
