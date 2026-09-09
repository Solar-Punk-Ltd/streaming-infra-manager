import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import { spawnSupervisedForward, type NativeSupervisorDependencies } from '../../src/utils/nativeSupervisedForward.js';
import type { SupervisorProcessEvent } from '../../src/utils/supervisedForwardChild.js';
import { sshDockerForwardCommand } from '../../src/domain/chequebook/sshDockerForwardCommand.js';
import { dirIdentity, directoryPath, socketPath, remoteLocator } from '../support/sshForwardLifecycle.js';
import type { ForwardSpawnOwnership } from '../../src/utils/sshForwardResources.js';

function fixture() {
  let ms = 10; let created = 0; let delegated = false; const sent: unknown[] = [];
  let observe!: (event: SupervisorProcessEvent) => void;
  const dependencies: NativeSupervisorDependencies = { uid: 123, nowMs: () => ms, nowNs: () => BigInt(ms * 1e6 + 1e12),
    leaseId: () => '9ffaf922-4131-4a8e-80ef-9513033fb47d',
    createProcess() { created++; return { stderr: new PassThrough(), observe(listener) { observe = listener; return () => {}; }, send(value) { sent.push(value); } }; },
  };
  const ownership: ForwardSpawnOwnership = { directory: { path: directoryPath, identity: dirIdentity }, socketPath,
    acquisitionDeadlineMs: 100, operationalDeadlineMs: 300, cleanupDeadlineMs: 320, delegateCleanup() { delegated = true; } };
  const command = sshDockerForwardCommand(remoteLocator().alias, remoteLocator(), { localSocketPath: socketPath, acquisitionTimeoutMs: 90 });
  return { dependencies, ownership, command, sent, created: () => created, delegated: () => delegated,
    time(value: number) { ms = value; }, close() { observe({ type: 'closed' }); } };
}

it('translates the original monotonic cap once and sends only the strict locator/ownership start record', async () => {
  const h = fixture(); const child = spawnSupervisedForward(h.command, h.ownership, h.dependencies);
  assert.equal(h.created(), 1); assert.equal(h.delegated(), true);
  assert.deepEqual(h.sent, [{ type: 'start', leaseId: '9ffaf922-4131-4a8e-80ef-9513033fb47d', locator: remoteLocator(), directory: h.ownership.directory,
    socketPath, acquisitionDeadlineNs: '1000100000000', operationalDeadlineNs: '1000300000000', cleanupDeadlineNs: '1000320000000' }]);
  assert.equal(JSON.stringify(h.sent).includes('executable'), false);
  h.close(); assert.equal(await child.delegatedCleanup.receipt, undefined);
});

for (const change of [
  { acquisitionDeadlineMs: 10 }, { acquisitionDeadlineMs: NaN }, { operationalDeadlineMs: Infinity }, { cleanupDeadlineMs: 100000 },
  { socketPath: '/another/docker.sock' }, { directory: { path: directoryPath, identity: { ...dirIdentity, ino: 'invalid' } } },
]) it(`refuses invalid owned timing or identity before creating a supervisor: ${JSON.stringify(change)}`, () => {
  const h = fixture(); assert.throws(() => spawnSupervisedForward(h.command, { ...h.ownership, ...change }, h.dependencies));
  assert.equal(h.created(), 0); assert.equal(h.delegated(), false);
});

it('a delayed process constructor cannot renew the original acquisition budget or delegate a stale start', async () => {
  const h = fixture(); const create = h.dependencies.createProcess;
  h.dependencies.createProcess = () => { const value = create(); h.time(101); return value; };
  const child = spawnSupervisedForward(h.command, h.ownership, h.dependencies);
  assert.equal(h.created(), 1); assert.equal(h.delegated(), false);
  assert.equal(h.sent.some(value => (value as { type: string }).type === 'start'), false);
  h.close(); assert.equal(await child.delegatedCleanup.receipt, undefined);
});
