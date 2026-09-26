/**
 * Which compose service reads which env key, as a version's contract records it.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A changed setting recreates the containers that read it and nothing else,
 * the way an engine setting already recreates the engine alone. The list the
 * manager kept by hand, SERVICE_ENV_KEYS, names about a third of what the
 * uploader reads: none of its start gate settings, its admin link or its log
 * level. So the contract reads it from the version's own compose files, where
 * every key a container gets is written as `${KEY}`, and the hand-kept list is
 * only what a version captured before this falls back to.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseStackContract } from '@streaming-infra-manager/common';

import { readServiceEnvKeys, readStackContract } from '../../src/domain/versions/stackContract.js';

const STACK = fileURLToPath(new URL('../../swarm-hls-stream/', import.meta.url));

const COMPOSE = `x-logging: &default-logging
  driver: 'json-file'
  options:
    max-size: '50m'

services:
  # --- \${NOT_A_SERVICE} ---
  stream-uploader:
    environment:
      LOG_LEVEL: \${LOG_LEVEL:-info}
      # A key named in a comment is not read: \${COMMENTED_OUT}
      BEE_PORT: \${CLIENT_BEE_GATEWAY_PORT:-\${BEE_GATEWAY_API_PORT:-1733}}
      COST: $$ESCAPED
      BARE: $BARE_KEY
  client:
    build:
      args:
        VITE_APP_OWNER: \${VITE_APP_OWNER:-}
    ports:
      - '\${CLIENT_PORT:-5173}:80'

volumes:
  srs-media:
`;

describe('the keys each compose service reads', () => {
  it('reads every interpolated key of a service, nested and bare ones included', () => {
    assert.deepEqual(readServiceEnvKeys([COMPOSE]), {
      'stream-uploader': ['BARE_KEY', 'BEE_GATEWAY_API_PORT', 'CLIENT_BEE_GATEWAY_PORT', 'LOG_LEVEL'],
      client: ['CLIENT_PORT', 'VITE_APP_OWNER'],
    });
  });

  it('adds what an override file gives the same service', () => {
    const override = 'services:\n  client:\n    volumes:\n      - ${CLIENT_CONF_FILE}:/etc/nginx.conf:ro\n';

    assert.deepEqual(readServiceEnvKeys([COMPOSE, override]).client, ['CLIENT_CONF_FILE', 'CLIENT_PORT', 'VITE_APP_OWNER']);
  });

  it('reads the uploader keys of the bundled stack that the hand-kept list never had', () => {
    const uploader = readStackContract(STACK).serviceEnvKeys?.['stream-uploader'] ?? [];

    for (const key of ['UPLOADER_START_GATES', 'CHEQUEBOOK_MIN_BZZ', 'ADMIN_API_URL', 'ADMIN_API_TOKEN', 'LOG_LEVEL']) {
      assert.ok(uploader.includes(key), key);
    }
  });

  it('reads an engine config file key from the override that mounts it', () => {
    assert.ok((readStackContract(STACK).serviceEnvKeys?.srs ?? []).includes('SRS_CONF_FILE'));
  });
});

describe('the keys each service reads, stored and read back', () => {
  it('survives the stored contract', () => {
    const contract = readStackContract(STACK);

    assert.deepEqual(parseStackContract(JSON.parse(JSON.stringify(contract)))?.serviceEnvKeys, contract.serviceEnvKeys);
  });

  it('is absent from a contract an older manager stored, rather than empty', () => {
    const { serviceEnvKeys: _dropped, ...older } = readStackContract(STACK);

    assert.equal(parseStackContract(JSON.parse(JSON.stringify(older)))?.serviceEnvKeys, undefined);
  });
});
