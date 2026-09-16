/**
 * What the readiness list says when a node could not be read.
 *
 * The manager answers those routes 200 with a null in them, and the page used
 * to render every one of those nulls as "not checked", which reads as nobody
 * having asked. The owner watched a node answer its probes in under a
 * millisecond and read "Funding not checked" off the page at the same time.
 *
 * So each reading now carries why it is missing, and these pin the sentences
 * that reason turns into. They are what an operator acts on, so a wrong one
 * sends them to the wrong place.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ReadFailure,
  type ReadFailureReason,
  stampHealthFrom,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { buildChecklist, type ChecklistInput } from './checklist';

const BATCH = `0x${'a'.repeat(64)}`;

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

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    profile,
    wallet: { nativeTokenBalance: '1', bzzBalance: '1' },
    chequebook: null,
    nodeAddress: '0x123',
    stampHealth: stampHealthFrom(BATCH, null),
    currentStamp: null,
    publishUrl: null,
    clientUrl: null,
    streamers: [],
    ...overrides,
  };
}

const stepNamed = (title: string, state: ChecklistInput) =>
  buildChecklist(state).find((step) => step.title === title);

const failed = (reason: ReadFailureReason, elapsedMs = 3_012): ReadFailure => ({
  reason,
  elapsedMs,
});

const unreadChequebook = (failure?: ReadFailure) => ({
  state: 'unknown' as const,
  availablePlur: null,
  floorPlur: 5_000_000_000_000_000n,
  ...(failure ? { failure } : {}),
});

describe('a funding reading that is missing says why', () => {
  it('names the budget when the node did not answer in time', () => {
    const step = stepNamed(
      'Bee node funded',
      input({ chequebook: unreadChequebook(failed('timeout')) }),
    );

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Node did not answer in time');
    assert.match(step?.detail ?? '', /did not answer the chequebook read within 3\.0 seconds/);
    assert.doesNotMatch(step?.detail ?? '', /not checked/i);
  });

  it('says nothing answered when nothing answered', () => {
    const step = stepNamed(
      'Bee node funded',
      input({ chequebook: unreadChequebook(failed('unreachable')) }),
    );

    assert.equal(step?.problem, 'Node did not answer');
    assert.match(step?.detail ?? '', /Nothing answered at the node's API/);
  });

  it('says the node refused when it answered and refused', () => {
    const step = stepNamed(
      'Bee node funded',
      input({ chequebook: unreadChequebook(failed('refused')) }),
    );

    assert.equal(step?.problem, 'Node refused the check');
    assert.match(step?.detail ?? '', /refused the chequebook read after 3\.0 seconds/);
  });

  it('blames the answer, not the asking, when the answer made no sense', () => {
    const step = stepNamed(
      'Bee node funded',
      input({ chequebook: unreadChequebook(failed('malformed')) }),
    );

    assert.equal(step?.problem, 'Answer could not be read');
    assert.match(step?.detail ?? '', /something this manager could not read/);
  });

  it('still says not checked when there is no reason to give', () => {
    const step = stepNamed('Bee node funded', input({ chequebook: unreadChequebook() }));

    assert.equal(step?.problem, 'Funding not checked');
  });

  it('offers the node checks again whichever way the read failed', () => {
    for (const reason of ['timeout', 'unreachable', 'refused', 'malformed'] as const) {
      const step = stepNamed(
        'Bee node funded',
        input({ chequebook: unreadChequebook(failed(reason)) }),
      );
      assert.equal(step?.action?.kind, 'refresh-node', reason);
    }
  });
});

describe('a stamp reading that is missing says why', () => {
  it('names what happened rather than calling the stamp unchecked', () => {
    const step = stepNamed(
      'Postage stamp set',
      input({
        chequebook: { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n },
        stampHealth: stampHealthFrom(BATCH, null, failed('timeout')),
      }),
    );

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Node did not answer in time');
    assert.match(step?.detail ?? '', /did not answer the stamp check within 3\.0 seconds/);
  });

  it('still says not checked when there is no reason to give', () => {
    const step = stepNamed(
      'Postage stamp set',
      input({
        chequebook: { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n },
      }),
    );

    assert.equal(step?.problem, 'Stamp not checked');
  });
});
