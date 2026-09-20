import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseGuardStateRoot } from '../../src/utils/config.js';

describe('installed release guard state root', () => {
  it('accepts one canonical absolute mount and leaves an absent guard disabled', () => {
    assert.equal(releaseGuardStateRoot(undefined), null);
    assert.equal(
      releaseGuardStateRoot('/home/manager/.local/state/streaming-release-guard'),
      '/home/manager/.local/state/streaming-release-guard',
    );
  });

  it('refuses relative and non-canonical paths', () => {
    for (const value of ['state/release-guard', '/state/../release-guard', '/']) {
      assert.throws(() => releaseGuardStateRoot(value), /RELEASE_GUARD_STATE_ROOT/);
    }
  });
});
