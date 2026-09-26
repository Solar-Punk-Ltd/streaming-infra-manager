/**
 * The settings list of a deployment that does not exist yet, which the
 * new-deployment wizard edits before it creates one.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The list is the one the deployment's own page shows once it runs, with
 * nothing stored, nothing recorded and nothing running: every key the version
 * declares, the version's value as what the first deploy writes, and the
 * control that decides a key the operator cannot set. A secret the version
 * sets is never answered, and a chain endpoint is answered by its host.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NewDeploymentSettingsCatalog } from '@streaming-infra-manager/common';

import {
  type NewDeploymentCatalogInput,
  newDeploymentSettingsCatalogOf,
} from '../../src/domain/settings/deploymentSettingsCatalog.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const ROOT_SAMPLE = `# === Stream Uploader ===

# How the start gates treat a node they cannot clear.
UPLOADER_START_GATES=chequebook-warn

# How often a warned chequebook is read again.
# CHEQUEBOOK_RECHECK_MS=60000

# The admin's token.
ADMIN_API_TOKEN=

# The token every gated uploader route takes.
API_AUTH_TOKEN=

# === Bee Nodes ===

RPC_ENDPOINT=https://rpc.gnosischain.com
BEE_UPLOADER_DATA_DIR=

# --- Logging ---
LOG_LEVEL=debug
`;

const ENGINE_SAMPLE = `# === SRS Media Server ===
HLS_FRAGMENT=
LOG_LEVEL=info
SRS_LOG_TANK=console
`;

const VERSION_TOKEN = 'synthetic-version-admin-token';

const CONTRACT = {
  ...structuredClone(ALLOCATION_CONTRACT),
  requiredSecrets: ['API_AUTH_TOKEN'],
  serviceEnvKeys: {
    'stream-uploader': ['ADMIN_API_TOKEN', 'API_AUTH_TOKEN', 'LOG_LEVEL', 'UPLOADER_START_GATES'],
    srs: ['HLS_FRAGMENT', 'SRS_LOG_TANK'],
    'bee-uploader': ['RPC_ENDPOINT', 'BEE_UPLOADER_DATA_DIR'],
  },
};

function input(over: Partial<NewDeploymentCatalogInput> = {}): NewDeploymentCatalogInput {
  return {
    versionId: 4,
    contract: CONTRACT,
    buildId: 'build-9',
    rootSampleText: ROOT_SAMPLE,
    engineSampleText: ENGINE_SAMPLE,
    baseEnvText: `UPLOADER_START_GATES=chequebook-warn\nADMIN_API_TOKEN=${VERSION_TOKEN}\nAPI_AUTH_TOKEN=\nRPC_ENDPOINT=https://rpc.example.org/v3/synthetic-provider-key\nLOG_LEVEL=debug\n`,
    engineEnvText: 'LOG_LEVEL=info\nSRS_LOG_TANK=file\n',
    generatedKeys: ['API_AUTH_TOKEN'],
    isLocalTarget: false,
    ...over,
  };
}

const entryOf = (catalog: NewDeploymentSettingsCatalog, key: string) => {
  const entry = catalog.entries.find((candidate) => candidate.key === key);
  assert.ok(entry, `${key} is listed`);
  return entry;
};

describe('the keys a new deployment lists', () => {
  it('lists the root sample first and the engine sample after, a key both declare once', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());

    assert.deepEqual(catalog.entries.map((entry) => entry.key), [
      'UPLOADER_START_GATES',
      'CHEQUEBOOK_RECHECK_MS',
      'ADMIN_API_TOKEN',
      'API_AUTH_TOKEN',
      'RPC_ENDPOINT',
      'BEE_UPLOADER_DATA_DIR',
      'LOG_LEVEL',
      'HLS_FRAGMENT',
      'SRS_LOG_TANK',
    ]);
    assert.equal(catalog.versionId, 4);
    assert.equal(catalog.buildId, 'build-9');
  });

  it('stores nothing and runs nothing, so no key is behind', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());

    for (const entry of catalog.entries) {
      assert.equal(entry.stored, false, entry.key);
      assert.equal(entry.storedValue, null, entry.key);
      assert.equal(entry.declared, true, entry.key);
      assert.equal(entry.running, 'not-running', entry.key);
    }
    assert.deepEqual(Object.keys(catalog).sort(), ['buildId', 'entries', 'versionId']);
  });
});

describe('what the first deploy writes', () => {
  it('writes the version value for a key the operator decides, the root file over the engine file', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());

    assert.deepEqual(
      { source: entryOf(catalog, 'LOG_LEVEL').source, value: entryOf(catalog, 'LOG_LEVEL').value },
      { source: 'version', value: 'debug' },
    );
    assert.equal(entryOf(catalog, 'SRS_LOG_TANK').value, 'file');
    assert.deepEqual(entryOf(catalog, 'UPLOADER_START_GATES').field, {
      kind: 'choice',
      choices: ['chequebook-warn', 'warn', 'refuse'],
    });
  });

  it('names a key nothing sets as unset, with the example the sample shows for it', () => {
    const entry = entryOf(newDeploymentSettingsCatalogOf(input()), 'CHEQUEBOOK_RECHECK_MS');

    assert.equal(entry.source, 'unset');
    assert.equal(entry.value, null);
    assert.equal(entry.sampleValue, '60000');
  });

  it('gives a key a control decides no value, because the manager works it out at the first deploy', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());

    assert.deepEqual(
      { owner: entryOf(catalog, 'HLS_FRAGMENT').owner, source: entryOf(catalog, 'HLS_FRAGMENT').source, value: entryOf(catalog, 'HLS_FRAGMENT').value },
      { owner: 'engine-settings', source: 'manager', value: null },
    );
    assert.equal(entryOf(catalog, 'RPC_ENDPOINT').owner, 'chain-endpoint');
    assert.equal(entryOf(catalog, 'RPC_ENDPOINT').value, null);
  });

  it('names a required secret the version leaves empty as generated at the first deploy', () => {
    const entry = entryOf(newDeploymentSettingsCatalogOf(input()), 'API_AUTH_TOKEN');

    assert.equal(entry.secret, true);
    assert.equal(entry.source, 'generated');
    assert.equal(entry.owner, null);
  });

  it('leaves the data directories to the operator on another host and to the manager on its own', () => {
    const remote = entryOf(newDeploymentSettingsCatalogOf(input()), 'BEE_UPLOADER_DATA_DIR');
    const local = entryOf(newDeploymentSettingsCatalogOf(input({ isLocalTarget: true })), 'BEE_UPLOADER_DATA_DIR');

    assert.equal(remote.owner, null);
    assert.equal(local.owner, 'data-dir');
  });
});

describe('what a new deployment list never answers', () => {
  it('answers no secret value, even one the version sets', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());
    const entry = entryOf(catalog, 'ADMIN_API_TOKEN');

    assert.deepEqual(
      { secret: entry.secret, versionSet: entry.versionSet, versionValue: entry.versionValue, value: entry.value, source: entry.source },
      { secret: true, versionSet: true, versionValue: null, value: null, source: 'version' },
    );
    assert.doesNotMatch(JSON.stringify(catalog), new RegExp(VERSION_TOKEN));
  });

  it('answers a chain endpoint the version sets by its host alone', () => {
    const catalog = newDeploymentSettingsCatalogOf(input());

    assert.equal(entryOf(catalog, 'RPC_ENDPOINT').versionValue, '<rpc.example.org>');
    assert.doesNotMatch(JSON.stringify(catalog), /synthetic-provider-key/);
  });
});
