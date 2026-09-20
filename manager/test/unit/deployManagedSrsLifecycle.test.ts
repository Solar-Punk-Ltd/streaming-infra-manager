import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ManagedSrsLifecycleConfig } from '../../src/utils/config.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile } from '../support/profileFixtures.js';

const root = throwawayRoot('managed-srs-deploy-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

const TOKEN = 'managed-srs-fixture-token-at-least-32-bytes';
const INSTANCE_ID = '11111111-2222-4333-8444-555555555555';
const managed: ManagedSrsLifecycleConfig = {
  lifecycleVersion: 1,
  adminApiUrl: 'http://admin.internal',
  adminApiToken: TOKEN,
};

function lineFor(contents: string, key: string): string | undefined {
  return contents.split('\n').find(line => line.startsWith(`${key}=`));
}

function harness(name: string, kind: 'streamer' | 'viewer' = 'streamer') {
  writeFileSync(
    join(root, '.env'),
    [
      'ENGINE=srs',
      'SRS_LIFECYCLE_VERSION=1',
      'SRS_UPLOADER_ID=stale-uploader',
      'ADMIN_API_URL=http://stale-admin.internal',
      'ADMIN_API_TOKEN=stale-managed-token-at-least-32-bytes',
      '',
    ].join('\n'),
  );
  const profile = makeProfile({
    name,
    kind,
    instance_id: INSTANCE_ID,
    stamp_id: 'a'.repeat(64),
  });
  const result = orchestratorHarness(
    [profile],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    managed,
  );
  return { ...result, profile };
}

describe('managed SRS lifecycle deploy environment', () => {
  it('writes the stable deployment instance only for a verified capable stack', async () => {
    const result = harness('managed');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await result.orchestrator.startDeploy(result.profile, undefined);
    const contents = readFileSync(join(root, '.env.managed'), 'utf8');

    assert.equal(
      lineFor(contents, 'SRS_LIFECYCLE_VERSION'),
      'SRS_LIFECYCLE_VERSION=1',
    );
    assert.equal(
      lineFor(contents, 'SRS_UPLOADER_ID'),
      `SRS_UPLOADER_ID=${INSTANCE_ID}`,
    );
    assert.equal(
      lineFor(contents, 'ADMIN_API_URL'),
      'ADMIN_API_URL=http://admin.internal',
    );
    assert.equal(lineFor(contents, 'ADMIN_API_TOKEN'), `ADMIN_API_TOKEN=${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(result.runner.runs), new RegExp(TOKEN));
  });

  it('clears stale managed settings for a stack without the capability', async () => {
    const result = harness('legacy');

    await result.orchestrator.startDeploy(result.profile, undefined);
    const contents = readFileSync(join(root, '.env.legacy'), 'utf8');

    assert.equal(
      lineFor(contents, 'SRS_LIFECYCLE_VERSION'),
      'SRS_LIFECYCLE_VERSION=',
    );
    assert.equal(lineFor(contents, 'SRS_UPLOADER_ID'), 'SRS_UPLOADER_ID=');
    assert.equal(lineFor(contents, 'ADMIN_API_URL'), 'ADMIN_API_URL=');
    assert.equal(lineFor(contents, 'ADMIN_API_TOKEN'), 'ADMIN_API_TOKEN=');
  });

  it('does not give the boundary to a capable stack profile without an SRS uploader', async () => {
    const result = harness('reader', 'viewer');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await result.orchestrator.startDeploy(result.profile, undefined);
    const contents = readFileSync(join(root, '.env.reader'), 'utf8');

    assert.equal(lineFor(contents, 'SRS_LIFECYCLE_VERSION'), 'SRS_LIFECYCLE_VERSION=');
    assert.equal(lineFor(contents, 'SRS_UPLOADER_ID'), 'SRS_UPLOADER_ID=');
    assert.equal(lineFor(contents, 'ADMIN_API_URL'), 'ADMIN_API_URL=');
    assert.equal(lineFor(contents, 'ADMIN_API_TOKEN'), 'ADMIN_API_TOKEN=');
  });
});
