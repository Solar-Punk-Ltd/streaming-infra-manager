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
  BEE_GATEWAY_SERVICE,
  CLIENT_SERVICE,
  LIGHT_NODE_MODE,
  type ReadFailure,
  type ReadFailureReason,
  stampHealthFrom,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import type { BeeStamp } from '../uploaders/stampApi';
import { buildChecklist, type ChecklistInput } from './checklist';

const BATCH = `0x${'a'.repeat(64)}`;

const profile: Profile = {
  name: 'main-stage', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false, engine_config_error: null,
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

const listInput = (chequebook: ChecklistInput['chequebook']) =>
  input({ wallet: undefined, chequebook });

describe('funding where the view never asked the node for its wallet', () => {
  it('waits for the chequebook reading rather than calling the node unchecked', () => {
    const step = stepNamed('Bee node funded', listInput(null));

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Reading balances');
    assert.match(step?.detail ?? '', /waiting for this node/i);
    assert.doesNotMatch(step?.detail ?? '', /not checked/i);
  });

  it('calls a node with a chequebook it can pay from funded', () => {
    const step = stepNamed(
      'Bee node funded',
      listInput({ state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n }),
    );

    assert.equal(step?.state, 'ok');
    assert.equal(step?.problem, undefined);
    assert.match(step?.detail ?? '', /chequebook 1\.0000 BZZ available/);
  });

  it('reports an empty chequebook as the node reported it', () => {
    const step = stepNamed(
      'Bee node funded',
      listInput({ state: 'empty', availablePlur: 0n, floorPlur: 5_000_000_000_000_000n }),
    );

    assert.equal(step?.state, 'err');
    assert.equal(step?.problem, 'Chequebook empty');
    assert.equal(step?.action?.kind, 'fill-chequebook');
  });

  it('reports a chequebook under the floor as low', () => {
    const step = stepNamed(
      'Bee node funded',
      listInput({ state: 'low', availablePlur: 1_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n }),
    );

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Chequebook low');
  });

  it('gives a failed chequebook read the same words the deployment page gives it', () => {
    const step = stepNamed('Bee node funded', listInput(unreadChequebook(failed('timeout'))));

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Node did not answer in time');
    assert.match(step?.detail ?? '', /did not answer the chequebook read within 3\.0 seconds/);
  });

  it('waits on a reading the node did not settle, whatever else it carries', () => {
    const step = stepNamed(
      'Bee node funded',
      listInput({ state: 'unknown', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n }),
    );

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Reading balances');
  });

  it('waits rather than warning when the node answered without a balance', () => {
    const step = stepNamed('Bee node funded', listInput(unreadChequebook()));

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Reading balances');
  });

  it('keeps not checked for the page that asked and has no answer yet', () => {
    const step = stepNamed('Bee node funded', input({ wallet: null }));

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Funding not checked');
    assert.equal(step?.action?.kind, 'refresh-node');
  });
});

const payingChequebook = {
  state: 'ok' as const,
  availablePlur: 10_000_000_000_000_000n,
  floorPlur: 5_000_000_000_000_000n,
};

describe('the stamp where the view never asked the node', () => {
  it('waits for a reading rather than warning about one nobody took', () => {
    const step = stepNamed('Postage stamp set', listInput(payingChequebook));

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Stamp not checked');
    assert.match(step?.detail ?? '', /no reading of it/i);
    assert.equal(step?.action, undefined);
  });

  it('keeps the warning for the page that asked the node and has no answer', () => {
    const step = stepNamed('Postage stamp set', input({ chequebook: payingChequebook }));

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Stamp not checked');
  });

  it('takes a batch that another reading settled at face value', () => {
    const live = stepNamed('Postage stamp set', {
      ...listInput(payingChequebook),
      stampHealth: { state: 'active', ok: true, dead: false, ttl: 500_000, fillRatio: null, immutable: null },
    });
    assert.equal(live?.state, 'ok');

    const gone = stepNamed('Postage stamp set', {
      ...listInput(payingChequebook),
      stampHealth: { state: 'gone', ok: false, dead: true, ttl: null, fillRatio: null, immutable: null },
    });
    assert.equal(gone?.state, 'err');
    assert.equal(gone?.problem, 'Stamp not on node');
  });
});

/**
 * How full a batch is, which bee reports beside its time left and which the
 * step read nothing of until 2026-09-24. That day the 1080p rung of the tester's
 * pool read "Postage stamp set, 2d 3h left" while its node refused every upload
 * with a 402, because the immutable batch's fullest bucket held 128 of its 128
 * chunks.
 */
describe('the stamp step reads how full the batch is', () => {
  const HOST_TTL = 2 * 86_400 + 3 * 3_600 + 12 * 60;
  const hostBatch = (over: Partial<BeeStamp> = {}): BeeStamp => ({
    batchID: BATCH.slice(2),
    utilization: 128,
    usable: true,
    depth: 23,
    amount: '1000000000',
    bucketDepth: 16,
    blockNumber: 1,
    immutableFlag: true,
    exists: true,
    batchTTL: HOST_TTL,
    ...over,
  });
  const stampStepFor = (batch: BeeStamp) =>
    stepNamed(
      'Postage stamp set',
      input({
        chequebook: payingChequebook,
        stampHealth: stampHealthFrom(BATCH, [batch]),
        currentStamp: batch,
      }),
    );

  it('calls the host’s full immutable batch full, not set', () => {
    const step = stampStepFor(hostBatch());

    assert.equal(step?.problem, 'Stamp full');
    assert.equal(step?.state, 'err');
    assert.match(step?.detail ?? '', /128 of 128 chunks in its fullest bucket/);
    assert.match(step?.detail ?? '', /refuses uploads until a new stamp is bought and set/);
    assert.equal(step?.action?.kind, 'buy-stamp');
    assert.equal(step?.action?.primary, true);
  });

  it('makes a full batch the headline, ahead of an uploader that could start', () => {
    const steps = buildChecklist(
      input({
        chequebook: payingChequebook,
        stampHealth: stampHealthFrom(BATCH, [hostBatch()]),
        currentStamp: hostBatch(),
      }),
    );

    assert.equal(steps.find((step) => step.state !== 'ok')?.problem, 'Stamp full');
    assert.equal(steps.some((step) => step.action?.kind === 'deploy-uploader'), false);
  });

  it('warns about an immutable batch past the uploader’s start ceiling, before it fills', () => {
    const step = stampStepFor(hostBatch({ utilization: 122 }));

    assert.equal(step?.problem, 'Stamp nearly full');
    assert.equal(step?.state, 'warn');
    assert.match(step?.detail ?? '', /95% full/);
    assert.equal(step?.action?.label, 'Buy next stamp');
  });

  it('says how full a working batch is and that it is immutable', () => {
    const step = stampStepFor(hostBatch({ utilization: 64 }));

    assert.equal(step?.state, 'ok');
    assert.match(step?.detail ?? '', /50% full/);
    assert.match(step?.detail ?? '', /immutable/);
  });

  it('keeps a full mutable batch working, and says it now overwrites its oldest chunks', () => {
    const step = stampStepFor(hostBatch({ immutableFlag: false }));

    assert.equal(step?.state, 'ok');
    assert.match(step?.detail ?? '', /mutable/);
    assert.match(step?.detail ?? '', /overwrites its oldest chunks rather than refusing uploads/);
  });

  it('says nothing about fill where the node did not report it', () => {
    const step = stepNamed(
      'Postage stamp set',
      input({
        chequebook: payingChequebook,
        stampHealth: stampHealthFrom(BATCH, [{ batchID: BATCH, usable: true, batchTTL: HOST_TTL }]),
      }),
    );

    assert.equal(step?.state, 'ok');
    assert.doesNotMatch(step?.detail ?? '', /full|mutable/);
  });
});

/**
 * Which deployments are chased for gas and postage at all.
 *
 * A node with no chain has no chequebook to fill and no batch to buy, so the
 * two steps that chase those would ask it for what it cannot hold. The mode is
 * read through the shared `effectiveNodeMode`, so a deployment that stores
 * none reads exactly as the stack starts it: light for a node that publishes.
 */
describe('the funding and stamp steps a node is given', () => {
  const titles = (over: Partial<Profile>) =>
    buildChecklist(input({ profile: { ...profile, ...over } })).map((step) => step.title);

  it('gives a light publishing node both', () => {
    const steps = titles({ node_mode: LIGHT_NODE_MODE });

    assert.ok(steps.includes('Bee node funded'), steps.join(', '));
    assert.ok(steps.includes('Postage stamp set'), steps.join(', '));
  });

  it('gives an unchosen mode both, exactly as every deployment made before T27', () => {
    const steps = titles({ node_mode: null });

    assert.ok(steps.includes('Bee node funded'));
    assert.ok(steps.includes('Postage stamp set'));
  });

  it('gives an ultra-light node neither', () => {
    const steps = titles({ node_mode: ULTRA_LIGHT_NODE_MODE });

    assert.equal(steps.includes('Bee node funded'), false, steps.join(', '));
    assert.equal(steps.includes('Postage stamp set'), false, steps.join(', '));
  });

  it('gives a viewer gateway neither, which is what it already did', () => {
    const steps = titles({
      kind: 'viewer',
      components: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
      containers: [{ service: BEE_GATEWAY_SERVICE, ports: {}, buildId: null, buildCommit: null }],
    });

    assert.equal(steps.includes('Bee node funded'), false);
    assert.equal(steps.includes('Postage stamp set'), false);
  });
});
