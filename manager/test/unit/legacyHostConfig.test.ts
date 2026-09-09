/**
 * The bundled version's settings, taken once out of the tree the manager used
 * to ship them in.
 *
 * A host deployed before the stack was built here keeps the bundled stack's
 * base env, deploy config and engine envs in the legacy tree, and nothing has
 * ever copied them into the versions root. The first build takes them as the
 * config root's first revision. It is a migration, so it runs only into a
 * config root that holds nothing, and whether the root holds anything is a
 * question only the edit lock can answer.
 *
 * Unit test over a scratch directory. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { holdHostConfigLock, readHostConfigRevision } from '../../src/domain/versions/hostConfigCapture.js';
import { carryOverLegacyHostConfig } from '../../src/domain/versions/legacyHostConfig.js';

const LEGACY_ENV = 'STAMP=paid-for\nSTREAM_KEY=the-key\n';

let root: string;
let configRoot: string;
let legacyRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'legacy-host-config-'));
  configRoot = join(root, 'config');
  legacyRoot = join(root, 'legacy');
  mkdirSync(join(legacyRoot, 'deploy'), { recursive: true });
  writeFileSync(join(legacyRoot, '.env'), LEGACY_ENV);
  writeFileSync(join(legacyRoot, 'deploy', 'config.json'), '{"slots":3}\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('carrying the legacy settings over', () => {
  it('takes every file of the set as generation one, byte for byte', async () => {
    const { carried, skipped } = await carryOverLegacyHostConfig(configRoot, legacyRoot);

    assert.deepEqual(carried, ['.env', 'deploy/config.json']);
    assert.deepEqual(skipped, []);
    assert.equal(readFileSync(join(configRoot, '.env'), 'utf8'), LEGACY_ENV);
    assert.equal((await readHostConfigRevision(configRoot))?.generation, 1);
  });

  it('carries nothing into a config root an edit filled while it waited', async () => {
    mkdirSync(configRoot, { recursive: true });
    const release = await holdHostConfigLock(configRoot);
    const settled = 'STAMP=the-operator-set-this-here\n';

    const carrying = carryOverLegacyHostConfig(configRoot, legacyRoot);
    await sleep(50);
    writeFileSync(join(configRoot, '.env'), settled);
    await release();

    assert.deepEqual((await carrying).carried, [], 'a root with settings is past the migration');
    assert.equal(readFileSync(join(configRoot, '.env'), 'utf8'), settled);
    assert.equal(existsSync(join(configRoot, 'deploy', 'config.json')), false);
  });
});

describe('a legacy path that is not a regular file', () => {
  it('carries no symbolic link over, and names the one it passed by', async () => {
    const outside = join(root, 'somewhere-else.env');
    writeFileSync(outside, 'STAMP=whatever-that-link-points-at\n');
    rmSync(join(legacyRoot, '.env'));
    symlinkSync(outside, join(legacyRoot, '.env'));

    const { carried, skipped } = await carryOverLegacyHostConfig(configRoot, legacyRoot);

    assert.deepEqual(carried, ['deploy/config.json'], 'the regular file still comes over');
    assert.deepEqual(skipped, ['.env']);
    assert.equal(existsSync(join(configRoot, '.env')), false, 'nothing a link points at becomes a setting of this host');
  });

  it('reads nothing through a deploy directory that is a link, and names that too', async () => {
    const outside = join(root, 'somewhere-else');
    mkdirSync(outside);
    writeFileSync(join(outside, 'config.json'), '{"slots":99}\n');
    rmSync(join(legacyRoot, 'deploy'), { recursive: true });
    symlinkSync(outside, join(legacyRoot, 'deploy'));

    const { carried, skipped } = await carryOverLegacyHostConfig(configRoot, legacyRoot);

    assert.deepEqual(carried, ['.env']);
    assert.deepEqual(skipped, ['deploy']);
    assert.equal(existsSync(join(configRoot, 'deploy', 'config.json')), false);
  });

  it('reads no engine env through an engines directory that is a link, and names that too', async () => {
    const outside = join(root, 'somewhere-else');
    mkdirSync(join(outside, 'srs'), { recursive: true });
    writeFileSync(join(outside, 'srs', '.env'), 'SRT_PASSPHRASE=whatever-that-link-points-at\n');
    symlinkSync(outside, join(legacyRoot, 'engines'));

    const { carried, skipped } = await carryOverLegacyHostConfig(configRoot, legacyRoot);

    assert.deepEqual(carried, ['.env', 'deploy/config.json']);
    assert.deepEqual(skipped, ['engines']);
    assert.equal(existsSync(join(configRoot, 'engines')), false);
  });
});
