/**
 * What the readiness list says about an uploader, once the uploader itself has
 * been asked.
 *
 * Decision D16 of 2026-09-17 lets an uploader start on a Bee node that is not
 * answering, so "the container is running" stopped being the whole answer. The
 * deployment page reads the uploader's own health route and hands the reading
 * here. Every other view passes none, and those must read exactly as they did.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beePublishersValue,
  DEFAULT_ABR_RUNGS,
  stampHealthFrom,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import { formatDateTime } from '../format';
import type { Profile } from '../types';
import { buildChecklist, type ChecklistInput } from './checklist';

const BATCH = `0x${'a'.repeat(64)}`;

const profile: Profile = {
  name: 'main-stage', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null,
  instance_id: '00000000-0000-4000-8000-000000000002',
  engine_config_revision: 0, intent_revision: 0, stamp_id: BATCH,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
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

const uploaderStep = (uploaderHealth?: UploaderHealthReading) =>
  buildChecklist(input(uploaderHealth ? { uploaderHealth } : {})).find(
    (step) => step.title === 'Uploader running',
  );

const WAITING_SINCE = '2026-09-17T09:00:00.000Z';

describe('the uploader step once the uploader has been asked', () => {
  it('says nothing new when no view asked, which is every list', () => {
    const step = uploaderStep();

    assert.equal(step?.state, 'ok');
    assert.equal(step?.problem, undefined);
    assert.match(step?.detail ?? '', /container is reported running/);
    assert.doesNotMatch(step?.detail ?? '', /health route/);
  });

  it('shows a uploader waiting for its node as busy, naming node, attempts and since when', () => {
    const step = uploaderStep({
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      waitingSince: WAITING_SINCE,
      node: { url: 'http://172.17.0.1:10015', attempts: 4, lastError: 'timeout of 20000ms exceeded' },
    });

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Uploader waiting for its node');
    assert.match(step?.detail ?? '', /http:\/\/172\.17\.0\.1:10015/);
    assert.match(step?.detail ?? '', /4 attempts/);
    assert.ok(
      (step?.detail ?? '').includes(formatDateTime(WAITING_SINCE)),
      `expected the wait to be dated, got ${step?.detail}`,
    );
  });

  it('says what the node last failed with, which is why it is being waited for', () => {
    const step = uploaderStep({
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      waitingSince: WAITING_SINCE,
      node: { url: 'http://172.17.0.1:10015', attempts: 4, lastError: 'timeout of 20000ms exceeded' },
    });

    assert.match(step?.detail ?? '', /last error: timeout of 20000ms exceeded/);
  });

  it('counts one attempt as one, and says no error before one has failed', () => {
    const step = uploaderStep({
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      node: { url: 'http://172.17.0.1:10015', attempts: 1 },
    });

    assert.match(step?.detail ?? '', /1 attempt so far/);
    assert.doesNotMatch(step?.detail ?? '', /1 attempts/);
    assert.doesNotMatch(step?.detail ?? '', /last error/);
  });

  it('names the gate and the rung in plain words when a gate warned', () => {
    const step = uploaderStep({
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'ChequebookGate', rung: '360p' }],
    });

    assert.equal(step?.state, 'warn');
    assert.equal(step?.problem, 'Uploader started with a warning');
    assert.match(step?.detail ?? '', /The chequebook gate warned on the 360p rung/);
    assert.doesNotMatch(step?.detail ?? '', /ChequebookGate/);
  });

  it('names a gate that warned with no rung, which is a single-node deployment', () => {
    const step = uploaderStep({
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'PostageGate' }],
    });

    assert.match(step?.detail ?? '', /The postage gate warned\./);
    assert.doesNotMatch(step?.detail ?? '', /rung/);
  });

  it('reads every reason in plain words when the uploader reports a fault', () => {
    const step = uploaderStep({
      state: 'unhealthy',
      reasons: ['segment_upload_failure', 'postage_refused'],
    });

    assert.equal(step?.state, 'err');
    assert.match(step?.detail ?? '', /segment upload failure and postage refused/);
    assert.doesNotMatch(step?.detail ?? '', /_/);
  });

  it('says so plainly when the uploader reports healthy', () => {
    const step = uploaderStep({ state: 'ok', reasons: [] });

    assert.equal(step?.state, 'ok');
    assert.equal(step?.problem, undefined);
    assert.equal(step?.detail, 'The uploader reports healthy.');
  });

  it('adds one sentence when the health route did not answer, and nothing else', () => {
    const step = uploaderStep({ state: 'unreachable', reasons: [] });

    assert.equal(step?.state, 'ok');
    assert.match(step?.detail ?? '', /container is reported running/);
    assert.match(step?.detail ?? '', /Its health route did not answer\./);
  });

  it('falls back to the not-started step when no uploader is deployed', () => {
    const stopped: Profile = {
      ...profile,
      containers: profile.containers.filter((c) => c.service !== 'stream-uploader'),
    };
    const step = buildChecklist(
      input({ profile: stopped, uploaderHealth: { state: 'not_deployed', reasons: [] } }),
    ).find((entry) => entry.title === 'Uploader running');

    assert.equal(step?.problem, 'Uploader not started');
    assert.doesNotMatch(step?.detail ?? '', /health route/);
  });
});

const pool = beePublishersValue(
  DEFAULT_ABR_RUNGS.map((rung, index) => ({
    rungName: rung,
    url: `http://10.0.0.${index + 1}:${10015 + index * 10}`,
    batchId: String(index + 1).repeat(64),
  })),
);

const abrProfile: Profile = {
  ...profile,
  name: 'abr-stage',
  kind: 'abr-uploader',
  components: ['srs', 'stream-uploader'],
  stamp_id: null,
  bee_publishers: pool,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
};

const abrUploaderStep = (uploaderHealth: UploaderHealthReading, candidate = abrProfile) =>
  buildChecklist(input({
    profile: candidate,
    stampHealth: stampHealthFrom(null, null),
    uploaderHealth,
  })).find((step) => step.title === 'Uploader running');

describe('a pool-backed ABR uploader reports its own health', () => {
  it('shows the wait for a pool node', () => {
    const step = abrUploaderStep({
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      node: { url: 'http://10.0.0.1:10015', attempts: 2 },
    });

    assert.equal(step?.state, 'busy');
    assert.equal(step?.problem, 'Uploader waiting for its node');
  });

  it('shows a pool start-gate warning', () => {
    const step = abrUploaderStep({
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'PostageGate', rung: '360p' }],
    });

    assert.equal(step?.state, 'warn');
    assert.match(step?.detail ?? '', /360p rung/);
  });

  it('shows an unhealthy pool-backed uploader', () => {
    const step = abrUploaderStep({ state: 'unhealthy', reasons: ['postage_refused'] });

    assert.equal(step?.state, 'err');
    assert.match(step?.detail ?? '', /postage refused/);
  });

  it('shows a healthy pool-backed uploader', () => {
    const step = abrUploaderStep({ state: 'ok', reasons: [] });

    assert.equal(step?.state, 'ok');
    assert.equal(step?.detail, 'The uploader reports healthy.');
  });

  it('puts pool configuration before uploader health and asks for no single-node stamp', () => {
    const steps = buildChecklist(input({
      profile: abrProfile,
      stampHealth: stampHealthFrom(null, null),
      uploaderHealth: { state: 'ok', reasons: [] },
    }));

    assert.deepEqual(
      steps.map((step) => step.title),
      ['Containers running', 'Node pool configured', 'Uploader running'],
    );
  });

  it('offers start from a valid pool without a stamp of its own', () => {
    const stopped = {
      ...abrProfile,
      containers: abrProfile.containers.filter((container) => container.service !== 'stream-uploader'),
    };
    const step = abrUploaderStep({ state: 'not_deployed', reasons: [] }, stopped);

    assert.equal(step?.action?.kind, 'deploy-uploader');
  });

  it('withholds start until the pool string is usable', () => {
    const invalid = {
      ...abrProfile,
      bee_publishers: 'not-a-pool',
      containers: abrProfile.containers.filter((container) => container.service !== 'stream-uploader'),
    };
    const step = abrUploaderStep({ state: 'not_deployed', reasons: [] }, invalid);

    assert.equal(step?.state, 'off');
    assert.equal(step?.action, undefined);
  });
});
