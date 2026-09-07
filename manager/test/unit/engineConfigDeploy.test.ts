/**
 * How a deployment's own engine config reaches the container.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The stack's compose override mounts whatever path SRS_CONF_FILE names, so
 * two things have to hold at every deploy: the stored file is on disk at that
 * path, in the deployment's data directory which is bind-mounted into the api
 * container at the same absolute path, and the key is in `.env.<profile>`.
 * And on a version that has no such override the key must stay out, or a
 * later version that does have one would pick up a file nobody applied.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

const root = mkdtempSync(join(tmpdir(), 'engine-config-deploy-'));
const dataRoot = join(root, 'data');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = dataRoot;

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);
const { writeProfileEnv } = await import('../../src/utils/envUtils.js');

const WITH_HOOK: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
};

const CONFIG = 'listen 1935;\nhls_fragment HLS_FRAGMENT_PLACEHOLDER;\n';

function envLine(name: string, key: string): string | undefined {
  return readFileSync(join(root, `.env.${name}`), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${key}=`));
}

describe('writeProfileEnv and the config file key', () => {
  it('writes the key for the engine the deployment runs', () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

    writeProfileEnv(root, 'keyed', {
      engine: 'srs',
      engineConfigFile: '/data/keyed/engine/srs.conf',
    });

    assert.equal(envLine('keyed', 'SRS_CONF_FILE'), 'SRS_CONF_FILE=/data/keyed/engine/srs.conf');
    assert.equal(envLine('keyed', 'OME_CONF_FILE'), undefined);
  });

  it('refuses a path that is not a plain absolute one', () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

    assert.throws(
      () =>
        writeProfileEnv(root, 'odd', {
          engine: 'srs',
          engineConfigFile: 'engine/srs.conf',
        }),
      /not a plain absolute path/,
    );
    assert.throws(
      () =>
        writeProfileEnv(root, 'odd', {
          engine: 'srs',
          engineConfigFile: "/data/it's here/srs.conf",
        }),
      /not a plain absolute path/,
    );
  });
});

describe('a deploy with a stored config file', () => {
  it('writes the file into the data directory and names it in the env, on a version with the hook', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const harness = orchestratorHarness([]);
    await harness.versions.setContract(1, WITH_HOOK);
    const stored = makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64) });
    harness.profiles.rows.set('stage', stored);
    harness.profiles.engineConfigs.set('stage', CONFIG);

    await harness.orchestrator.startDeploy(stored, ['srs']);

    const file = join(dataRoot, 'stage', 'engine', 'srs.conf');
    assert.equal(readFileSync(file, 'utf8'), CONFIG);
    assert.equal(envLine('stage', 'SRS_CONF_FILE'), `SRS_CONF_FILE=${file}`);
  });

  it('leaves the key out and removes a stale file on a version without the hook', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const stored = makeProfile({ name: 'plain', stamp_id: 'a'.repeat(64) });
    const harness = orchestratorHarness([stored]);
    harness.profiles.engineConfigs.set('plain', CONFIG);
    const file = join(dataRoot, 'plain', 'engine', 'srs.conf');
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(dataRoot, 'plain', 'engine'), { recursive: true }),
    );
    writeFileSync(file, 'left over\n', 'utf8');

    await harness.orchestrator.startDeploy(stored, ['srs']);

    assert.equal(existsSync(file), false);
    assert.equal(envLine('plain', 'SRS_CONF_FILE'), undefined);
  });

  it('removes the file once the deployment is back on the template', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const harness = orchestratorHarness([]);
    await harness.versions.setContract(1, WITH_HOOK);
    const stored = makeProfile({ name: 'reset', stamp_id: 'a'.repeat(64) });
    harness.profiles.rows.set('reset', stored);
    harness.profiles.engineConfigs.set('reset', CONFIG);
    await harness.orchestrator.startDeploy(stored, ['srs']);
    harness.runner.finish(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.profiles.engineConfigs.delete('reset');

    await harness.orchestrator.startDeploy(harness.profiles.rows.get('reset')!, ['srs']);

    assert.equal(existsSync(join(dataRoot, 'reset', 'engine', 'srs.conf')), false);
    assert.equal(envLine('reset', 'SRS_CONF_FILE'), undefined);
  });
});
