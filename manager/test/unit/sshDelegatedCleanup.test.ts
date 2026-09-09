import assert from 'node:assert/strict';
import { it } from 'node:test';
import { beginSshDockerBeeAcquisition } from '../../src/domain/chequebook/sshDockerBeeAcquisition.js';
import { syntheticTarget } from '../support/syntheticDockerBee.js';
import { fakeForwardHarness, remoteLocator, forwardLimits, tick, deferred, socketIdentity } from '../support/sshForwardLifecycle.js';
import type { SshForwardCleanup } from '../../src/utils/sshForwardResources.js';

function harness() {
  const h = fakeForwardHarness(); const receipt = deferred<SshForwardCleanup | undefined>();
  const child = Object.assign(h.child, { delegatedCleanup: { leaseId: 'synthetic', receipt: receipt.promise, readySocket: () => socketIdentity } });
  const spawn = h.dependencies.spawn;
  h.dependencies.spawn = (command, ownership) => { ownership!.delegateCleanup(); spawn(command); return child; };
  const acquired = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(), forwardLimits, h.dependencies, () => true);
  return { ...h, child, receipt, acquired };
}

it('delegated cleanup needs a validated receipt and confirmed supervisor close, with zero manager path deletion', async () => {
  const h = harness(); await tick(); await h.acquired.result;
  h.child.exitOn = null; h.acquired.dispose(); h.receipt.resolve({ state: 'closed' }); await tick();
  assert.equal(h.events.includes('unlink'), false); let closed = false; void h.acquired.cleanup.then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  h.paths.clear(); h.child.emit('exited'); await tick(); assert.deepEqual(await h.acquired.cleanup, { state: 'closed' });
  assert.equal(h.events.includes('unlink'), false); assert.equal(h.events.includes('rmdir'), false);
});

it('a missing receipt after supervisor close retains resources as unverified without manager fallback', async () => {
  const h = harness(); await tick(); await h.acquired.result;
  h.receipt.resolve(undefined); h.acquired.dispose(); await tick();
  assert.equal((await h.acquired.cleanup).state, 'unverified');
  assert.equal(h.events.includes('unlink'), false); assert.equal(h.events.includes('rmdir'), false);
});

it('start delivery throwing after delegation never returns cleanup authority to the manager', async () => {
  const h = fakeForwardHarness(); h.dependencies.spawn = (_command, ownership) => { ownership!.delegateCleanup(); throw new Error('lost delivery'); };
  const acquired = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(), forwardLimits, h.dependencies, () => true);
  await assert.rejects(acquired.result); await h.clock.advance(20);
  assert.equal((await acquired.cleanup).state, 'unverified'); assert.equal(h.events.includes('rmdir'), false);
});

it('a failure before delegation leaves the original manager able to clean its private empty directory', async () => {
  const h = fakeForwardHarness(); h.dependencies.spawn = () => { throw new Error('not delivered'); };
  const acquired = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(), forwardLimits, h.dependencies, () => true);
  await assert.rejects(acquired.result); await tick(); assert.deepEqual(await acquired.cleanup, { state: 'closed' });
  assert.equal(h.events.includes('rmdir'), true);
});

it('late verified cleanup does not relabel an already unverified manager outcome', async () => {
  const h = harness(); await tick(); await h.acquired.result; h.child.exitOn = null; h.acquired.dispose(); await h.clock.advance(20);
  const prior = await h.acquired.cleanup; assert.equal(prior.state, 'unverified');
  h.receipt.resolve({ state: 'closed' }); h.child.emit('exited'); await tick();
  assert.equal(await h.acquired.cleanup, prior); assert.equal(h.events.includes('rmdir'), false); assert.equal(h.events.includes('unlink'), false);
});

it('disposal during start handoff still revokes deletion authority and never connects', async () => {
  const h = fakeForwardHarness(); const receipt = deferred<SshForwardCleanup | undefined>();
  const child = Object.assign(h.child, { delegatedCleanup: { leaseId: 'synthetic', receipt: receipt.promise, readySocket: () => socketIdentity } });
  let acquired!: ReturnType<typeof beginSshDockerBeeAcquisition>;
  h.dependencies.spawn = (_command, ownership) => { ownership!.delegateCleanup(); acquired.dispose(); return child; };
  acquired = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(), forwardLimits, h.dependencies, () => true);
  await assert.rejects(acquired.result); receipt.resolve(undefined); await tick();
  assert.equal((await acquired.cleanup).state, 'unverified');
  assert.equal(h.events.includes('connect'), false); assert.equal(h.events.includes('rmdir'), false); assert.equal(h.events.includes('unlink'), false);
});
