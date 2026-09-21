import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultServicesFor } from '@streaming-infra-manager/common';

import type { ManagedSrsLifecycleConfig } from '../../src/utils/config.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile, type ProfileFixture } from '../support/profileFixtures.js';

const root = throwawayRoot('managed-srs-deploy-');
process.env.SHLS_ROOT = root;
// A guarded uploader deploy copies the engine's sample into a profile env of
// its own, so the checkout needs the engine directory the stack ships.
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, 'engines', 'srs', '.env.sample'), 'SRS_HTTP_PORT=8080\n');

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { installReleaseGuard } = await import('../../src/releaseGuard/ReleaseGuardStore.js');

const TOKEN = 'managed-srs-fixture-token-at-least-32-bytes';
const INSTANCE_ID = '11111111-2222-4333-8444-555555555555';
const managed: ManagedSrsLifecycleConfig = {
  lifecycleVersion: 1,
  profile: 'managed',
  adminApiUrl: 'http://admin.internal',
  adminApiToken: TOKEN,
};

function lineFor(contents: string, key: string): string | undefined {
  return contents.split('\n').find(line => line.startsWith(`${key}=`));
}

/**
 * The guard installation a managed deployment goes through. Its one target
 * names the profile the lifecycle selects, the way the manager's own
 * installation does, so a deployment the lifecycle does not name finds no
 * target of its own and keeps the stack script.
 */
async function installedGuardFor(selected: ProfileFixture): Promise<string> {
  const stateRoot = mkdtempSync(join(root, 'release-state-'));
  const target = {
    profile: selected.name,
    portSlot: selected.port_slot,
    target: 'local' as const,
    services: [...defaultServicesFor(selected)].sort(),
  };
  await installReleaseGuard(
    stateRoot,
    undefined,
    selected.kind === 'viewer' ? { viewer: target } : { uploader: target },
  );
  return stateRoot;
}

async function harness(
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
    await installedGuardFor(
      selectedProfile === name ? profile : makeProfile({ name: selectedProfile }),
    ),
  );
  return { ...result, profile };
}

describe('managed SRS lifecycle deploy environment', () => {
  it('writes the stable deployment instance only for a verified capable stack', async () => {
    const result = await harness('managed');
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

  it('keeps unrelated capable SRS profiles legacy', async () => {
    const result = await harness('unrelated-srs', 'streamer', null, 'managed');
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
    const result = await harness('managed');
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
    const result = await harness('legacy');

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
    const result = await harness('reader', 'viewer');
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
    const result = await harness('remote-managed', 'streamer', 'edge');
    const version = await result.versions.findById(1);
    assert.ok(version?.contract);
    version.contract.features.srsLifecycleV1 = true;

    // The guard installation is local, so a managed profile pointed at another
    // host is refused for that before the lifecycle env is ever considered.
    await assert.rejects(
      result.orchestrator.startDeploy(result.profile, undefined),
      /installed release guard can only deploy its local target/i,
    );

    assert.equal(result.runner.runs.length, 0);
    assert.equal(existsSync(join(root, '.env.remote-managed')), false);
  });
});
