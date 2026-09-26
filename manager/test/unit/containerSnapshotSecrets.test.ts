/**
 * What the container records keep of a deployment's secrets: nothing.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A container record is the environment the manager worked out a container was
 * started with. The stream key and the SRT passphrase are part of that
 * environment, and the record kept both in clear beside the ports, in a table
 * no page reads, so every database dump carried them a second time. The
 * deployment's own row keeps them once, and that copy is the one the deploy
 * reads. Migration 036 takes them out of the records written before this.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isSecretSettingKey,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import {
  buildContainerSnapshot,
  SERVICE_ENV_KEYS,
} from '../../src/domain/containerKeysSpec.js';

const STREAM_KEY = `0x${'ab'.repeat(32)}`;
const PASSPHRASE = 'synthetic-passphrase-0123';

describe('the secrets a container record keeps', () => {
  it('keeps the SRT passphrase out of the engine record and its port in', () => {
    const snapshot = buildContainerSnapshot(SRS_SERVICE, {
      SRT_PASSPHRASE: PASSPHRASE,
      SRS_SRT_PORT: '10180',
    });

    assert.deepEqual(snapshot.env, { SRS_SRT_PORT: '10180' });
  });

  it('keeps the stream key out of the uploader record and the stamp in', () => {
    const snapshot = buildContainerSnapshot(STREAM_UPLOADER_SERVICE, {
      STREAM_KEY,
      STAMP: 'cafe',
    });

    assert.deepEqual(snapshot.env, { STAMP: 'cafe' });
  });

  it('records no secret-shaped key for any service, whatever the lists name', () => {
    for (const [service, keys] of Object.entries(SERVICE_ENV_KEYS)) {
      const env = Object.fromEntries(keys.map((key) => [key, 'synthetic-value']));
      const recorded = Object.keys(buildContainerSnapshot(service, env).env);

      assert.deepEqual(recorded.filter(isSecretSettingKey), [], service);
    }
  });
});
