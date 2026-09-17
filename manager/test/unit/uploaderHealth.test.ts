/**
 * What the manager makes of a stream-uploader's own `/health`.
 *
 * Unit test, no database and no uploader. `pnpm test` in manager/.
 *
 * Decision D16 of 2026-09-17 lets an uploader start on a Bee node that is not
 * answering, so the wait for that node is a state the deployment page has to
 * show. The uploader reports it on `/health`, and this is the reading the page
 * is given. The stack pinned today answers none of the new fields, so a
 * manager talking to it has to read that as no waiting state reported rather
 * than as a fault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STREAM_UPLOADER_SERVICE } from '@streaming-infra-manager/common';

import type { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { UploaderHealthService } from '../../src/domain/UploaderHealthService.js';
import type { StackVersionRepository } from '../../src/domain/versions/StackVersionRepository.js';
import { InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';

/** Slot 1 of the bundled port table's API_PORT, which is what `makeProfile` sits on. */
const HEALTH_URL = 'http://127.0.0.1:10010/health';

interface Answer {
  status: number;
  body: unknown;
}

function serviceAnswering(
  answer: Answer | Error,
  services: string[] = [STREAM_UPLOADER_SERVICE, 'srs'],
  host: string | null = null,
) {
  const asked: string[] = [];
  const aborts: unknown[] = [];
  const profiles = new InMemoryProfiles([makeProfile({ name: 'stage', host })]);
  const containers = {
    async listApiContainers(): Promise<
      { service: string; ports: Record<string, number>; buildId: null; buildCommit: null }[]
    > {
      return services.map((service) => ({ service, ports: {}, buildId: null, buildCommit: null }));
    },
  } as unknown as ContainerRepository;
  const versions = {
    async findById(): Promise<null> {
      return null;
    },
  } as unknown as StackVersionRepository;

  const service = new UploaderHealthService(
    profiles.asRepository(),
    containers,
    versions,
    async (url, init) => {
      asked.push(url);
      aborts.push(init.signal);
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  return { service, asked, aborts };
}

const WAITING = {
  status: 503,
  body: {
    status: 'waiting_for_node',
    reasons: ['node_unavailable'],
    waitingSince: '2026-09-17T09:00:00.000Z',
    node: {
      url: 'http://172.17.0.1:10015',
      attempts: 4,
      lastError: 'timeout of 20000ms exceeded',
    },
  },
};

describe('the manager reading an uploader health route', () => {
  it('asks the uploader API port of the deployment slot, under a deadline', async () => {
    const { service, asked, aborts } = serviceAnswering({
      status: 200,
      body: { status: 'ok', reasons: [] },
    });

    await service.read('stage');

    assert.deepEqual(asked, [HEALTH_URL]);
    assert.ok(aborts[0] instanceof AbortSignal, 'the read carries a deadline');
  });

  it('reads a healthy uploader as ok, with nothing about a node on it', async () => {
    const { service } = serviceAnswering({ status: 200, body: { status: 'ok', reasons: [] } });

    const reading = await service.read('stage');

    assert.deepEqual(reading, { state: 'ok', reasons: [] });
  });

  it('carries the whole wait when the uploader is waiting for its node', async () => {
    const { service } = serviceAnswering(WAITING);

    const reading = await service.read('stage');

    assert.deepEqual(reading, {
      state: 'waiting_for_node',
      reasons: ['node_unavailable'],
      waitingSince: '2026-09-17T09:00:00.000Z',
      node: {
        url: 'http://172.17.0.1:10015',
        attempts: 4,
        lastError: 'timeout of 20000ms exceeded',
      },
    });
  });

  it('reads a gate that warned as warned, naming the gate and the rung', async () => {
    const { service } = serviceAnswering({
      status: 503,
      body: {
        status: 'degraded',
        reasons: ['start_gate_warned'],
        startGateWarnings: [{ gate: 'ChequebookGate', rung: '360p' }],
      },
    });

    const reading = await service.read('stage');

    assert.deepEqual(reading, {
      state: 'warned',
      reasons: ['start_gate_warned'],
      startGateWarnings: [{ gate: 'ChequebookGate', rung: '360p' }],
    });
  });

  it('reads a warned gate beside another fault as unhealthy, keeping both', async () => {
    const { service } = serviceAnswering({
      status: 503,
      body: {
        status: 'degraded',
        reasons: ['start_gate_warned', 'segment_stall'],
        startGateWarnings: [{ gate: 'PostageGate' }],
      },
    });

    const reading = await service.read('stage');

    assert.equal(reading.state, 'unhealthy');
    assert.deepEqual(reading.reasons, ['start_gate_warned', 'segment_stall']);
    assert.deepEqual(reading.startGateWarnings, [{ gate: 'PostageGate' }]);
  });

  it('reads any other degraded answer as unhealthy', async () => {
    const { service } = serviceAnswering({
      status: 503,
      body: { status: 'degraded', reasons: ['postage_refused'] },
    });

    const reading = await service.read('stage');

    assert.deepEqual(reading, { state: 'unhealthy', reasons: ['postage_refused'] });
  });

  it('reads the pinned stack, which reports no waiting state at all', async () => {
    const older = {
      status: 200,
      body: {
        status: 'ok',
        reasons: [],
        activeStreams: 0,
        queuePressure: 'low',
        engines: ['srs'],
        publishers: { mode: 'single' },
        refusedPublishers: [],
      },
    };
    const { service } = serviceAnswering(older);

    const reading = await service.read('stage');

    assert.deepEqual(reading, { state: 'ok', reasons: [] });
    assert.equal('waitingSince' in reading, false);
    assert.equal('node' in reading, false);
    assert.equal('startGateWarnings' in reading, false);
  });

  it('reads nothing answering as unreachable rather than as a fault', async () => {
    const { service } = serviceAnswering(new Error('connect ECONNREFUSED 127.0.0.1:10010'));

    const reading = await service.read('stage');

    assert.deepEqual(reading, { state: 'unreachable', reasons: [] });
  });

  it('reaches a deployment on this machine however its deploy target spells it', async () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', 'native', 'deploy@localhost']) {
      const { service, asked } = serviceAnswering(
        { status: 200, body: { status: 'ok', reasons: [] } },
        [STREAM_UPLOADER_SERVICE],
        host,
      );

      await service.read('stage');

      assert.deepEqual(asked, [HEALTH_URL], `${host} is this machine`);
    }
  });

  it('asks a deployment on a declared remote host at that host', async () => {
    const { service, asked } = serviceAnswering(
      { status: 200, body: { status: 'ok', reasons: [] } },
      [STREAM_UPLOADER_SERVICE],
      'deploy@65.108.40.58',
    );

    await service.read('stage');

    assert.deepEqual(asked, ['http://65.108.40.58:10010/health']);
  });

  it('asks nothing of a deployment that runs no uploader', async () => {
    const { service, asked } = serviceAnswering(
      { status: 200, body: { status: 'ok', reasons: [] } },
      ['srs', 'bee-uploader'],
    );

    const reading = await service.read('stage');

    assert.deepEqual(reading, { state: 'not_deployed', reasons: [] });
    assert.deepEqual(asked, []);
  });
});
