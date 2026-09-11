import assert from 'node:assert/strict';
import { it } from 'node:test';
import { engineOverviewIdentity, engineOverviewIdentityKey } from '@streaming-infra-manager/common';
import { engineOverviewRequestKey } from './engineOverviewRequest';

const profile = { name: 'synthetic-engine', instance_id: 'instance-one', kind: 'custom', components: ['ome'],
  engine_config_revision: 3, intent_revision: 4, updated_at: '2026-09-09T00:00:00.123Z',
  stack_version_id: 2, has_engine_config: true, engine_settings: { HLS_SEGMENT_DURATION: '7' } };

it('uses the shared identity for a complete profile', () => {
  assert.equal(engineOverviewRequestKey(profile), engineOverviewIdentityKey(engineOverviewIdentity(profile)));
});

it('leaves a missing or legacy profile unidentified instead of guessing its version', () => {
  assert.equal(engineOverviewRequestKey(null), null);
  for (const stack_version_id of [undefined, null, 0, 1.5, NaN]) {
    assert.equal(engineOverviewRequestKey({ ...profile, stack_version_id }), null);
  }
});

it('does not crash a render or reuse evidence when a revision is already rounded or malformed', () => {
  for (const engine_config_revision of [9007199254740992, -1]) {
    assert.equal(engineOverviewRequestKey({ ...profile, engine_config_revision }), null);
  }
  assert.equal(engineOverviewRequestKey({ ...profile, instance_id: '' }), null);
});
