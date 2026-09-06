/**
 * How engine settings reach the engine container.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The same two behaviours the SRT passphrase has, for the same reasons. An
 * unset key must leave the host's base .env standing, because `.env.<profile>`
 * is a fresh copy of it on every deploy and writing our own defaults over it
 * would silently change a value somebody set on the box. And a value that
 * would corrupt the `sed` in `engines/srs/entrypoint.sh` must be refused here,
 * because this is the last gate before it leaves the manager and the container
 * crash-loops under `restart: unless-stopped` if it gets through.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { EngineSettings } from '@streaming-infra-manager/common';

// SUBMODULE resolves from SHLS_ROOT at module load, so the env var has to be
// set before envUtils is imported, hence the dynamic import in `before`.
const root = mkdtempSync(join(tmpdir(), 'engine-settings-'));
const previousRoot = process.env.SHLS_ROOT;

let writeProfileEnv: typeof import('../../src/utils/envUtils.js').writeProfileEnv;

before(async () => {
  process.env.SHLS_ROOT = root;
  ({ writeProfileEnv } = await import('../../src/utils/envUtils.js'));
});

after(() => {
  if (previousRoot === undefined) delete process.env.SHLS_ROOT;
  else process.env.SHLS_ROOT = previousRoot;
});

const BASE_ENV = 'ENGINE=srs\nHLS_FRAGMENT=6\nAPI_PORT=10000\n';

function withBaseEnv(contents: string = BASE_ENV): void {
  writeFileSync(join(root, '.env'), contents, 'utf8');
}

function envFor(name: string, engineSettings: EngineSettings): string {
  return readFileSync(
    writeProfileEnv(root, name, { engine: 'srs', engineSettings }),
    'utf8',
  );
}

describe('writeProfileEnv: engine settings', () => {
  it('writes what the profile set, over the host-wide value', () => {
    withBaseEnv();
    const env = envFor('tuned', { HLS_FRAGMENT: '2', HLS_WINDOW: '30' });

    assert.match(env, /^HLS_FRAGMENT=2$/m);
    assert.match(env, /^HLS_WINDOW=30$/m);
    // Upsert, not append: exactly one line for the key.
    assert.equal(env.match(/^HLS_FRAGMENT=/gm)?.length, 1);
    assert.match(env, /^API_PORT=10000$/m, 'the rest of .env must survive');
  });

  it('leaves the host-wide value standing for a key the profile does not set', () => {
    withBaseEnv();
    assert.match(envFor('untouched', {}), /^HLS_FRAGMENT=6$/m);
    assert.doesNotMatch(envFor('untouched', {}), /^HLS_WINDOW=/m);
  });

  it('adds a key the base .env has never carried', () => {
    withBaseEnv('ENGINE=srs\n');
    assert.match(envFor('added', { HLS_WINDOW: '45' }), /^HLS_WINDOW=45$/m);
  });

  it('writes only the keys the profile engine reads', () => {
    withBaseEnv('ENGINE=ome\n');
    const path = writeProfileEnv(root, 'omeone', {
      engine: 'ome',
      engineSettings: { HLS_SEGMENT_COUNT: '8' },
    });
    const env = readFileSync(path, 'utf8');
    assert.match(env, /^HLS_SEGMENT_COUNT=8$/m);
    assert.doesNotMatch(env, /^HLS_FRAGMENT=/m);
  });

  it('refuses a value that would corrupt the sed in entrypoint.sh', () => {
    withBaseEnv();
    for (const bad of ['1/2', '2 & 3', 'two"']) {
      assert.throws(
        () => envFor('bad', { HLS_FRAGMENT: bad }),
        /refusing to write the engine settings.*must be a positive number/s,
        `should refuse ${bad}`,
      );
    }
  });

  it('refuses a value outside the bounds the entrypoint would accept', () => {
    withBaseEnv();
    assert.throws(
      () => envFor('outofrange', { HLS_WINDOW: '9000' }),
      /refusing to write the engine settings.*Playlist window must be at most 600/s,
    );
  });

  it('skips a stored ABR setting on a deployment with no ladder', () => {
    // A rung setting stored while the ladder was on and left behind when the
    // pool string was cleared. Refusing it here would put every later deploy of
    // this profile into ERROR over a value no drawer renders, so the deploy goes
    // ahead and the key is simply not written. A new request carrying one is
    // still refused, by the request schema and by the settings route.
    withBaseEnv();
    const env = envFor('nolad', { ABR_FPS: '30', HLS_FRAGMENT: '2' });

    assert.doesNotMatch(env, /^ABR_FPS=/m);
    assert.match(env, /^HLS_FRAGMENT=2$/m, 'the rest still applies');
  });

  it('refuses a keyframe pair the engine would refuse to start on', () => {
    withBaseEnv();
    const publishers = ['1080p', '720p', '480p', '360p']
      .map(
        (rung, index) =>
          `${rung}@http://10.0.0.7:${10015 + index * 10}<${'a'.repeat(64)}>`,
      )
      .join(' ');
    assert.throws(
      () =>
        writeProfileEnv(root, 'ladder', {
          engine: 'srs',
          beePublishers: publishers,
          engineSettings: { ABR_FPS: '25', HLS_FRAGMENT: '1.5' },
        }),
      /37\.5 frames, which is not a whole number/,
    );
  });
});
