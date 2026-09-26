/**
 * What a deployment's next deploy would give its containers, worked out
 * without deploying, against what a deploy actually recorded.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The page says how many settings a running deployment is behind on by
 * comparing this preview with each container's record. Any gap between how the
 * preview works a value out and how a deploy does would show as a setting
 * behind that is not, on every deployment, straight after its deploy. So the
 * one test that matters is that a deploy followed by a preview shows nothing
 * behind, on a deployment that exercises every source of a value.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { makeProfile } from '../support/profileFixtures.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const root = join(mkdtempSync(join(tmpdir(), 'next-deploy-env-')), 'stack');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { recordedStateOf } = await import('../../src/domain/settings/runningRecord.js');

const STAMP = 'a'.repeat(64);
const STREAM_KEY = `0x${'e'.repeat(64)}`;
const PASSPHRASE = 'synthetic-passphrase-0123';

const CONTRACT: StackContract = {
  ...structuredClone(ALLOCATION_CONTRACT),
  requiredSecrets: ['API_AUTH_TOKEN'],
  serviceEnvKeys: {
    'stream-uploader': ['API_AUTH_TOKEN', 'API_PORT', 'LOG_LEVEL', 'STAMP', 'STREAM_KEY', 'STREAM_LIST_TOPIC', 'UPLOADER_START_GATES'],
    srs: ['SRS_ADAPTER_PORT', 'SRS_MEDIA_PATH', 'SRS_SRT_PORT', 'SRT_LATENCY', 'SRT_PASSPHRASE'],
    'bee-uploader': ['BEE_UPLOADER_DATA_DIR', 'RPC_ENDPOINT'],
  },
};

function writeVersion(): void {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\nLOG_LEVEL=info\nCOMPOSE_NETWORK=\nAPI_AUTH_TOKEN=\n', 'utf8');
  writeFileSync(join(root, '.env.sample'), 'LOG_LEVEL=debug\nCOMPOSE_NETWORK=\nAPI_AUTH_TOKEN=\n', 'utf8');
  writeFileSync(join(root, 'engines', 'srs', '.env'), 'SRT_LATENCY=\nSRS_MEDIA_PATH=../../engines/srs/media\nSRS_WEBHOOK_TOKEN=version-token\n', 'utf8');
}

async function deployed() {
  writeVersion();
  const stored = makeProfile({
    name: 'stage',
    port_slot: 3,
    stamp_id: STAMP,
    feed_topic: 'stage-topic',
    has_private_key: true,
    has_srt_passphrase: true,
  });
  const harness = orchestratorHarness([stored]);
  await harness.versions.setContract(1, structuredClone(CONTRACT));
  harness.profiles.stackSettings.set('stage', { LOG_LEVEL: 'debug', COMPOSE_NETWORK: 'host' });
  harness.profiles.privateKeys.set('stage', STREAM_KEY);
  harness.profiles.passphrases.set('stage', PASSPHRASE);

  await harness.orchestrator.startDeploy(stored, undefined);
  harness.runner.finish(0);
  await untilRunning(harness.profiles, 'stage');
  return harness;
}

describe('the environment the next deploy gives', () => {
  it('matches what every container was recorded with, straight after a deploy', async () => {
    const harness = await deployed();

    const { env } = await harness.orchestrator.nextEnvFor(harness.profiles.rows.get('stage')!);

    assert.ok(harness.containers.snapshots.length >= 3, 'the deploy recorded its containers');
    for (const snapshot of harness.containers.snapshots) {
      for (const key of Object.keys(snapshot.envDigests)) {
        const record = { env_salt: snapshot.envSalt, env_digests: snapshot.envDigests };
        assert.equal(recordedStateOf(record, key, env[key]), 'same', `${snapshot.service} ${key}`);
      }
    }
  });

  it('names the generated secret it read, and a stored value in its place', async () => {
    const harness = await deployed();
    const profile = harness.profiles.rows.get('stage')!;

    assert.deepEqual((await harness.orchestrator.nextEnvFor(profile)).generatedKeys, ['API_AUTH_TOKEN']);

    harness.profiles.stackSettings.set('stage', { API_AUTH_TOKEN: 'b'.repeat(64) });
    const next = await harness.orchestrator.nextEnvFor(profile);

    assert.deepEqual(next.generatedKeys, []);
    assert.equal(next.env.API_AUTH_TOKEN, 'b'.repeat(64));
  });

  it('shows a value stored since the deploy as the one difference', async () => {
    const harness = await deployed();
    harness.profiles.stackSettings.set('stage', { LOG_LEVEL: 'warn', COMPOSE_NETWORK: 'host' });

    const { env } = await harness.orchestrator.nextEnvFor(harness.profiles.rows.get('stage')!);
    const uploader = harness.containers.snapshots.find((snapshot) => snapshot.service === 'stream-uploader')!;
    const record = { env_salt: uploader.envSalt, env_digests: uploader.envDigests };
    const differing = Object.keys(uploader.envDigests).filter((key) => recordedStateOf(record, key, env[key]) === 'differs');

    assert.deepEqual(differing, ['LOG_LEVEL']);
  });

  it('writes nothing and generates nothing', async () => {
    writeVersion();
    const stored = makeProfile({ name: 'fresh', port_slot: 4, stamp_id: STAMP });
    const harness = orchestratorHarness([stored]);
    await harness.versions.setContract(1, structuredClone(CONTRACT));

    const next = await harness.orchestrator.nextEnvFor(stored);

    assert.equal(existsSync(join(root, '.env.fresh')), false);
    assert.equal(harness.profiles.secrets.get('fresh'), undefined);
    assert.equal(next.env.API_AUTH_TOKEN, '');
    assert.deepEqual(next.generatedKeys, []);
  });
});
