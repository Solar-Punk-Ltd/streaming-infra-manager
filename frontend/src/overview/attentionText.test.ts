/**
 * The sentence and the button each row of the overview's "Needs attention"
 * carries, keyed on the readiness label the row was listed for.
 *
 * Since 2026-09-25 that list holds what it promised to all along: a full batch
 * and an uploader reporting a problem, each in words an operator can act on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ChequebookHealth,
  DEFAULT_ABR_RUNGS,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import {
  CHEQUEBOOK_EMPTY,
  NEEDS_A_STAMP,
  STAMP_EXPIRED,
  STAMP_FULL,
  STAMP_NEARLY_FULL,
  UPLOADER_NOT_ANSWERING,
  UPLOADER_REPORTS_A_PROBLEM,
  UPLOADER_WAITING_FOR_NODE,
  UPLOADER_WARNED,
} from '../deployments/readiness';
import type { Profile } from '../types';
import { attentionText } from './attentionText';

const base: Profile = {
  name: 'abr-pool-1-1080p', kind: 'custom', port_slot: 4, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000007',
  engine_config_revision: 0, intent_revision: 0, stamp_id: `0x${'a'.repeat(64)}`,
  components: ['bee-uploader'],
  containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
};

const abrUploader: Profile = {
  ...base,
  name: 'abr-pool-stage-1',
  kind: 'abr-uploader',
  components: ['srs', 'stream-uploader'],
  stamp_id: null,
  bee_publishers: DEFAULT_ABR_RUNGS.map(
    (rung, index) => `${rung}@http://10.200.0.1:${10015 + index * 10}<${String(index + 1).repeat(64)}>`,
  ).join(' '),
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
};

describe('a row for a batch that fills', () => {
  it('says a full batch makes its node refuse uploads, and offers to buy one', () => {
    const row = attentionText(STAMP_FULL, base, null);

    assert.equal(row.text, 'Its stamp is full, so its node refuses uploads. Buy a new one, which is set once it is usable.');
    assert.equal(row.action, 'buy-stamp');
  });

  it('says a batch past the ceiling is worth replacing, true of a full mutable one too', () => {
    const row = attentionText(STAMP_NEARLY_FULL, base, null);

    // Said of both kinds and of a mutable batch already full, which still warns
    // here rather than failing, so nothing in it may promise the batch has room.
    assert.match(row.text, /past 90% full/);
    assert.doesNotMatch(row.text, /before it fills|refusing uploads/);
    assert.equal(row.action, 'buy-stamp');
  });
});

describe('a row for an uploader, in the words its readiness step uses', () => {
  it('says what postage refused means for a pool, with no button but Open', () => {
    const refused: UploaderHealthReading = { state: 'unhealthy', reasons: ['postage_refused'] };
    const row = attentionText(UPLOADER_REPORTS_A_PROBLEM, abrUploader, null, refused);

    assert.match(row.text, /The uploader reports postage refused\./);
    assert.match(row.text, /a rung’s Bee node refused that rung’s postage batch, usually because it is full or has expired, so that rung’s uploads fail/);
    assert.equal(row.action, null);
  });

  it('names the node an uploader is waiting for', () => {
    const waiting: UploaderHealthReading = {
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      node: { url: 'http://10.200.0.1:10015', attempts: 5, lastError: 'connect ECONNREFUSED' },
    };
    const row = attentionText(UPLOADER_WAITING_FOR_NODE, abrUploader, null, waiting);

    assert.match(row.text, /Waiting for its Bee node at http:\/\/10\.200\.0\.1:10015/);
    assert.match(row.text, /5 attempts so far, last error: connect ECONNREFUSED/);
    assert.equal(row.action, null);
  });

  it('says an uploader’s health route did not answer', () => {
    const row = attentionText(UPLOADER_NOT_ANSWERING, abrUploader, null, { state: 'unreachable', reasons: [] });

    assert.match(row.text, /Its health route did not answer\./);
    assert.equal(row.action, null);
  });

  it('names the gate that warned', () => {
    const warned: UploaderHealthReading = {
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'PostageGate', rung: '1080p' }],
    };
    const row = attentionText(UPLOADER_WARNED, abrUploader, null, warned);

    assert.match(row.text, /The postage gate warned on the 1080p rung\./);
    assert.equal(row.action, null);
  });

  it('falls back to the label where no reading came with it', () => {
    assert.deepEqual(attentionText(UPLOADER_REPORTS_A_PROBLEM, abrUploader, null), {
      text: UPLOADER_REPORTS_A_PROBLEM,
      action: null,
    });
  });
});

describe('the rows the list already had', () => {
  it('keeps a failed deploy ahead of whatever the label says', () => {
    const failed = { ...base, status: 'ERROR' as const, last_error: 'compose refused the file' };

    assert.deepEqual(attentionText(STAMP_FULL, failed, null), {
      text: 'Deploy failed. compose refused the file',
      action: 'retry',
    });
  });

  it('keeps its words for a missing, an expired and an unpaid batch', () => {
    const drained: ChequebookHealth = { state: 'empty', availablePlur: 0n, floorPlur: 5_000_000_000_000_000n };

    assert.equal(attentionText(NEEDS_A_STAMP, base, null).text, 'No stamp yet, so its pool cannot publish to this rung.');
    assert.equal(attentionText(STAMP_EXPIRED, base, null).action, 'buy-stamp');
    assert.equal(attentionText(CHEQUEBOOK_EMPTY, base, drained).action, 'fill-chequebook');
  });
});
