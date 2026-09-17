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
 * that already separates the rung from the URL on `@`. An alias is no better: it
 * is a key into an ssh config, so `http://vultr-eu-1:10055` resolves nowhere.
 *
 * Both are undone by `resolveNetworkHost`. How it resolves an alias is pinned in
 * deployHost.test.ts, where `ssh -G` is injected. Here the concern is only what
 * the URL composes to.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeApiUrlFor, beePublisherUrlFor } from '../../src/domain/StampService.js';
import { Profile } from '../../src/types/index.js';

function profile(over: Partial<Profile> = {}): Profile {
  return {
    name: 'stage-360p',
    port_slot: 5,
    kind: 'custom',
    notes: null,
    notes_revision: 0,
    components: ['bee-uploader'],
    host: '65.108.40.58',
    feed_owner: null,
    feed_topic: null,
    has_private_key: false,
    public_key: null,
    stamp_id: null,
    bee_publishers: null,
    bee_url: null,
    rpc_endpoint: null,
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
    group_id: 1,
    stack_version_id: 1,
    ...over,
  };
}

/**
 * The address a container on this host reaches a local node on, which is what the
 * resolver in localHost.ts answers and what a pool string carries. Injected here,
 * so composing a URL needs no Docker and no dns.
 */
const LOCAL_PUBLISHER_HOST = '10.200.0.1';

const publisherUrl = (over: Partial<Profile> = {}): string =>
  beePublisherUrlFor(profile(over), LOCAL_PUBLISHER_HOST);

describe('beePublisherUrlFor', () => {
  it('puts the node on 10005 + slot*10, matching deploy.sh’s port bands', () => {
    assert.equal(publisherUrl({ port_slot: 5 }), 'http://65.108.40.58:10055');
    assert.equal(publisherUrl({ port_slot: 8 }), 'http://65.108.40.58:10085');
  });

  it('strips ssh user info, which addresses an account and not the node', () => {
    assert.equal(
      publisherUrl({ host: 'deploy@65.108.40.58' }),
      'http://65.108.40.58:10055',
    );
  });

  it('leaves no stray @ for the entry format to trip over', () => {
    // `rung@url<batch>` splits on the first @; a second one in the URL makes the
    // entry ambiguous to any consumer that does not split exactly that way.
    const url = publisherUrl({ host: 'deploy@65.108.40.58' });
    assert.equal(url.includes('@'), false);
  });

  it('gives a local member the address a container on this host reaches it on', () => {
    // Not the public host. T06 binds every local bee API to the docker bridge, so
    // the public address answers on those ports from nowhere, and the uploader
    // handed this string is a container beside the manager.
    assert.equal(publisherUrl({ host: 'localhost' }), 'http://10.200.0.1:10055');
  });

  it('resolves a stripped local target the same as a bare one', () => {
    // 'deploy@localhost' is still local, so it must take the local host too.
    assert.equal(
      publisherUrl({ host: 'deploy@localhost' }),
      publisherUrl({ host: 'localhost' }),
    );
  });

  it('keeps a member on a declared remote host at that host’s own address', () => {
    // The T06 caveat: that node's api has to be bound somewhere this host reaches,
    // and the local address says nothing about a machine that is not this one.
    assert.equal(publisherUrl({ host: '65.108.40.58' }), 'http://65.108.40.58:10055');
  });

  it('keeps an alias no ssh config knows, rather than losing the host', () => {
    // The floor under resolution: a name nothing can resolve still composes to
    // the address it always did, so this can only improve on the old behaviour.
    assert.equal(
      publisherUrl({ host: 'no-such-ssh-alias-000' }),
      'http://no-such-ssh-alias-000:10055',
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
    // The manager's own read of a node, taken at process start from
    // BEE_LOCAL_HOST or the docker host alias, and separate from the address a
    // pool string publishes.
    const url = beeApiUrlFor(profile({ host: 'localhost' }));
    assert.ok(
      url === 'http://127.0.0.1:10055' ||
        url === 'http://host.docker.internal:10055',
      url,
    );
  });
});
