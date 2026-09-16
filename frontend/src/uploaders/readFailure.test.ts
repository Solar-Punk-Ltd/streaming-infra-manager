/**
 * What the page makes of a node read it could not complete.
 *
 * The manager turns a bee call that failed into a status of its own, so a
 * rejected fetch here is nearly always the node rather than the manager. The
 * page had no way to say which, so a failed stamp read rendered as "Stamp not
 * checked", which reads as nobody having asked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stampHealthFrom } from '@streaming-infra-manager/common';

import { buildChecklist, type ChecklistInput } from '../deployments/checklist';
import type { Profile } from '../types';
import { ApiError } from '../http';
import { readFailureFrom } from './readFailure';

const BATCH = `0x${'a'.repeat(64)}`;

function timeoutError(): Error {
  const err = new Error('the request took too long');
  err.name = 'TimeoutError';
  return err;
}

describe('why a node reading is missing, as the page can tell it', () => {
  it('calls our own deadline a timeout, and keeps how long it had', () => {
    assert.deepEqual(readFailureFrom(timeoutError(), 10_000), {
      reason: 'timeout',
      elapsedMs: 10_000,
    });
  });

  it('calls the node refusing a refusal, not a node that never answered', () => {
    const notReady = new ApiError('bee is starting', 'bee_node_not_ready', 503);

    assert.equal(readFailureFrom(notReady, 120).reason, 'refused');
  });

  it('calls a node the manager could not reach unreachable', () => {
    const unreachable = new ApiError('connect ECONNREFUSED', 'bee_node_unreachable', 502);

    assert.equal(readFailureFrom(unreachable, 120).reason, 'unreachable');
  });

  it('calls an answer that would not parse malformed', () => {
    assert.equal(readFailureFrom(new SyntaxError('Unexpected token <'), 45).reason, 'malformed');
  });

  it('calls a browser-side fetch failure unreachable rather than guessing', () => {
    assert.equal(readFailureFrom(new TypeError('Failed to fetch'), 45).reason, 'unreachable');
    assert.equal(readFailureFrom('not an error at all', 45).reason, 'unreachable');
  });
});

const profile: Profile = {
  name: 'main-stage', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_engine_config: false, engine_config_error: null,
  engine_config_state: null, instance_id: '00000000-0000-4000-8000-000000000002',
  engine_config_revision: 0, intent_revision: 0, stamp_id: BATCH,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
};

function stampStep(input: ChecklistInput) {
  return buildChecklist(input).find((step) => step.title === 'Postage stamp set');
}

function checklistWith(stampHealth: ChecklistInput['stampHealth']): ChecklistInput {
  return {
    profile,
    wallet: { nativeTokenBalance: '1', bzzBalance: '1' },
    chequebook: null,
    nodeAddress: '0x123',
    stampHealth,
    currentStamp: null,
    publishUrl: null,
    clientUrl: null,
    streamers: [],
  };
}

describe('the stamp step once the page can say why the read failed', () => {
  it('said nobody had asked, which is what this replaces', () => {
    const step = stampStep(checklistWith(stampHealthFrom(BATCH, null)));

    assert.equal(step?.problem, 'Stamp not checked');
  });

  it('names the reason the fetch gave instead', () => {
    const failure = readFailureFrom(timeoutError(), 10_000);
    const step = stampStep(checklistWith(stampHealthFrom(BATCH, null, failure)));

    assert.equal(step?.problem, 'Node did not answer in time');
    assert.match(step?.detail ?? '', /10\.0 seconds/);
  });
});
