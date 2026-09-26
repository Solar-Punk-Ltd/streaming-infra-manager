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

import { effectiveEngineDefaults } from '@streaming-infra-manager/common';

import type { ContainerRow } from '../../src/domain/ContainerRepository.js';
import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import {
  deploymentSettingsCatalogOf,
  type CatalogInput,
  type DeploymentEngineSettings,
} from '../../src/domain/settings/deploymentSettingsCatalog.js';
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

/** An SRS deployment without the ABR ladder that stores no engine setting, on a host whose base env sets none. */
function srsSettings(over: Partial<DeploymentEngineSettings> = {}): DeploymentEngineSettings {
  return {
    engine: 'srs',
    abr: false,
    stored: {},
    defaults: effectiveEngineDefaults('srs', {}, { HLS_FRAGMENT: '0.5', HLS_WINDOW: '15' }),
    notInConfig: [],
    ...over,
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
    engineSettings: srsSettings(),
    engineSettingsProblem: null,
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
  it('lists the root sample first, the engine sample after, a key both declare once, then the engine settings neither declares', () => {
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
      'HLS_FRAGMENT',
      'HLS_SEGMENT_MAX',
      'HLS_WINDOW',
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

describe("the deployment's own engine settings", () => {
  it('answers the engine the deployment runs and whether it encodes the ABR ladder', () => {
    const plain = deploymentSettingsCatalogOf(input());
    const ladder = deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ abr: true }) }));

    assert.deepEqual({ engine: plain.engine, abr: plain.abr }, { engine: 'srs', abr: false });
    assert.equal(ladder.abr, true);
  });

  it('lists each one the deployment reads as its own to set, whether a sample declares it or not', () => {
    const catalog = deploymentSettingsCatalogOf(input());

    for (const key of ['HLS_FRAGMENT', 'HLS_SEGMENT_MAX', 'HLS_WINDOW', 'SRT_LATENCY']) {
      const entry = entryOf(catalog, key);
      assert.deepEqual({ owner: entry.owner, declared: entry.declared, secret: entry.secret }, { owner: null, declared: true, secret: false }, key);
      assert.equal(entry.field, null, `${key} takes its field from common, not from the answer`);
    }
  });

  it('takes the value stored for one from the engine settings', () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ stored: { HLS_WINDOW: '20' } }) })), 'HLS_WINDOW');

    assert.deepEqual(
      { stored: entry.stored, storedValue: entry.storedValue, source: entry.source },
      { stored: true, storedValue: '20', source: 'deployment' },
    );
  });

  it('names what an unset one falls back to on this host as its default, and where that comes from', () => {
    const defaults = effectiveEngineDefaults('srs', { HLS_FRAGMENT: '1.5' }, { HLS_FRAGMENT: '0.5', HLS_WINDOW: '15' });
    const catalog = deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ defaults }) }));
    const fragment = entryOf(catalog, 'HLS_FRAGMENT');
    const window = entryOf(catalog, 'HLS_WINDOW');

    assert.deepEqual(
      { versionSet: fragment.versionSet, versionValue: fragment.versionValue, source: fragment.source, facts: fragment.engineSetting },
      { versionSet: true, versionValue: '1.5', source: 'version', facts: { defaultSource: 'host', notInConfig: false } },
    );
    assert.deepEqual(
      { versionValue: window.versionValue, source: window.source, facts: window.engineSetting },
      { versionValue: '15', source: 'version', facts: { defaultSource: 'stack', notInConfig: false } },
    );
  });

  it("names the manager's own SRT latency default as the manager's, stored or not", () => {
    const unset = entryOf(deploymentSettingsCatalogOf(input()), 'SRT_LATENCY');
    const stored = entryOf(deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ stored: { SRT_LATENCY: '3000' } }) })), 'SRT_LATENCY');

    assert.deepEqual(
      { source: unset.source, versionValue: unset.versionValue, defaultSource: unset.engineSetting?.defaultSource },
      { source: 'manager-default', versionValue: '2000', defaultSource: 'manager' },
    );
    assert.deepEqual(
      { source: stored.source, storedValue: stored.storedValue, defaultSource: stored.engineSetting?.defaultSource },
      { source: 'deployment', storedValue: '3000', defaultSource: 'manager' },
    );
  });

  it('says of one that the config the engine runs no longer reads it', () => {
    const catalog = deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ notInConfig: ['HLS_WINDOW'] }) }));

    assert.equal(entryOf(catalog, 'HLS_WINDOW').engineSetting?.notInConfig, true);
    assert.equal(entryOf(catalog, 'HLS_FRAGMENT').engineSetting?.notInConfig, false);
  });

  it('lists nothing but its own for a key that is no engine setting', () => {
    assert.equal(entryOf(deploymentSettingsCatalogOf(input()), 'LOG_LEVEL').engineSetting, null);
  });
});

describe('the engine settings a deployment does not read', () => {
  const LADDER_SAMPLE = `${ENGINE_SAMPLE}# === ABR ladder ===\nABR_FPS=30\n`;
  const OTHER_ENGINE_SAMPLE = `${ROOT_SAMPLE}# === OvenMediaEngine ===\nHLS_SEGMENT_DURATION=2\n`;

  it('keeps a rung setting out of reach of a deployment that does not encode the ladder, and says who reads it', () => {
    const plain = entryOf(deploymentSettingsCatalogOf(input({ engineSampleText: LADDER_SAMPLE })), 'ABR_FPS');
    const ladder = entryOf(deploymentSettingsCatalogOf(input({ engineSampleText: LADDER_SAMPLE, engineSettings: srsSettings({ abr: true }) })), 'ABR_FPS');

    assert.deepEqual({ owner: plain.owner, engineSetting: plain.engineSetting }, { owner: 'abr-only', engineSetting: null });
    assert.equal(ladder.owner, null);
  });

  it("keeps a setting of the engine it does not run out of reach, and says which engine reads it", () => {
    const entry = entryOf(deploymentSettingsCatalogOf(input({ rootSampleText: OTHER_ENGINE_SAMPLE })), 'HLS_SEGMENT_DURATION');

    assert.deepEqual({ owner: entry.owner, source: entry.source }, { owner: 'ome-only', source: 'unset' });
  });

  it('keeps every engine setting out of reach of a deployment that runs no media server', () => {
    const catalog = deploymentSettingsCatalogOf(input({ engineSettings: null }));

    assert.deepEqual({ engine: catalog.engine, abr: catalog.abr }, { engine: null, abr: false });
    assert.equal(entryOf(catalog, 'SRT_LATENCY').owner, 'srs-only');
    assert.equal(catalog.entries.some((entry) => entry.key === 'HLS_WINDOW'), false, 'no engine setting is added for it');
  });

  it('lists a rung setting stored before the ladder was turned off, so it can be reset', () => {
    const catalog = deploymentSettingsCatalogOf(input({ engineSettings: srsSettings({ stored: { ABR_FPS: '25' } }) }));
    const entry = entryOf(catalog, 'ABR_FPS');

    assert.deepEqual(
      { owner: entry.owner, stored: entry.stored, storedValue: entry.storedValue, declared: entry.declared },
      { owner: 'abr-only', stored: true, storedValue: '25', declared: false },
    );
  });
});
