/**
 * What the Storage card says a newly set batch reaches.
 *
 * Since 2026-09-25 a batch bought on a deployment is set on it once usable,
 * whatever it recorded before. Being set is not being spent: a running uploader
 * read its batch when it started, and a pool's uploader holds a copy of the pool
 * string, so the card says what has to happen next rather than implying that
 * setting the batch was the whole repair.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Profile } from '../types';
import { newBatchReach } from './newBatchReach';

const stream: Profile = {
  name: 'main-stage', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000008',
  engine_config_revision: 0, intent_revision: 0, stamp_id: `0x${'a'.repeat(64)}`,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
    { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
};

const rungNode: Profile = {
  ...stream,
  name: 'abr-pool-1-1080p',
  kind: 'custom',
  components: ['bee-uploader'],
  containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
};

describe('what a batch newly set on a deployment reaches', () => {
  it('says a pool rung’s batch reaches its uploader only through a pasted pool string', () => {
    const note = newBatchReach(rungNode, '1080p');

    assert.match(note ?? '', /pool string then names it/);
    assert.match(note ?? '', /pasted into its Node pool string under Edit/);
  });

  it('says a running uploader keeps its old batch until the deployment is deployed again', () => {
    const note = newBatchReach(stream, null);

    assert.match(note ?? '', /goes on paying with the old batch until this deployment is deployed again/);
    assert.match(note ?? '', /Stop it, then Start it/);
  });

  it('says nothing more for a Bee node no pool publishes through', () => {
    assert.equal(newBatchReach(rungNode, null), null);
  });

  it('writes no dash or semicolon', () => {
    for (const note of [newBatchReach(rungNode, '1080p'), newBatchReach(stream, null)]) {
      assert.doesNotMatch(note ?? '', /[—;]/);
    }
  });
});
