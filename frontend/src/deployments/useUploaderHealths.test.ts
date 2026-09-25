/**
 * Which uploaders a list asks about themselves, and what a round of answers is
 * worth.
 *
 * The overview read no uploader's own health until 2026-09-25, so an ABR
 * uploader reporting `postage_refused` sat under "everything is running and
 * ready" while every upload to its full rung failed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UploaderHealthReading } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { askableUploaders, uploaderHealthsFrom } from './useUploaderHealths';

const stream = (overrides: Partial<Profile> = {}): Profile => ({
  name: 'main-stage', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000006',
  engine_config_revision: 0, intent_revision: 0, stamp_id: `0x${'a'.repeat(64)}`,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
    { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
  ...overrides,
});

const abrUploader = stream({
  name: 'abr-pool-stage-1',
  kind: 'abr-uploader',
  components: ['srs', 'stream-uploader'],
  stamp_id: null,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
});

describe('which uploaders a list asks about themselves', () => {
  it('asks a running stream and a running ABR uploader', () => {
    assert.deepEqual(askableUploaders([stream(), abrUploader]), ['main-stage', 'abr-pool-stage-1']);
  });

  it('asks nothing of a deployment that is not running', () => {
    for (const status of ['STOPPED', 'DEPLOYING', 'STOPPING', 'ERROR', 'REMOVING'] as const) {
      assert.deepEqual(askableUploaders([stream({ status })]), [], status);
    }
  });

  it('asks nothing of a deployment whose uploader container is not there', () => {
    const held = stream({
      containers: [
        { service: 'srs', ports: {}, buildId: null, buildCommit: null },
        { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
      ],
    });

    assert.deepEqual(askableUploaders([held]), []);
  });

  it('asks nothing of a Bee node, a viewer or a list that has not loaded', () => {
    const rung = stream({
      name: 'abr-pool-1-1080p',
      kind: 'custom',
      components: ['bee-uploader'],
      containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
    });
    const viewer = stream({
      name: 'watch',
      kind: 'viewer',
      components: ['client', 'bee-gateway'],
      containers: [
        { service: 'client', ports: {}, buildId: null, buildCommit: null },
        { service: 'bee-gateway', ports: {}, buildId: null, buildCommit: null },
      ],
    });

    assert.deepEqual(askableUploaders([rung, viewer]), []);
    assert.deepEqual(askableUploaders(null), []);
  });
});

describe('the map a round of uploader answers makes', () => {
  const refused: UploaderHealthReading = { state: 'unhealthy', reasons: ['postage_refused'] };
  const silent: UploaderHealthReading = { state: 'unreachable', reasons: [] };

  it('keeps every reading the manager answered with, silence from the uploader included', () => {
    const healths = uploaderHealthsFrom([
      ['abr-pool-stage-1', refused],
      ['main-stage', silent],
    ]);

    assert.equal(healths.get('abr-pool-stage-1'), refused);
    assert.equal(healths.get('main-stage'), silent);
  });

  it('leaves out a deployment whose reading could not be fetched, rather than inventing one', () => {
    assert.deepEqual([...uploaderHealthsFrom([['main-stage', null]]).keys()], []);
  });
});
