/**
 * The probe that checks a Bee image on a connection of its own.
 *
 * Starting the check's exec takes the connection over, and from then on the
 * stream that reads the answer owns it. If the conversation's deadline passes
 * at that very moment, the probe refuses, and that stream must close quietly:
 * an error it emits with nobody listening would take the whole manager down.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';
import { probeDockerBeeBridge } from '../../src/domain/chequebook/probeDockerBeeBridge.js';
import { syntheticDockerBee, syntheticTarget } from '../support/syntheticDockerBee.js';

const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve)); };

it('closes the answer stream quietly when the deadline passes as the connection is handed to it', async t => {
  const fixture = syntheticDockerBee(t);
  const now = performance.now.bind(performance);
  // Only the handover sees the deadline as passed, so every read before it succeeds.
  t.mock.method(performance, 'now', () => new Error().stack?.includes('DockerHandshake.release') ? now() + 3_600_000 : now());
  await assert.rejects(probeDockerBeeBridge(fixture.transport, syntheticTarget, {}, async () => true), { name: 'DockerBeeAcquisitionError' });
  await settle();
  assert.deepEqual(fixture.dockerRequests.filter(request => request.exec).map(request => request.exec), ['check'], 'the check had started');
  assert.equal(fixture.transport.destroyed, true, 'the connection was closed');
});
