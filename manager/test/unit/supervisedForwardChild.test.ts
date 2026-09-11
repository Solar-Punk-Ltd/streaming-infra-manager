import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { it } from 'node:test';
import { attachSupervisedForwardChild, type SupervisorProcess, type SupervisorProcessEvent } from '../../src/utils/supervisedForwardChild.js';
import { dirIdentity, socketIdentity, directoryPath, socketPath, remoteLocator, tick } from '../support/sshForwardLifecycle.js';
import type { ForwardStart } from '../../src/utils/sshForwardProtocol.js';

const leaseId = '9ffaf922-4131-4a8e-80ef-9513033fb47d';
const start = (): ForwardStart => ({ type: 'start', leaseId, locator: remoteLocator(), directory: { path: directoryPath, identity: dirIdentity }, socketPath,
  acquisitionDeadlineNs: '100000000', operationalDeadlineNs: '300000000', cleanupDeadlineNs: '320000000' });
const ready = () => ({ type: 'ready', leaseId, directory: start().directory, socket: { path: socketPath, identity: socketIdentity } });
const receipt = () => ({ type: 'cleanup', leaseId, directory: start().directory, socket: ready().socket, outcome: { state: 'closed' } });
class FakeProcess implements SupervisorProcess {
  stderr = new PassThrough(); listeners = new Set<(event: SupervisorProcessEvent) => void>(); sent: unknown[] = []; events: string[] = [];
  onSend?: (value: unknown) => void;
  observe(listener: (event: SupervisorProcessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  send(value: unknown) { this.events.push('send'); this.sent.push(structuredClone(value)); this.onSend?.(value); }
  emit(event: SupervisorProcessEvent) { for (const listener of [...this.listeners]) listener(event); }
}
function attach(process = new FakeProcess()) {
  let delegated = false;
  const child = attachSupervisedForwardChild(start(), process, { uid: 123, nowNs: () => 0n, delegateCleanup() { delegated = true; process.events.push('delegate'); } });
  const states: string[] = []; child.observe(state => states.push(state));
  return { process, child, states, delegated: () => delegated };
}

it('revokes manager cleanup authority before start delivery, including a lost acknowledgment', async () => {
  const process = new FakeProcess(); process.onSend = () => { throw new Error('synthetic sensitive diagnostic'); };
  const h = attach(process); assert.deepEqual(process.events.slice(0, 2), ['delegate', 'send']); assert.equal(h.delegated(), true);
  assert.ok(h.states.includes('failed')); process.emit({ type: 'closed' });
  assert.equal(await h.child.delegatedCleanup.receipt, undefined);
  assert.equal(JSON.stringify(process.sent).includes('synthetic sensitive diagnostic'), false);
});

it('readiness is exact, and a valid cleanup receipt is insufficient without supervisor close', async () => {
  const h = attach(); h.process.emit({ type: 'message', value: ready() }); assert.equal(h.states.at(-1), 'running');
  assert.deepEqual(h.child.delegatedCleanup.readySocket(), socketIdentity);
  let resolved = false; void h.child.delegatedCleanup.receipt.then(() => { resolved = true; });
  h.process.emit({ type: 'message', value: receipt() }); await tick(); assert.equal(resolved, false);
  h.process.emit({ type: 'closed' }); assert.deepEqual(await h.child.delegatedCleanup.receipt, { state: 'closed' });
  assert.equal(h.states.at(-1), 'exited');
});

it('manager TERM and KILL requests send a single stop record and never signal the supervisor itself', async () => {
  const h = attach(); h.child.signal('SIGTERM'); h.child.signal('SIGKILL'); h.child.signal('SIGTERM');
  assert.deepEqual(h.process.sent, [start(), { type: 'stop', leaseId }]);
  h.process.emit({ type: 'message', value: ready() }); assert.notEqual(h.states.at(-1), 'running');
  h.process.emit({ type: 'closed' }); assert.equal(await h.child.delegatedCleanup.receipt, undefined);
});

it('supervisor death without a receipt remains unverified even if a receipt arrives late', async () => {
  const h = attach(); h.process.emit({ type: 'message', value: ready() }); h.process.emit({ type: 'closed' });
  const result = await h.child.delegatedCleanup.receipt; assert.equal(result, undefined);
  h.process.emit({ type: 'message', value: receipt() }); assert.equal(await h.child.delegatedCleanup.receipt, result);
  assert.notEqual(h.states.at(-1), 'exited', 'Supervisor close alone does not prove the forwarding child exited');
});

it('an unverified cleanup receipt plus supervisor close does not claim the forwarding child exited', async () => {
  const h = attach(); h.process.emit({ type: 'message', value: { ...receipt(), outcome: { state: 'unverified', reason: 'child_exit_unconfirmed', remaining: ['child', 'directory', 'socket'] } } });
  h.process.emit({ type: 'closed' }); assert.equal((await h.child.delegatedCleanup.receipt)?.state, 'unverified');
  assert.notEqual(h.states.at(-1), 'exited');
});

it('repeated identical receipt is harmless, but a contradictory second receipt prevents closed', async () => {
  const h = attach(); h.process.emit({ type: 'message', value: ready() });
  h.process.emit({ type: 'message', value: receipt() }); h.process.emit({ type: 'message', value: receipt() });
  h.process.emit({ type: 'closed' }); assert.deepEqual(await h.child.delegatedCleanup.receipt, { state: 'closed' });
  const other = attach(); other.process.emit({ type: 'message', value: receipt() });
  other.process.emit({ type: 'message', value: { ...receipt(), socket: null } }); other.process.emit({ type: 'closed' });
  assert.equal(await other.child.delegatedCleanup.receipt, undefined);
});

for (const [name, change] of [
  ['wrong lease', (value: any) => { value.leaseId = '0ffaf922-4131-4a8e-80ef-9513033fb47d'; }],
  ['wrong directory', (value: any) => { value.directory.identity.ino = '99'; }],
  ['wrong socket path', (value: any) => { value.socket.path = '/synthetic/another.sock'; }],
  ['foreign socket owner', (value: any) => { value.socket.identity.uid = 456; }],
  ['replaced socket inode', (value: any) => { value.socket.identity.ino = '999'; }],
  ['missing socket after readiness', (value: any) => { value.socket = null; }],
  ['unknown result field', (value: any) => { value.outcome.safeToRetry = true; }],
  ['unlabelled result', (value: any) => { value.outcome = {}; }],
  ['raw diagnostic', (value: any) => { value.reason = 'sensitive upstream diagnostic'; }],
] as const) it(`rejects ${name} in delegated cleanup evidence`, async () => {
  const h = attach(); h.process.emit({ type: 'message', value: ready() });
  const changed = structuredClone(receipt()); change(changed); h.process.emit({ type: 'message', value: changed }); h.process.emit({ type: 'closed' });
  assert.equal(await h.child.delegatedCleanup.receipt, undefined);
});

it('captured start and ready evidence cannot be altered by later caller mutation', async () => {
  const process = new FakeProcess(); const input = structuredClone(start());
  const child = attachSupervisedForwardChild(input, process, { uid: 123, nowNs: () => 0n, delegateCleanup() {} });
  Object.assign(input.directory.identity, { ino: '88' });
  const evidence = structuredClone(ready()); process.emit({ type: 'message', value: evidence }); Object.assign(evidence.socket.identity, { ino: '77' });
  process.emit({ type: 'message', value: receipt() }); process.emit({ type: 'closed' });
  assert.deepEqual(await child.delegatedCleanup.receipt, { state: 'closed' }); assert.equal(child.delegatedCleanup.readySocket()?.ino, '3');
});

it('captures the owner uid before delayed supervisor evidence arrives', async () => {
  const process = new FakeProcess(); const context = { uid: 123, nowNs: () => 0n, delegateCleanup() {} };
  const child = attachSupervisedForwardChild(start(), process, context); context.uid = 456;
  process.emit({ type: 'message', value: ready() }); process.emit({ type: 'message', value: receipt() }); process.emit({ type: 'closed' });
  assert.deepEqual(await child.delegatedCleanup.receipt, { state: 'closed' });
});
