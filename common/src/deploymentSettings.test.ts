/**
 * The words a deployment's settings use for a key the operator does not set
 * there.
 *
 * Unit test. `pnpm test` in common/.
 *
 * Most such keys are decided by one of the deployment's own controls. An engine
 * setting the deployment does not read at all is a different case: nothing
 * decides it, and the reason is what the page and a refusal have to say.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNotReadOwner, NOT_READ_OWNERS, SETTING_OWNER_LABELS, type SettingOwner } from './deploymentSettings.js';

describe('the owners of a key the deployment does not read', () => {
  it('say in plain words which deployment reads the key', () => {
    assert.equal(SETTING_OWNER_LABELS['abr-only'], 'only a deployment that encodes the ABR ladder reads it');
    assert.equal(SETTING_OWNER_LABELS['srs-only'], 'only a deployment that runs SRS reads it');
    assert.equal(SETTING_OWNER_LABELS['ome-only'], 'only a deployment that runs OvenMediaEngine reads it');
  });

  it('are told apart from the controls that decide a key', () => {
    assert.deepEqual([...NOT_READ_OWNERS].sort(), ['abr-only', 'ome-only', 'srs-only']);
    for (const owner of Object.keys(SETTING_OWNER_LABELS) as SettingOwner[]) {
      assert.equal(isNotReadOwner(owner), NOT_READ_OWNERS.includes(owner), owner);
    }
    assert.equal(isNotReadOwner('engine-settings'), false);
  });
});
