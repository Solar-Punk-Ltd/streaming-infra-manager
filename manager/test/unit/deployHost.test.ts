/**
 * Resolving a deploy target into a network address.
 *
 * Unit test — no ssh is ever run: every case injects the `ssh -G` step, which is
 * the whole reason `createNetworkHostResolver` takes one.
 *
 * `profiles.host` is a deploy target, and deploy.sh only ever hands it to `ssh`.
 * The manager also composes HTTP URLs from it, and an ssh alias is not an
 * address — `http://vultr-eu-1:10055` resolves nowhere, so the probes time out
 * and a BEE_PUBLISHERS entry built from it is unusable on the host that gets it.
 * These pin the same semantics deploy/scripts/_lib.sh's `host_from_target` has,
 * plus the two things a shell function does not have to care about: an exec
 * boundary that must not trust its input, and a cache.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createNetworkHostResolver,
  resolveNetworkHost,
} from '../../src/utils/deployHost.js';

/** An `ssh -G` dump, trimmed to the shape the parser cares about. */
function dump(hostname: string, name = 'alias'): string {
  return ['user deploy', `hostname ${hostname}`, 'port 22', `host ${name}`, ''].join(
    '\n',
  );
}

/** A resolver plus the list of names its exec was actually asked about. */
function withExec(
  exec: (name: string) => string,
  ttlMs = 60_000,
  clock = { now: 0 },
) {
  const calls: string[] = [];
  const resolve = createNetworkHostResolver({
    exec: (name) => {
      calls.push(name);
      return exec(name);
    },
    now: () => clock.now,
    ttlMs,
  });
  return { resolve, calls, clock };
}

describe('resolveNetworkHost', () => {
  it('resolves an ssh alias through the ssh config, as deploy.sh does', () => {
    const { resolve, calls } = withExec(() => dump('108.61.171.132'));
    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
    assert.deepEqual(calls, ['vultr-eu-1']);
  });

  it('drops ssh user info and resolves what is left', () => {
    // The account half addresses a login, never the bee API — and a stray `@`
    // lands inside the BEE_PUBLISHERS entry format, which splits on `@`.
    const { resolve, calls } = withExec(() => dump('108.61.171.132'));
    assert.equal(resolve('deploy@vultr-eu-1'), '108.61.171.132');
    assert.deepEqual(calls, ['vultr-eu-1']);
  });

  it('keeps an unknown name, which ssh echoes straight back', () => {
    // `ssh -G nope` prints `hostname nope`: that is "no Host block matched",
    // not "resolves to itself", and the name is still the operator's best guess.
    const { resolve } = withExec((name) => dump(name, name));
    assert.equal(resolve('nope'), 'nope');
  });

  it('keeps the name when ssh fails, rather than throwing', () => {
    const { resolve } = withExec(() => {
      throw new Error('ssh: command not found');
    });
    assert.equal(resolve('vultr-eu-1'), 'vultr-eu-1');
  });

  it('keeps the name when the dump carries no hostname line', () => {
    const { resolve } = withExec(() => 'user deploy\nport 22\n');
    assert.equal(resolve('vultr-eu-1'), 'vultr-eu-1');
  });

  it('takes literals and dotted names as given, without running ssh', () => {
    const { resolve, calls } = withExec(() => dump('should-not-be-used'));
    assert.equal(resolve('108.61.171.132'), '108.61.171.132');
    assert.equal(resolve('bee1.example.org'), 'bee1.example.org');
    assert.equal(resolve('::1'), '::1');
    assert.equal(resolve('fe80::1'), 'fe80::1');
    assert.equal(resolve('deploy@108.61.171.132'), '108.61.171.132');
    assert.deepEqual(calls, []);
  });

  it('takes the local sentinels as given, without running ssh', () => {
    // Callers map these to a locally reachable host themselves; `native` is
    // swarm-hls-stream's "outside compose" marker and no host at all.
    const { resolve, calls } = withExec(() => dump('should-not-be-used'));
    for (const local of ['', 'localhost', '127.0.0.1', '0.0.0.0', 'native']) {
      assert.equal(resolve(local), local);
    }
    assert.deepEqual(calls, []);
  });

  it('refuses to exec anything that is not a plain name', () => {
    // The column is schema-validated, but this is an exec boundary: ssh has no
    // `--`, so a leading dash would arrive as an option rather than a host.
    const { resolve, calls } = withExec(() => dump('should-not-be-used'));
    for (const hostile of [
      '-oProxyCommand=whoami',
      'alias;whoami',
      'alias name',
      'alias$(whoami)',
    ]) {
      assert.equal(resolve(hostile), hostile);
    }
    assert.deepEqual(calls, []);
  });

  it('caches within the TTL and looks again once it lapses', () => {
    // The ssh config is a bind mount an operator can edit without restarting
    // the api, so the entry has to go stale on its own.
    const clock = { now: 1_000 };
    const { resolve, calls } = withExec(
      () => dump('108.61.171.132'),
      60_000,
      clock,
    );

    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
    clock.now += 59_000;
    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
    assert.deepEqual(calls, ['vultr-eu-1']);

    clock.now += 2_000;
    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
    assert.deepEqual(calls, ['vultr-eu-1', 'vultr-eu-1']);
  });

  it('caches a failed lookup too, so a bad name costs one fork per TTL', () => {
    const { resolve, calls } = withExec(() => {
      throw new Error('nope');
    });
    assert.equal(resolve('vultr-eu-1'), 'vultr-eu-1');
    assert.equal(resolve('vultr-eu-1'), 'vultr-eu-1');
    assert.deepEqual(calls, ['vultr-eu-1']);
  });

  it('caches per name, not across them', () => {
    const hosts: Record<string, string> = {
      'vultr-eu-1': '108.61.171.132',
      'vultr-eu-2': '108.61.171.133',
    };
    const { resolve } = withExec((name) => dump(hosts[name] ?? name));
    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
    assert.equal(resolve('vultr-eu-2'), '108.61.171.133');
    assert.equal(resolve('vultr-eu-1'), '108.61.171.132');
  });

  it('answers on the shared resolver without consulting ssh for these', () => {
    // The default export runs real ssh, so only the cases that provably stay
    // off it are asserted here — the resolution itself is covered above.
    assert.equal(resolveNetworkHost(' 108.61.171.132 '), '108.61.171.132');
    assert.equal(
      resolveNetworkHost('deploy@bee1.example.org'),
      'bee1.example.org',
    );
    assert.equal(resolveNetworkHost(''), '');
  });
});
