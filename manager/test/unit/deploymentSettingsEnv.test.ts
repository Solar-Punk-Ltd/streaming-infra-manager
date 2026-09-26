/**
 * A deployment's own stack settings, on their way into its env file.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Every key a deployment's build declares is editable per deployment (Levi,
 * 2026-09-25). What the operator stores is written into `.env.<profile>` over
 * the version's base `.env`, and the keys the manager decides itself are
 * written after it, so a stored value can never take the manager's place. Those
 * keys are decided by a control of their own: the stamp, the node pool, the
 * chain endpoint, a port slot. A value stored for one of them is left out of
 * the file rather than refused, because the manager's line would win anyway and
 * a refusal would stop every deploy over a value nothing uses.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { makeProfile } from '../support/profileFixtures.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import type { OrchestratorHarness } from '../support/orchestratorHarness.js';

const root = join(mkdtempSync(join(tmpdir(), 'deployment-settings-')), 'stack');
mkdirSync(root);
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { managedEnvLines, renderProfileEnv } = await import('../../src/utils/envUtils.js');
const { settingOwnerOf } = await import('../../src/domain/settings/settingOwners.js');
const { settingDigest, unsetDigest } = await import('../../src/domain/settings/runningRecord.js');

const STAMP = 'a'.repeat(64);
const OTHER_STAMP = 'b'.repeat(64);
const BATCH = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map((rung, i) => `${rung}@http://10.0.0.1:${10015 + i * 10}<${BATCH(rung)}>`)
  .join(' ');
const NO_PORTS = { ports: [], isLocalTarget: false };

function envLine(name: string, key: string): string | undefined {
  return readFileSync(join(root, `.env.${name}`), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${key}=`));
}

describe('a stored value in the rendered env file', () => {
  it('replaces the base line where it stands', () => {
    const text = renderProfileEnv('LOG_LEVEL=info\nSTAMP_DEPTH=22\n', {}, { LOG_LEVEL: 'debug' });

    assert.equal(text, 'LOG_LEVEL=debug\nSTAMP_DEPTH=22\n');
  });

  it('is appended when the base does not set the key', () => {
    const text = renderProfileEnv('LOG_LEVEL=info\n', {}, { CHEQUEBOOK_MIN_BZZ: '1.5' });

    assert.equal(text, 'LOG_LEVEL=info\nCHEQUEBOOK_MIN_BZZ=1.5\n');
  });

  it('gives way to the line the manager writes for the same key', () => {
    const text = renderProfileEnv('STAMP=\n', { STAMP }, { STAMP: OTHER_STAMP });

    assert.equal(text, `STAMP=${STAMP}\n`);
  });

  it('is refused by its key, never by its value, when the stack would read it differently', () => {
    const marker = ' synthetic-marker';

    assert.throws(
      () => renderProfileEnv('', {}, { LOG_LEVEL: marker }),
      (error: Error) => /LOG_LEVEL/.test(error.message) && !error.message.includes(marker.trim()),
    );
  });

  it('refuses a secret the engine would read as sed syntax', () => {
    assert.throws(() => renderProfileEnv('', {}, { ADMIN_API_TOKEN: 'synthetic/token' }), /ADMIN_API_TOKEN/);
  });
});

describe('who decides a key', () => {
  it('names a control for every key the manager writes from a deployment of its own', () => {
    const srs = managedEnvLines(
      {
        engine: 'srs',
        stampId: STAMP,
        beePublishers: PUBLISHERS,
        rpcEndpoint: 'https://rpc.example.org',
        rpcEndpointSource: 'custom',
        gatewayMode: 'light',
        srtPassphrase: 'synthetic-passphrase-0123',
        streamKey: `0x${'cd'.repeat(32)}`,
        engineSettings: { HLS_FRAGMENT: '1' },
        engineConfigFile: '/data/stage/engine/srs-0123456789ab.conf',
        localBeeUploader: true,
      },
      '',
    );
    const ome = managedEnvLines(
      { engine: 'ome', beeUrl: 'http://10.0.0.1:1633', omeSrtPort: 10180, omeHlsPort: 10181, localBeeUploader: false, gatewayMode: 'ultra-light' },
      '',
    );
    const context = { ports: ALLOCATION_CONTRACT.ports, isLocalTarget: true };

    for (const key of [...Object.keys(srs), ...Object.keys(ome)]) {
      assert.notEqual(settingOwnerOf(key, context), null, key);
    }
  });

  it('leaves the operator the keys no control decides, a generated secret among them', () => {
    for (const key of ['LOG_LEVEL', 'UPLOADER_START_GATES', 'CHEQUEBOOK_MIN_BZZ', 'API_AUTH_TOKEN', 'ADMIN_API_URL']) {
      assert.equal(settingOwnerOf(key, NO_PORTS), null, key);
    }
  });

  it('gives a port of the version table to the slot, and a data directory to the manager on its own host only', () => {
    const port = ALLOCATION_CONTRACT.ports[0]!.name;

    assert.equal(settingOwnerOf(port, { ports: ALLOCATION_CONTRACT.ports, isLocalTarget: false }), 'port-slot');
    assert.equal(settingOwnerOf('BEE_UPLOADER_DATA_DIR', { ports: [], isLocalTarget: true }), 'data-dir');
    assert.equal(settingOwnerOf('BEE_UPLOADER_DATA_DIR', NO_PORTS), null);
  });
});

const REQUIRED = ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'];

const V3_CONTRACT: StackContract = {
  ports: [...ALLOCATION_CONTRACT.ports],
  maxSlot: 99,
  requiredSecrets: REQUIRED,
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: true, sharedImageTags: true },
  chequebookMinBzz: '0.5',
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
  allocationProblem: null,
};

async function versionRequiringSecrets(harness: OrchestratorHarness): Promise<number> {
  const row = await harness.versions.insert({ name: 'main-v3', gitRef: 'main-v3', rootPath: root });
  await harness.versions.markBuilt(row.id, { commitSha: 'abc1234', contract: V3_CONTRACT });
  return row.id;
}

describe('a deploy of a deployment with stored settings', () => {
  it('writes the stored value into the deployment env file', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\nLOG_LEVEL=info\n', 'utf8');
    const stored = makeProfile({ name: 'stage', stamp_id: STAMP });
    const harness = orchestratorHarness([stored]);
    harness.profiles.stackSettings.set('stage', { LOG_LEVEL: 'debug' });

    await harness.orchestrator.startDeploy(stored, undefined);

    assert.equal(envLine('stage', 'LOG_LEVEL'), 'LOG_LEVEL=debug');
  });

  it('keeps a stored value of a key the manager decides out of the file', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const stored = makeProfile({ name: 'stage', stamp_id: STAMP });
    const harness = orchestratorHarness([stored]);
    const slotted = ALLOCATION_CONTRACT.ports[0]!.name;
    harness.profiles.stackSettings.set('stage', {
      STAMP: OTHER_STAMP,
      BEE_PUBLISHERS: PUBLISHERS,
      [slotted]: '1',
    });

    await harness.orchestrator.startDeploy(stored, undefined);

    assert.equal(envLine('stage', 'STAMP'), `STAMP=${STAMP}`);
    // Neither is a key the manager writes for this deployment, so only the
    // ownership rule keeps them out: a pool this deployment has none of, and a
    // port its slot decides.
    assert.equal(envLine('stage', 'BEE_PUBLISHERS'), undefined);
    assert.equal(envLine('stage', slotted), undefined);
  });

  it('lets a stored generated secret take the place of the one the manager keeps', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const harness = orchestratorHarness([]);
    const v3 = await versionRequiringSecrets(harness);
    const stored = makeProfile({ name: 'stage', stamp_id: STAMP, stack_version_id: v3 });
    harness.profiles.rows.set('stage', stored);
    harness.profiles.stackSettings.set('stage', { API_AUTH_TOKEN: 'c'.repeat(64) });

    await harness.orchestrator.startDeploy(stored, undefined);

    assert.equal(envLine('stage', 'API_AUTH_TOKEN'), `API_AUTH_TOKEN=${'c'.repeat(64)}`);
    assert.match(envLine('stage', 'SRS_WEBHOOK_TOKEN') ?? '', /^SRS_WEBHOOK_TOKEN=[0-9a-f]{64}$/);
  });
});

describe('what a finished deploy records against each service', () => {
  it('records a stored setting against the service that reads it, and a secret as a digest alone', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const key = `0x${'e'.repeat(64)}`;
    const stored = makeProfile({ name: 'stage', stamp_id: STAMP, has_private_key: true });
    const harness = orchestratorHarness([stored]);
    await harness.versions.setContract(1, {
      ...structuredClone(ALLOCATION_CONTRACT),
      serviceEnvKeys: { 'stream-uploader': ['LOG_LEVEL', 'STREAM_KEY', 'UPLOADER_START_GATES'] },
    });
    harness.profiles.stackSettings.set('stage', { LOG_LEVEL: 'debug' });
    harness.profiles.privateKeys.set('stage', key);

    await harness.orchestrator.startDeploy(stored, ['stream-uploader']);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    const uploader = harness.containers.snapshots.find((snapshot) => snapshot.service === 'stream-uploader');
    assert.ok(uploader, 'the uploader has a record');
    assert.deepEqual(uploader.env, { LOG_LEVEL: 'debug' });
    assert.equal(uploader.envDigests.LOG_LEVEL, settingDigest(uploader.envSalt, 'LOG_LEVEL', 'debug'));
    assert.equal(uploader.envDigests.STREAM_KEY, settingDigest(uploader.envSalt, 'STREAM_KEY', key));
    // Set nowhere, so compose's own default applied, and the record says it was unset.
    assert.equal(uploader.envDigests.UPLOADER_START_GATES, unsetDigest(uploader.envSalt, 'UPLOADER_START_GATES'));
  });

  it('covers a key the version declares that no container reads, since it reached the deploy script', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\nCOMPOSE_NETWORK=\n', 'utf8');
    writeFileSync(join(root, '.env.sample'), 'LOG_LEVEL=debug\nCOMPOSE_NETWORK=\n', 'utf8');
    const stored = makeProfile({ name: 'stage', stamp_id: STAMP });
    const harness = orchestratorHarness([stored]);
    await harness.versions.setContract(1, {
      ...structuredClone(ALLOCATION_CONTRACT),
      serviceEnvKeys: { 'stream-uploader': ['LOG_LEVEL'] },
    });
    harness.profiles.stackSettings.set('stage', { COMPOSE_NETWORK: 'host' });

    await harness.orchestrator.startDeploy(stored, ['stream-uploader']);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    const uploader = harness.containers.snapshots.find((snapshot) => snapshot.service === 'stream-uploader');
    assert.ok(uploader, 'the uploader has a record');
    assert.equal(uploader.envDigests.COMPOSE_NETWORK, settingDigest(uploader.envSalt, 'COMPOSE_NETWORK', 'host'));
  });
});
