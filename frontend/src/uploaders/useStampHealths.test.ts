import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stampHealthFrom } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import {
  asksFromKey,
  askableStamps,
  stampAskKey,
  stampHealthsFrom,
} from './useStampHealths';

const BATCH = `0x${'a'.repeat(64)}`;

const node = (overrides: Partial<Profile> = {}): Profile => ({
  name: 'bee-1', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000005',
  engine_config_revision: 0, intent_revision: 0, stamp_id: BATCH,
  components: ['bee-uploader'],
  containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
  ...overrides,
});

describe('which nodes a list asks about a batch', () => {
  it('asks a running node that owns one and records a batch', () => {
    assert.deepEqual(askableStamps([node()]), [{ name: 'bee-1', stampId: BATCH }]);
  });

  it('asks nothing of a node that is not running', () => {
    for (const status of ['STOPPED', 'DEPLOYING', 'ERROR', 'REMOVING'] as const) {
      assert.deepEqual(askableStamps([node({ status })]), [], status);
    }
  });

  it('asks nothing of a deployment with no Bee node of its own', () => {
    const uploader = node({ name: 'abr-1', kind: 'abr-uploader', components: ['stream-uploader'] });

    assert.deepEqual(askableStamps([uploader]), []);
  });

  it('asks nothing about a node that records no batch, because none is the answer', () => {
    assert.deepEqual(askableStamps([node({ stamp_id: null })]), []);
    assert.deepEqual(askableStamps([node({ stamp_id: '  ' })]), []);
  });

  it('asks again when a node records another batch', () => {
    const first = stampAskKey(askableStamps([node()]));
    const bought = `0x${'b'.repeat(64)}`;

    assert.notEqual(first, stampAskKey(askableStamps([node({ stamp_id: bought })])));
    assert.deepEqual(asksFromKey(first), [{ name: 'bee-1', stampId: BATCH }]);
    assert.deepEqual(asksFromKey(''), []);
  });

  it('carries a list of nodes through the key unchanged', () => {
    const asks = askableStamps([node(), node({ name: 'bee-2', stamp_id: `0x${'c'.repeat(64)}` })]);

    assert.deepEqual(asksFromKey(stampAskKey(asks)), asks);
  });
});

describe('the map a round of answers makes', () => {
  it('holds what each node said about the batch its profile records', () => {
    const expired = [{ batchID: BATCH, usable: true, batchTTL: 0 }];
    const healths = stampHealthsFrom([
      ['bee-1', stampHealthFrom(BATCH, expired)],
      ['bee-2', null],
    ]);

    assert.deepEqual([...healths.keys()], ['bee-1']);
    assert.equal(healths.get('bee-1')?.state, 'expired');
    assert.equal(healths.get('bee-1')?.dead, true);
  });

  it('leaves out a node that did not answer, rather than calling its batch gone', () => {
    assert.deepEqual([...stampHealthsFrom([['bee-1', null]]).keys()], []);
  });
});
