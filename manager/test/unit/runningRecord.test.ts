/**
 * What a container record keeps of the environment its container was started
 * with, so the page can say which settings a running deployment is behind on.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Levi okayed a warning when the settings a deployment would get now differ
 * from what its running copy was started with (2026-09-25). A record therefore
 * has to answer "is this the same value" for every key its service reads,
 * secrets included, without holding a secret. It keeps a plain value for what
 * the page may show and a salted digest for everything, and a key the
 * environment did not set is in neither, because an unset key and an empty
 * one reach compose differently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STREAM_UPLOADER_SERVICE } from '@streaming-infra-manager/common';

import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { settingDigest } from '../../src/domain/settings/runningRecord.js';

const KEYS = ['LOG_LEVEL', 'ADMIN_API_TOKEN', 'RPC_ENDPOINT', 'ADMIN_API_URL', 'UPLOADER_START_GATES'];
const ENV = {
  LOG_LEVEL: 'debug',
  ADMIN_API_TOKEN: 'synthetic-admin-token',
  RPC_ENDPOINT: 'https://rpc.example.org/v3/synthetic-provider-key',
  ADMIN_API_URL: '',
  NOT_READ_BY_THIS_SERVICE: 'x',
};

describe('the record of what a container was started with', () => {
  it('keeps a plain value only where the page may show one', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.deepEqual(snapshot.env, { LOG_LEVEL: 'debug' });
  });

  it('keeps a digest for every key the service reads and the environment sets, an empty one included', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.deepEqual(Object.keys(snapshot.envDigests).sort(), ['ADMIN_API_TOKEN', 'ADMIN_API_URL', 'LOG_LEVEL', 'RPC_ENDPOINT']);
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-admin-token|synthetic-provider-key/);
  });

  it('answers whether a value is the one it was started with, under its own salt', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.equal(settingDigest(snapshot.envSalt, 'ADMIN_API_TOKEN', ENV.ADMIN_API_TOKEN), snapshot.envDigests.ADMIN_API_TOKEN);
    assert.notEqual(settingDigest(snapshot.envSalt, 'ADMIN_API_TOKEN', 'another-token'), snapshot.envDigests.ADMIN_API_TOKEN);
    assert.notEqual(settingDigest(snapshot.envSalt, 'ADMIN_API_URL', 'x'), snapshot.envDigests.ADMIN_API_URL);
  });

  it('salts every record apart, so two deployments sharing a secret do not show it', () => {
    const first = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });
    const second = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.notEqual(first.envSalt, second.envSalt);
    assert.notEqual(first.envDigests.ADMIN_API_TOKEN, second.envDigests.ADMIN_API_TOKEN);
  });

  it('ties a digest to its key, so one value under two keys reads as two values', () => {
    const salt = 'synthetic-salt';

    assert.notEqual(settingDigest(salt, 'A', 'BC'), settingDigest(salt, 'AB', 'C'));
  });
});
