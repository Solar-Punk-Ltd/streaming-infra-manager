/**
 * A deployment's settings as its page lists them, worked out from the version's
 * files, what the deployment stores, and what its containers were started with.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Every key the version declares is listed with the value the next deploy
 * writes and where that value comes from, and the page says how many of them
 * the running containers are behind on (Levi, 2026-09-25). A secret is never
 * answered in clear, and a chain endpoint is answered by its host, the way the
 * deployment's own endpoint has always been shown.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContainerRow } from '../../src/domain/ContainerRepository.js';
import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { deploymentSettingsCatalogOf, type CatalogInput } from '../../src/domain/settings/deploymentSettingsCatalog.js';
import { makeProfile } from '../support/profileFixtures.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const ROOT_SAMPLE = `# === Stream Uploader ===

# How the start gates treat a node they cannot clear.
UPLOADER_START_GATES=chequebook-warn

# How often a warned chequebook is read again.
# CHEQUEBOOK_RECHECK_MS=60000

# The admin's address.
ADMIN_API_URL=
# The admin's token.
ADMIN_API_TOKEN=

# Whether the uploader runs a node of its own.
# LOCAL_BEE_UPLOADER=false

# === Bee Nodes ===

RPC_ENDPOINT=https://rpc.gnosischain.com

# --- Logging ---
LOG_LEVEL=debug

# === Docker ===
COMPOSE_NETWORK=
`;

const ENGINE_SAMPLE = `# === SRS Media Server ===
SRT_LATENCY=
LOG_LEVEL=info
`;

const CONTRACT = {
  ...structuredClone(ALLOCATION_CONTRACT),
  serviceEnvKeys: {
    'stream-uploader': ['ADMIN_API_TOKEN', 'ADMIN_API_URL', 'LOG_LEVEL', 'UPLOADER_START_GATES'],
    srs: ['SRT_LATENCY'],
    'bee-uploader': ['RPC_ENDPOINT'],
  },
};

const RUNNING_ENV = {
  UPLOADER_START_GATES: 'chequebook-warn',
  ADMIN_API_URL: 'http://admin.internal',
  ADMIN_API_TOKEN: 'synthetic-admin-token',
  LOG_LEVEL: 'debug',
  RPC_ENDPOINT: 'https://rpc.example.org/v3/synthetic-provider-key',
};

/** A key the root sample declares that no container's block reads, so every record covers it. */
const DEPLOY_ONLY = ['COMPOSE_NETWORK'];

function record(service: string, env: Record<string, string>): ContainerRow {
  const snapshot = buildContainerSnapshot(service, env, {
    keys: CONTRACT.serviceEnvKeys[service as keyof typeof CONTRACT.serviceEnvKeys],
    deployKeys: DEPLOY_ONLY,
  });
  return {
    profile_name: 'stage',
    service,
    ports: snapshot.ports,
    env: snapshot.env,
    env_salt: snapshot.envSalt,
    env_digests: snapshot.envDigests,
    build_id: null,
    build_commit: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function input(over: Partial<CatalogInput> = {}): CatalogInput {
  return {
    profile: makeProfile({ name: 'stage', status: 'RUNNING' }),
    engine: 'srs',
    contract: CONTRACT,
    buildId: 'build-7',
    rootSampleText: ROOT_SAMPLE,
    engineSampleText: ENGINE_SAMPLE,
    baseEnvText: 'UPLOADER_START_GATES=chequebook-warn\nADMIN_API_URL=\nADMIN_API_TOKEN=\nRPC_ENDPOINT=https://rpc.example.org/v3/synthetic-provider-key\nLOG_LEVEL=debug\n',
    engineEnvText: 'LOG_LEVEL=info\n',
    stored: { plain: { ADMIN_API_URL: 'http://admin.internal' }, secretKeys: ['ADMIN_API_TOKEN'] },
    revision: 3,
    nextEnv: RUNNING_ENV,
    records: [record('stream-uploader', RUNNING_ENV), record('bee-uploader', RUNNING_ENV)],
    generatedKeys: [],
    isLocalTarget: false,
    ...over,
  };
}

const entryOf = (catalog: ReturnType<typeof deploymentSettingsCatalogOf>, key: string) => {
  const entry = catalog.entries.find((candidate) => candidate.key === key);
  assert.ok(entry, `${key} is listed`);
  return entry;
};

describe('the keys a deployment lists', () => {
  it('lists the root sample first and the engine sample after, a key both declare once', () => {
    const keys = deploymentSettingsCatalogOf(input()).entries.map((entry) => entry.key);

    assert.deepEqual(keys, [
      'UPLOADER_START_GATES',
      'CHEQUEBOOK_RECHECK_MS',
      'ADMIN_API_URL',
      'ADMIN_API_TOKEN',
      'LOCAL_BEE_UPLOADER',
      'RPC_ENDPOINT',
      'LOG_LEVEL',
      'COMPOSE_NETWORK',
      'SRT_LATENCY',
    ]);
  });

  it('lists a stored key the version no longer declares at the end, so it can be reset', () => {
    const catalog = deploymentSettingsCatalogOf(input({ stored: { plain: { OLD_KEY: 'x' }, secretKeys: [] } }));

    assert.deepEqual(catalog.entries.at(-1), { ...entryOf(catalog, 'OLD_KEY'), key: 'OLD_KEY', section: '' });
    assert.equal(entryOf(catalog, 'OLD_KEY').stored, true);
    assert.equal(entryOf(catalog, 'OLD_KEY').declared, false);
    assert.equal(entryOf(catalog, 'LOG_LEVEL').declared, true);
  });
});

describe('where each value comes from', () => {
  it('names a stored value as the deployment own, and the version value as the default beside it', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input()), 'ADMIN_API_URL');

    assert.equal(entry.source, 'deployment');
    assert.equal(entry.storedValue, 'http://admin.internal');
    assert.equal(entry.value, 'http://admin.internal');
    assert.equal(entry.versionSet, true);
    assert.equal(entry.versionValue, '');
  });

  it('names a key the version sets and nothing overrides as the version', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input()), 'UPLOADER_START_GATES');

    assert.equal(entry.source, 'version');
    assert.deepEqual(entry.field, { kind: 'choice', choices: ['chequebook-warn', 'warn', 'refuse'] });
  });

  it('names a key a control decides as the manager, with the control', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input()), 'RPC_ENDPOINT');

    assert.equal(entry.source, 'manager');
    assert.equal(entry.owner, 'chain-endpoint');
  });

  it('names a key nothing sets as unset, with the example the sample shows for it', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input()), 'CHEQUEBOOK_RECHECK_MS');

    assert.equal(entry.source, 'unset');
    assert.equal(entry.value, null);
    assert.equal(entry.sampleValue, '60000');
  });

  it('names an engine setting as decided by the engine settings', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input()), 'SRT_LATENCY');

    assert.equal(entry.source, 'manager');
    assert.equal(entry.owner, 'engine-settings');
  });

  it('takes the root file over the engine file, the way the deploy script does', () => {
    assert.equal(entryOf(deploymentSettingsCatalogOf(input()), 'LOG_LEVEL').versionValue, 'debug');
  });
});

describe('what a secret and an endpoint answer', () => {
  it('answers no secret value, only that one is stored', () => {
    const catalog = deploymentSettingsCatalogOf(input());
    const entry = entryOf(catalog, 'ADMIN_API_TOKEN');

    assert.equal(entry.secret, true);
    assert.equal(entry.stored, true);
    assert.equal(entry.storedValue, null);
    assert.equal(entry.value, null);
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-admin-token/);
  });

  it('answers a chain endpoint by its host alone', () => {
    const catalog = deploymentSettingsCatalogOf(input());

    assert.equal(entryOf(catalog, 'RPC_ENDPOINT').value, '<rpc.example.org>');
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-provider-key/);
  });
});

describe('what the running containers are behind on', () => {
  it('says nothing is behind when every container got the next values', () => {
    const catalog = deploymentSettingsCatalogOf(input());

    assert.deepEqual(catalog.drift, { keys: [], services: [], fullRedeploy: false });
    assert.equal(entryOf(catalog, 'LOG_LEVEL').running, 'same');
  });

  it('names a changed key and only the services that read it', () => {
    const catalog = deploymentSettingsCatalogOf(input({ nextEnv: { ...RUNNING_ENV, LOG_LEVEL: 'info' } }));

    assert.equal(entryOf(catalog, 'LOG_LEVEL').running, 'differs');
    assert.deepEqual(catalog.drift, { keys: ['LOG_LEVEL'], services: ['stream-uploader'], fullRedeploy: false });
  });

  it('finds a changed secret without holding it', () => {
    const catalog = deploymentSettingsCatalogOf(input({ nextEnv: { ...RUNNING_ENV, ADMIN_API_TOKEN: 'another-token' } }));

    assert.deepEqual(catalog.drift.keys, ['ADMIN_API_TOKEN']);
  });

  it('finds a key that was set and is now unset', () => {
    const { ADMIN_API_URL: _dropped, ...next } = RUNNING_ENV;

    assert.deepEqual(deploymentSettingsCatalogOf(input({ nextEnv: next })).drift.keys, ['ADMIN_API_URL']);
  });

  it('asks for a full redeploy for a changed key that only the deploy scripts read', () => {
    const catalog = deploymentSettingsCatalogOf(input({ nextEnv: { ...RUNNING_ENV, COMPOSE_NETWORK: 'host' } }));

    assert.equal(entryOf(catalog, 'COMPOSE_NETWORK').services, null);
    assert.equal(entryOf(catalog, 'COMPOSE_NETWORK').running, 'differs');
    assert.deepEqual(catalog.drift, { keys: ['COMPOSE_NETWORK'], services: ['bee-uploader', 'stream-uploader'], fullRedeploy: true });
  });

  it('says a key is not known when no container that reads it has a record that can tell', () => {
    const legacy = { ...record('stream-uploader', RUNNING_ENV), env_salt: null, env_digests: {} };
    const catalog = deploymentSettingsCatalogOf(input({ records: [legacy], nextEnv: { ...RUNNING_ENV, LOG_LEVEL: 'info' } }));

    assert.equal(entryOf(catalog, 'LOG_LEVEL').running, 'unknown');
    assert.deepEqual(catalog.drift.keys, []);
  });

  it('says nothing runs on a stopped deployment, and still counts what its Start will change', () => {
    const catalog = deploymentSettingsCatalogOf(input({
      profile: makeProfile({ name: 'stage', status: 'STOPPED' }),
      nextEnv: { ...RUNNING_ENV, LOG_LEVEL: 'info' },
    }));

    assert.equal(catalog.running, false);
    assert.equal(entryOf(catalog, 'LOG_LEVEL').running, 'not-running');
    assert.deepEqual(catalog.drift.keys, ['LOG_LEVEL']);
  });
});
