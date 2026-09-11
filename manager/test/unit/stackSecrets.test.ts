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
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import type { Profile } from '../../src/types/index.js';

import { missingStackSecrets } from '../../src/domain/versions/stackSecrets.js';
import { makeProfile } from '../support/profileFixtures.js';
import type { OrchestratorHarness } from '../support/orchestratorHarness.js';

const root = join(mkdtempSync(join(tmpdir(), 'stack-secrets-')), 'main-v3');
mkdirSync(root);
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import(
  '../support/orchestratorHarness.js'
);

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
    await untilRunning(harness.profiles, 'stage');
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

/**
 * The version's own value, when it has one, is what a new deployment gets.
 *
 * D13: a settings page that shows a generated key and then has the manager
 * generate a different value per deployment is a page that lies. So a
 * non-empty value in the version's own env is used as it stands, the manager
 * generates nothing for that key, and the file's own line reaches the
 * containers the way the passphrase and the stream key already do. A value
 * already stored against the deployment still wins, because rotating the token
 * a running container was started with is a decision, not a side effect.
 */
const VERSION_TOKEN = 'set-at-version-level-not-a-real-secret';

function writeVersionEnv(base: string, engine = ''): void {
  writeFileSync(join(root, '.env'), base, 'utf8');
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(root, 'engines', 'srs', '.env'), engine, 'utf8');
}

async function deployOn(harness: OrchestratorHarness, profile: Partial<Profile> = {}) {
  const v3 = await versionRequiringSecrets(harness);
  const stored = makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64), stack_version_id: v3, ...profile });
  harness.profiles.rows.set('stage', stored);
  await harness.orchestrator.startDeploy(stored, undefined);
  return stored;
}

describe('a required secret the version already sets', () => {
  it('is left to the version for a key of the base env', async () => {
    writeVersionEnv(`ENGINE=srs\nAPI_AUTH_TOKEN=${VERSION_TOKEN}\n`, 'SRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.equal(envLine('stage', 'API_AUTH_TOKEN'), `API_AUTH_TOKEN=${VERSION_TOKEN}`);
    assert.deepEqual(Object.keys(harness.profiles.secrets.get('stage') ?? {}), ['SRS_WEBHOOK_TOKEN']);
  });

  it('is left to the version for a key of the engine env', async () => {
    writeVersionEnv('ENGINE=srs\nAPI_AUTH_TOKEN=\n', `SRS_WEBHOOK_TOKEN=${VERSION_TOKEN}\n`);
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.equal(envLine('stage', 'SRS_WEBHOOK_TOKEN'), undefined);
    assert.deepEqual(Object.keys(harness.profiles.secrets.get('stage') ?? {}), ['API_AUTH_TOKEN']);
  });

  it('is generated per deployment while the version leaves it empty', async () => {
    writeVersionEnv('ENGINE=srs\nAPI_AUTH_TOKEN=\n', 'SRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.match(envLine('stage', 'API_AUTH_TOKEN') ?? '', /^API_AUTH_TOKEN=[0-9a-f]{64}$/);
    assert.match(envLine('stage', 'SRS_WEBHOOK_TOKEN') ?? '', /^SRS_WEBHOOK_TOKEN=[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(harness.profiles.secrets.get('stage') ?? {}), REQUIRED);
  });

  it('is generated when the base env declares it blank and only the engine env sets it', async () => {
    // The root env wins in the stack's deploy script, so an empty line there
    // beats the engine's value. Counting the engine's as supplied would leave
    // the containers with the empty one and nothing generated.
    writeVersionEnv(
      'ENGINE=srs\nAPI_AUTH_TOKEN=\nSRS_WEBHOOK_TOKEN=\n',
      `SRS_WEBHOOK_TOKEN=${VERSION_TOKEN}\n`,
    );
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.match(envLine('stage', 'SRS_WEBHOOK_TOKEN') ?? '', /^SRS_WEBHOOK_TOKEN=[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(harness.profiles.secrets.get('stage') ?? {}), REQUIRED);
  });

  it('is left to the engine env when the base env does not name the key at all', async () => {
    writeVersionEnv('ENGINE=srs\nAPI_AUTH_TOKEN=\n', `SRS_WEBHOOK_TOKEN=${VERSION_TOKEN}\n`);
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.equal(envLine('stage', 'SRS_WEBHOOK_TOKEN'), undefined);
    assert.deepEqual(Object.keys(harness.profiles.secrets.get('stage') ?? {}), ['API_AUTH_TOKEN']);
  });

  it('gives way to a value already stored against the deployment', async () => {
    writeVersionEnv(`ENGINE=srs\nAPI_AUTH_TOKEN=${VERSION_TOKEN}\n`, `SRS_WEBHOOK_TOKEN=${VERSION_TOKEN}\n`);
    const harness = orchestratorHarness([]);
    harness.profiles.secrets.set('stage', { API_AUTH_TOKEN: 'b'.repeat(64) });

    await deployOn(harness);

    assert.equal(envLine('stage', 'API_AUTH_TOKEN'), `API_AUTH_TOKEN=${'b'.repeat(64)}`);
    assert.equal(envLine('stage', 'SRS_WEBHOOK_TOKEN'), undefined);
  });
});

describe('a per deployment key the version already sets', () => {
  it('leaves STREAM_KEY to the base env while the deployment names none', async () => {
    const key = `0x${'c'.repeat(64)}`;
    writeVersionEnv(`ENGINE=srs\nSTREAM_KEY=${key}\nAPI_AUTH_TOKEN=\n`, 'SRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.equal(envLine('stage', 'STREAM_KEY'), `STREAM_KEY=${key}`);
  });

  it('lets a STREAM_KEY of the deployment win over the version', async () => {
    const own = `0xd${'0'.repeat(63)}`;
    writeVersionEnv(`ENGINE=srs\nSTREAM_KEY=0x${'c'.repeat(64)}\nAPI_AUTH_TOKEN=\n`, 'SRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness, { private_key: own });

    assert.equal(envLine('stage', 'STREAM_KEY'), `STREAM_KEY=${own}`);
  });

  it('leaves SRT_PASSPHRASE to the engine env while the deployment names none', async () => {
    writeVersionEnv('ENGINE=srs\nAPI_AUTH_TOKEN=\n', 'SRT_PASSPHRASE=set-by-the-version\nSRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness);

    assert.equal(envLine('stage', 'SRT_PASSPHRASE'), undefined);
  });

  it('lets an SRT_PASSPHRASE of the deployment win over the version', async () => {
    writeVersionEnv('ENGINE=srs\nAPI_AUTH_TOKEN=\n', 'SRT_PASSPHRASE=set-by-the-version\nSRS_WEBHOOK_TOKEN=\n');
    const harness = orchestratorHarness([]);

    await deployOn(harness, { srt_passphrase: 'set-by-the-deployment' });

    assert.equal(envLine('stage', 'SRT_PASSPHRASE'), 'SRT_PASSPHRASE=set-by-the-deployment');
  });
});
