/**
 * The secrets a stack version requires per deployment.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * main-v3's uploader refuses to start without API_AUTH_TOKEN and its SRS
 * entrypoint exits without SRS_WEBHOOK_TOKEN. The manager generates both the
 * first time a deployment runs on such a version, writes them into
 * `.env.<profile>`, and keeps them: a token that changed on every deploy would
 * cut the engine off from an uploader that was started with the old one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { missingStackSecrets } from '../../src/domain/versions/stackSecrets.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { OrchestratorHarness } from '../support/orchestratorHarness.js';

const root = mkdtempSync(join(tmpdir(), 'stack-secrets-'));
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);

const REQUIRED = ['API_AUTH_TOKEN', 'SRS_WEBHOOK_TOKEN'];

const V3_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: REQUIRED,
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: true },
  chequebookMinBzz: '0.5',
  warnings: [],
};

const HEX_64 = /^[0-9a-f]{64}$/;

/** A ready version whose contract requires the two secrets, rooted in the scratch checkout. */
async function versionRequiringSecrets(harness: OrchestratorHarness): Promise<number> {
  const row = await harness.versions.insert({
    name: 'main-v3',
    gitRef: 'main-v3',
    rootPath: root,
  });
  await harness.versions.markBuilt(row.id, {
    commitSha: 'abc1234',
    contract: V3_CONTRACT,
  });
  return row.id;
}

function envLine(name: string, key: string): string | undefined {
  return readFileSync(join(root, `.env.${name}`), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${key}=`));
}

describe('missingStackSecrets', () => {
  it('generates 64 hex characters for every required key not yet stored', () => {
    const generated = missingStackSecrets(REQUIRED, {});

    assert.deepEqual(Object.keys(generated), REQUIRED);
    for (const value of Object.values(generated)) assert.match(value, HEX_64);
  });

  it('leaves a stored value alone and generates the rest', () => {
    const generated = missingStackSecrets(REQUIRED, {
      API_AUTH_TOKEN: 'kept',
    });

    assert.deepEqual(Object.keys(generated), ['SRS_WEBHOOK_TOKEN']);
  });

  it('refuses a key that is not an env key', () => {
    assert.throws(() => missingStackSecrets(['not a key'], {}), /not an env key/);
  });
});

describe('a deploy on a version that requires secrets', () => {
  it('generates them once, writes them into the env file, and keeps them across deploys', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const harness = orchestratorHarness([]);
    const v3 = await versionRequiringSecrets(harness);
    const stored = makeProfile({
      name: 'stage',
      stamp_id: 'a'.repeat(64),
      stack_version_id: v3,
    });
    harness.profiles.rows.set('stage', stored);

    await harness.orchestrator.startDeploy(stored, undefined);

    const first = {
      api: envLine('stage', 'API_AUTH_TOKEN'),
      webhook: envLine('stage', 'SRS_WEBHOOK_TOKEN'),
    };
    assert.match(first.api ?? '', /^API_AUTH_TOKEN=[0-9a-f]{64}$/);
    assert.match(first.webhook ?? '', /^SRS_WEBHOOK_TOKEN=[0-9a-f]{64}$/);
    assert.deepEqual(
      Object.keys(harness.profiles.secrets.get('stage') ?? {}),
      REQUIRED,
    );

    harness.runner.finish(0);
    await new Promise((resolve) => setImmediate(resolve));
    const again = harness.profiles.rows.get('stage')!;
    await harness.orchestrator.startDeploy(again, undefined);

    assert.equal(envLine('stage', 'API_AUTH_TOKEN'), first.api);
    assert.equal(envLine('stage', 'SRS_WEBHOOK_TOKEN'), first.webhook);
  });

  it('writes nothing of the kind for the bundled version', async () => {
    writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
    const stored = makeProfile({ name: 'plain', stamp_id: 'a'.repeat(64) });
    const harness = orchestratorHarness([stored]);

    await harness.orchestrator.startDeploy(stored, undefined);

    assert.equal(envLine('plain', 'API_AUTH_TOKEN'), undefined);
    assert.equal(harness.profiles.secrets.get('plain'), undefined);
  });
});
