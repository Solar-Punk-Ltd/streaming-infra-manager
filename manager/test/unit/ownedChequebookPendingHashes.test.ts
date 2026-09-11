import assert from 'node:assert/strict';
import { it } from 'node:test';
import { ChequebookPendingHashes } from '../../src/domain/chequebook/ChequebookPendingHashes.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { syntheticDockerBee, syntheticTarget } from '../support/syntheticDockerBee.js';
import { operationCandidate, transactionHash } from '../support/chequebookOperations.js';

const saved = () => operationCandidate({ tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' });

it('reads pending hashes through the owned Docker/Bee connection for the saved profile lifetime', async t => {
  const fixture = syntheticDockerBee(t, (request, response) => {
    if (request.url !== '/transactions') return false;
    response.end(JSON.stringify({ pendingTransactions: [{ transactionHash }] })); return true;
  });
  const captures: unknown[] = [];
  const reader = ChequebookPendingHashes.fromOwnedTarget(async (name, instance) => { captures.push([name, instance]); return syntheticTarget; },
    (target, budgets, signal) => acquireDockerBeeStream(fixture.transport, target, budgets, () => true, signal));
  assert.deepEqual(await reader.read(saved(), new AbortController().signal), [transactionHash]);
  assert.deepEqual(captures, [[syntheticTarget.profile.name, syntheticTarget.profile.instanceId]]);
  assert.equal(fixture.counts().posts, 0); assert.equal(fixture.transport.destroyed, true);
});

it('does not infer historical generations or use a replacement current profile for pending evidence', async () => {
  let acquired = 0; let captured = 0;
  const reader = ChequebookPendingHashes.fromOwnedTarget(async () => { captured++; return { ...syntheticTarget,
    profile: { ...syntheticTarget.profile, instanceId: '22222222-2222-4222-8222-222222222222' } }; },
  async () => { acquired++; throw new Error('No acquisition'); });
  await assert.rejects(reader.read({ ...saved(), profileInstanceId: null }, new AbortController().signal));
  assert.equal(captured, 0); assert.equal(acquired, 0);
  await assert.rejects(reader.read(saved(), new AbortController().signal));
  assert.equal(captured, 1); assert.equal(acquired, 0);
});

it('disposes an acquired stream resolving after cancellation without reading Bee or dropping ownership', async t => {
  const fixture = syntheticDockerBee(t); const controller = new AbortController();
  let release!: () => void;
  let acquiring = false;
  const reader = ChequebookPendingHashes.fromOwnedTarget(async () => syntheticTarget, async () => {
    const owned = await acquireDockerBeeStream(fixture.transport, syntheticTarget, {}, () => true);
    acquiring = true;
    return new Promise(resolve => { release = () => resolve(owned); });
  });
  const reading = reader.read(saved(), controller.signal);
  while (!acquiring) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(reading);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.transport.destroyed, true); assert.equal(fixture.beeRequests.length, 0);
});

it('missing profile and mismatched Bee identity mean unavailable pending evidence, never an empty list', async t => {
  const missing = ChequebookPendingHashes.fromOwnedTarget(async () => { throw new Error('synthetic-private-path'); }, async () => { assert.fail('No transport for a deleted profile'); });
  await assert.rejects(missing.read(saved(), new AbortController().signal), error => error instanceof Error && !error.message.includes('private-path'));
  const fixture = syntheticDockerBee(t, (request, response) => {
    if (request.url !== '/addresses') return false;
    response.end(JSON.stringify({ ethereum: `0x${'77'.repeat(20)}` })); return true;
  });
  const replaced = ChequebookPendingHashes.fromOwnedTarget(async () => syntheticTarget,
    (target, budgets, signal) => acquireDockerBeeStream(fixture.transport, target, budgets, () => true, signal));
  await assert.rejects(replaced.read(saved(), new AbortController().signal));
  assert.equal(fixture.beeRequests.some(value => value.url === '/transactions'), false); assert.equal(fixture.transport.destroyed, true);
});
