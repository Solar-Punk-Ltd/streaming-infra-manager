/**
 * What a container record keeps of the environment its container was started
 * with, so the page can say which settings a running deployment is behind on.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Levi okayed a warning when the settings a deployment would get now differ
 * from what its running copy was started with (2026-09-25). A record therefore
 * has to answer "is this the same value" for every key its container's deploy
 * decided, secrets included, without holding a secret. It keeps a plain value
 * for what the page may show and a salted digest for every key it covers. A key
 * the environment left unset gets a digest of its own, because an unset key and
 * an empty one reach compose differently, and because a key the record does
 * not cover has to read as not known rather than as unset.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STREAM_UPLOADER_SERVICE } from '@streaming-infra-manager/common';

import type { ContainerRow } from '../../src/domain/ContainerRepository.js';
import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { recordedStateOf, settingDigest, unsetDigest } from '../../src/domain/settings/runningRecord.js';

const KEYS = ['LOG_LEVEL', 'ADMIN_API_TOKEN', 'RPC_ENDPOINT', 'ADMIN_API_URL', 'UPLOADER_START_GATES'];
const ENV = {
  LOG_LEVEL: 'debug',
  ADMIN_API_TOKEN: 'synthetic-admin-token',
  RPC_ENDPOINT: 'https://rpc.example.org/v3/synthetic-provider-key',
  ADMIN_API_URL: '',
  NOT_READ_BY_THIS_SERVICE: 'x',
};

function rowOf(snapshot: ReturnType<typeof buildContainerSnapshot>): ContainerRow {
  return {
    profile_name: 'stage',
    service: snapshot.service,
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

describe('the record of what a container was started with', () => {
  it('keeps a plain value only where the page may show one', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.deepEqual(snapshot.env, { LOG_LEVEL: 'debug' });
  });

  it('keeps a digest for every key it covers, an empty and an unset one included, and no secret', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.deepEqual(Object.keys(snapshot.envDigests).sort(), [...KEYS].sort());
    assert.equal(snapshot.envDigests.UPLOADER_START_GATES, unsetDigest(snapshot.envSalt, 'UPLOADER_START_GATES'));
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-admin-token|synthetic-provider-key/);
  });

  it('covers the keys the deploy decided for every container as well as the ones its own block reads', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, { COMPOSE_NETWORK: 'host' }, {
      keys: ['LOG_LEVEL'],
      deployKeys: ['COMPOSE_NETWORK'],
    });

    assert.deepEqual(Object.keys(snapshot.envDigests).sort(), ['COMPOSE_NETWORK', 'LOG_LEVEL']);
  });

  it('salts every record apart, so two deployments sharing a secret do not show it', () => {
    const first = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });
    const second = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS });

    assert.notEqual(first.envSalt, second.envSalt);
    assert.notEqual(first.envDigests.ADMIN_API_TOKEN, second.envDigests.ADMIN_API_TOKEN);
  });

  it('ties a digest to its key, and tells an unset key from every value', () => {
    const salt = 'synthetic-salt';

    assert.notEqual(settingDigest(salt, 'A', 'BC'), settingDigest(salt, 'AB', 'C'));
    assert.notEqual(unsetDigest(salt, 'A'), settingDigest(salt, 'A', ''));
  });
});

describe('whether a container got the value the next deploy writes', () => {
  const row = rowOf(buildContainerSnapshot(STREAM_UPLOADER_SERVICE, ENV, { keys: KEYS }));

  it('answers same for the value it got, a secret included', () => {
    assert.equal(recordedStateOf(row, 'ADMIN_API_TOKEN', 'synthetic-admin-token'), 'same');
    assert.equal(recordedStateOf(row, 'ADMIN_API_URL', ''), 'same');
    assert.equal(recordedStateOf(row, 'UPLOADER_START_GATES', undefined), 'same');
  });

  it('answers differs for another value, and for a key set now that was unset, or the other way round', () => {
    assert.equal(recordedStateOf(row, 'ADMIN_API_TOKEN', 'another-token'), 'differs');
    assert.equal(recordedStateOf(row, 'UPLOADER_START_GATES', 'warn'), 'differs');
    assert.equal(recordedStateOf(row, 'LOG_LEVEL', undefined), 'differs');
  });

  it('answers unknown for a key the record does not cover, and for a record written before digests', () => {
    assert.equal(recordedStateOf(row, 'NOT_READ_BY_THIS_SERVICE', 'x'), 'unknown');
    assert.equal(recordedStateOf({ ...row, env_salt: null, env_digests: {} }, 'LOG_LEVEL', 'debug'), 'unknown');
  });
});
