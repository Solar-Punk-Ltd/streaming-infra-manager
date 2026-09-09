import assert from 'node:assert/strict';
import { it } from 'node:test';

import { engineOverviewIdentity, engineOverviewIdentityKey } from './engineOverviewIdentity.js';

const profile = {
  name: 'synthetic-engine', instance_id: 'instance-one', kind: 'custom', components: ['ome', 'stream-uploader'],
  engine_config_revision: '9007199254740993', intent_revision: 4,
  updated_at: '2026-09-09T00:00:00.123Z', stack_version_id: 2, has_engine_config: true,
  engine_settings: { HLS_SEGMENT_DURATION: ' 7 ', OME_HLS_POLL_INTERVAL_MS: '750' }, bee_publishers: null,
};

it('normalizes equivalent settings maps and revisions without losing large integer precision', () => {
  const first = engineOverviewIdentity(profile);
  const same = engineOverviewIdentity({
    ...profile, intent_revision: '0004', updated_at: new Date(profile.updated_at),
    engine_settings: { OME_HLS_POLL_INTERVAL_MS: '750', HLS_SEGMENT_DURATION: '7', HLS_SEGMENT_COUNT: ' ' },
  });
  assert.equal(first.configRevision, '9007199254740993');
  assert.equal(first.intentRevision, '4');
  assert.deepEqual(first, same);
  assert.equal(engineOverviewIdentityKey(first), engineOverviewIdentityKey(same));
});

it('changes identity for every observation-defining profile input, even in the same timestamp millisecond', () => {
  const first = engineOverviewIdentityKey(engineOverviewIdentity(profile));
  for (const change of [
    { name: 'other' }, { instance_id: 'instance-two' }, { engine_config_revision: '9007199254740994' },
    { intent_revision: '5' }, { updated_at: '2026-09-09T00:00:00.124Z' }, { stack_version_id: 3 },
    { has_engine_config: false }, { components: ['srs', 'stream-uploader'] },
    { bee_publishers: 'synthetic publisher' }, { engine_settings: { HLS_SEGMENT_DURATION: '8' } },
  ]) {
    assert.notEqual(engineOverviewIdentityKey(engineOverviewIdentity({ ...profile, ...change })), first);
  }
});

it('refuses already rounded or invalid revision inputs instead of giving them another revision identity', () => {
  for (const revision of [9007199254740992, -1, 1.5, '1e3', '-1', '', ' 4 ']) {
    assert.throws(() => engineOverviewIdentity({ ...profile, engine_config_revision: revision }), /revision/i);
  }
});

it('includes only observation identity, never config contents or unrelated profile fields', () => {
  const withPrivateFields = { ...profile, engine_config: 'synthetic raw XML', notes: 'not observation identity' };
  const identity = engineOverviewIdentity(withPrivateFields);
  assert.equal(JSON.stringify(identity).includes('synthetic raw XML'), false);
  assert.equal(JSON.stringify(identity).includes('not observation identity'), false);
  assert.equal(identity.engine, 'ome');
  assert.equal(identity.abr, false);
});
