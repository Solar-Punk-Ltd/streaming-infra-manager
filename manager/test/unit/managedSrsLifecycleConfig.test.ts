import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { managedSrsLifecycleConfig } from '../../src/utils/config.js';

const TOKEN = 'managed-srs-fixture-token-at-least-32-bytes';

describe('managed SRS lifecycle configuration', () => {
  it('stays disabled when no managed setting is present', () => {
    assert.equal(managedSrsLifecycleConfig({}), null);
    assert.equal(managedSrsLifecycleConfig({ SRS_LIFECYCLE_VERSION: '  ' }), null);
  });

  it('accepts the exact version-one internal admin boundary', () => {
    assert.deepEqual(
      managedSrsLifecycleConfig({
        SRS_LIFECYCLE_VERSION: '1',
        ADMIN_API_URL: 'http://admin.internal/base/',
        ADMIN_API_TOKEN: TOKEN,
      }),
      {
        lifecycleVersion: 1,
        adminApiUrl: 'http://admin.internal/base',
        adminApiToken: TOKEN,
      },
    );
  });

  it('refuses partial, unsupported, or unsafe settings without echoing a token', () => {
    for (const env of [
      { ADMIN_API_URL: 'http://admin.internal' },
      {
        SRS_LIFECYCLE_VERSION: '2',
        ADMIN_API_URL: 'http://admin.internal',
        ADMIN_API_TOKEN: TOKEN,
      },
      {
        SRS_LIFECYCLE_VERSION: '1',
        ADMIN_API_URL: 'http://user:pass@admin.internal',
        ADMIN_API_TOKEN: TOKEN,
      },
      {
        SRS_LIFECYCLE_VERSION: '1',
        ADMIN_API_URL: 'http://admin.internal?route=other',
        ADMIN_API_TOKEN: TOKEN,
      },
      {
        SRS_LIFECYCLE_VERSION: '1',
        ADMIN_API_URL: 'http://admin.internal',
        ADMIN_API_TOKEN: 'short',
      },
    ]) {
      assert.throws(
        () => managedSrsLifecycleConfig(env),
        (error: Error) => {
          assert.doesNotMatch(error.message, /fixture-token|user:pass|route=other/);
          return true;
        },
      );
    }
  });
});
