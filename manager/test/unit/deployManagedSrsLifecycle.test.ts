import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ManagedSrsLifecycleConfig } from '../../src/utils/config.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile } from '../support/profileFixtures.js';

const root = throwawayRoot('managed-srs-deploy-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');

const TOKEN = 'managed-srs-fixture-token-at-least-32-bytes';
const INSTANCE_ID = '11111111-2222-4333-8444-555555555555';
const STACK_DEPLOY_SCRIPT = join('deploy', 'scripts', 'deploy.sh');
const managed: ManagedSrsLifecycleConfig = {
  lifecycleVersion: 1,
  profile: 'managed',
  adminApiUrl: 'http://admin.internal',
  adminApiToken: TOKEN,
};

function lineFor(contents: string, key: string): string | undefined {
  return contents.split('\n').find(line => line.startsWith(`${key}=`));
}

function harness(
  name: string,
  kind: 'streamer' | 'viewer' = 'streamer',
  host: string | null = null,
  selectedProfile = name,
) {
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
    host,
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
    { ...managed, profile: selectedProfile },
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
      'ADMIN_API_URL=http://stale-admin.internal',
    );
    assert.equal(
      lineFor(contents, 'ADMIN_API_TOKEN'),
      'ADMIN_API_TOKEN=stale-managed-token-at-least-32-bytes',
    );
    assert.doesNotMatch(contents, new RegExp(TOKEN));
    assert.equal(result.runner.runs[0]?.options.env?.ADMIN_API_URL, 'http://admin.internal');
    assert.equal(result.runner.runs[0]?.options.env?.ADMIN_API_TOKEN, TOKEN);
    assert.doesNotMatch(result.runner.runs[0]?.args.join(' ') ?? '', new RegExp(TOKEN));
    assert.equal(result.runner.runs[0]?.options.withholdOutput, true);
  });

  it('deploys the managed profile through the stack deploy script with its managed settings', async () => {
    const result = harness('managed');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await result.orchestrator.startDeploy(result.profile, undefined);

    assert.equal(result.runner.runs.length, 1);
    const run = result.runner.runs[0]!;
    assert.ok(run.script.endsWith(STACK_DEPLOY_SCRIPT), `ran ${run.script}`);
    assert.ok(run.args.includes('--profile=managed'), `args ${run.args.join(' ')}`);
    assert.equal(run.options.env?.ADMIN_API_URL, 'http://admin.internal');
    assert.equal(run.options.env?.ADMIN_API_TOKEN, TOKEN);
    assert.equal(run.options.withholdOutput, true);
    const contents = readFileSync(join(root, '.env.managed'), 'utf8');
    assert.equal(lineFor(contents, 'SRS_LIFECYCLE_VERSION'), 'SRS_LIFECYCLE_VERSION=1');
    assert.equal(lineFor(contents, 'SRS_UPLOADER_ID'), `SRS_UPLOADER_ID=${INSTANCE_ID}`);
  });

  it('keeps unrelated capable SRS profiles legacy', async () => {
    const result = harness('unrelated-srs', 'streamer', null, 'managed');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await result.orchestrator.startDeploy(result.profile, undefined);
    const contents = readFileSync(join(root, '.env.unrelated-srs'), 'utf8');

    assert.equal(lineFor(contents, 'SRS_LIFECYCLE_VERSION'), 'SRS_LIFECYCLE_VERSION=');
    assert.equal(lineFor(contents, 'SRS_UPLOADER_ID'), 'SRS_UPLOADER_ID=');
    assert.equal(result.runner.runs[0]?.options.env?.ADMIN_API_TOKEN, undefined);
  });

  it('keeps the selected profile instance identity across a retry', async () => {
    const result = harness('managed');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await result.orchestrator.startDeploy(result.profile, undefined);
    result.runner.finish(0);
    await untilRunning(result.profiles, result.profile.name);
    await result.orchestrator.startDeploy(result.profiles.rows.get(result.profile.name)!, undefined);

    const contents = readFileSync(join(root, '.env.managed'), 'utf8');
    assert.equal(lineFor(contents, 'SRS_UPLOADER_ID'), `SRS_UPLOADER_ID=${INSTANCE_ID}`);
    assert.equal(result.runner.runs.length, 2);
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
    assert.equal(
      lineFor(contents, 'ADMIN_API_URL'),
      'ADMIN_API_URL=http://stale-admin.internal',
    );
    assert.equal(
      lineFor(contents, 'ADMIN_API_TOKEN'),
      'ADMIN_API_TOKEN=stale-managed-token-at-least-32-bytes',
    );
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
    assert.equal(
      lineFor(contents, 'ADMIN_API_URL'),
      'ADMIN_API_URL=http://stale-admin.internal',
    );
    assert.equal(
      lineFor(contents, 'ADMIN_API_TOKEN'),
      'ADMIN_API_TOKEN=stale-managed-token-at-least-32-bytes',
    );
  });

  it('refuses a managed remote deploy before generating a file or starting a script', async () => {
    const result = harness('remote-managed', 'streamer', 'edge');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    await assert.rejects(
      result.orchestrator.startDeploy(result.profile, undefined),
      /managed SRS lifecycle.*remote target.*not configured/i,
    );

    assert.equal(result.runner.runs.length, 0);
    assert.equal(existsSync(join(root, '.env.remote-managed')), false);
  });
});
