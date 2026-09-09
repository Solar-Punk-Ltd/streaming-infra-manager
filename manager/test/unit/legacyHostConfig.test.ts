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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const carried = await carryOverLegacyHostConfig(configRoot, legacyRoot);

    assert.deepEqual(carried, ['.env', 'deploy/config.json']);
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

    assert.deepEqual(await carrying, [], 'a root with settings is past the migration');
    assert.equal(readFileSync(join(configRoot, '.env'), 'utf8'), settled);
    assert.equal(existsSync(join(configRoot, 'deploy', 'config.json')), false);
  });
});
