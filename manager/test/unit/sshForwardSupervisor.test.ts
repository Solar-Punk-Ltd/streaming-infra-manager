import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runSshForwardSupervisor, type SupervisorChannel, type SupervisorDependencies, type SupervisorMessage } from '../../src/utils/sshForwardSupervisor.js';
import { validateForwardStart, type ForwardStart } from '../../src/utils/sshForwardProtocol.js';
import { FakeForwardChild, FakeForwardClock, dirIdentity, socketIdentity, directoryPath, socketPath, remoteLocator, tick, deferred } from '../support/sshForwardLifecycle.js';
import type { ForwardPathIdentity } from '../../src/domain/chequebook/sshDockerBeeAcquisition.js';

const leaseId = '9ffaf922-4131-4a8e-80ef-9513033fb47d';
function start(): ForwardStart {
  return { type: 'start', leaseId, locator: remoteLocator(), directory: { path: directoryPath, identity: { ...dirIdentity } }, socketPath,
    acquisitionDeadlineNs: '100000000', operationalDeadlineNs: '300000000', cleanupDeadlineNs: '320000000' };
}
function harness() {
  const clock = new FakeForwardClock(); const events: string[] = []; const child = new FakeForwardChild(events);
  const paths = new Map<string, ForwardPathIdentity>([[directoryPath, { ...dirIdentity }]]);
  const output: SupervisorMessage[] = []; const commands: unknown[] = [];
  let receive!: (input: unknown) => void; let disconnect!: () => void; let finishes = 0;
  const channel: SupervisorChannel = { onMessage(listener) { receive = listener; return () => {}; },
    onDisconnect(listener) { disconnect = listener; return () => {}; }, send(value) { output.push(value); }, finish() { finishes++; } };
  const dependencies: SupervisorDependencies = {
    nowNs: () => BigInt(Math.floor(clock.now() * 1e6)), schedule: clock.schedule, uid: 123,
    async lstat(path) { events.push(`stat:${path}`); return paths.get(path) ?? null; },
    async unlink(path) { events.push('unlink'); paths.delete(path); },
    async rmdir(path) { events.push('rmdir'); if (paths.has(socketPath)) throw new Error('nonempty'); paths.delete(path); },
    spawn(command) { commands.push(command); events.push('spawn'); paths.set(socketPath, { ...socketIdentity }); return child; },
  };
  const supervisor = runSshForwardSupervisor(channel, dependencies);
  return { clock, events, child, paths, commands, output, dependencies, supervisor, receive: (value: unknown) => receive(value),
    disconnect: () => disconnect(), finishes: () => finishes };
}

it('reconstructs fixed isolated argv from the strict start locator and freezes the ownership receipt', () => {
  const input = start(); const validated = validateForwardStart(input, 0n, 123);
  assert.equal(validated.command.file, '/usr/bin/ssh'); assert.equal(validated.command.options.shell, false);
  assert.deepEqual(validated.command.args.slice(0, 5), ['-F', '/dev/null', '-N', '-T', '-n']);
  input.locator.host = 'changed.invalid'; input.directory.identity.ino = 'changed';
  assert.equal(validated.start.locator.host, 'example.invalid'); assert.equal(validated.start.directory.identity.ino, '2');
  assert.ok(Object.isFrozen(validated.start)); assert.ok(Object.isFrozen(validated.start.directory.identity));
});

for (const [name, change] of [
  ['arbitrary executable', (input: any) => { input.file = '/bin/sh'; }],
  ['arbitrary options', (input: any) => { input.args = ['-c', 'synthetic']; }],
  ['locator proxy', (input: any) => { input.locator.ProxyCommand = 'synthetic'; }],
  ['socket outside directory', (input: any) => { input.socketPath = '/elsewhere/docker.sock'; }],
  ['socket syntax ambiguity', (input: any) => { input.directory.path = '/synthetic/a:b'; input.socketPath = '/synthetic/a:b/docker.sock'; }],
  ['foreign uid', (input: any) => { input.directory.identity.uid = 456; }],
  ['nonprivate directory', (input: any) => { input.directory.identity.mode = 0o755; }],
  ['invalid lease id', (input: any) => { input.leaseId = '../other'; }],
  ['number instead of absolute deadline', (input: any) => { input.acquisitionDeadlineNs = 100; }],
  ['expired acquisition', (input: any) => { input.acquisitionDeadlineNs = '0'; }],
  ['unbounded acquisition', (input: any) => { input.acquisitionDeadlineNs = '31000000000'; }],
  ['reversed operation deadline', (input: any) => { input.operationalDeadlineNs = '1'; }],
  ['unbounded cleanup', (input: any) => { input.cleanupDeadlineNs = '20000000000'; }],
  ['relative directory', (input: any) => { input.directory.path = 'relative'; }],
] as const) it(`refuses ${name} without starting a child or accepting path ownership`, async () => {
  const h = harness(); const input = start(); change(input); h.receive(input); await tick();
  assert.equal(h.commands.length, 0); assert.equal(h.output.some(value => value.type === 'ready'), false);
  assert.equal(h.events.includes('unlink'), false); assert.equal(h.events.includes('rmdir'), false);
  assert.equal(h.finishes(), 1);
});

it('captures socket identity before readiness and cleans only after confirmed child close', async () => {
  const h = harness(); h.receive(start()); await tick();
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.output[0], { type: 'ready', leaseId, directory: start().directory, socket: { path: socketPath, identity: socketIdentity } });
  h.child.exitOn = null; h.receive({ type: 'stop', leaseId }); await tick();
  assert.deepEqual(h.child.signals, ['SIGTERM']); assert.equal(h.events.includes('unlink'), false);
  h.child.emit('exited'); await tick();
  assert.deepEqual(h.events.slice(-2), [`stat:${directoryPath}`, 'rmdir']);
  assert.equal(h.paths.size, 0); assert.equal(h.finishes(), 1);
  const result = await h.supervisor.done;
  assert.equal(result?.outcome.state, 'closed'); assert.ok(Object.isFrozen(result));
  assert.equal(h.output.at(-1), result);
});

it('stops a child on parent disconnect after handoff without a second spawn', async () => {
  const h = harness(); h.receive(start()); await tick(); h.disconnect(); await tick();
  assert.deepEqual(h.child.signals, ['SIGTERM']); assert.equal(h.commands.length, 1);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed'); assert.equal(h.paths.size, 0);
});

for (const event of ['disconnect', 'no-start-budget'] as const) it(`exits on ${event} before start without touching unknown paths`, async () => {
  const h = harness(); if (event === 'disconnect') h.disconnect(); else await h.clock.advance(1000);
  h.receive(start()); await tick();
  assert.equal(h.commands.length, 0); assert.equal(h.events.length, 0); assert.equal(h.finishes(), 1);
  assert.equal(await h.supervisor.done, undefined); assert.equal(h.paths.size, 1);
});

it('honors disconnect during synchronous spawn and immediately owns the returned handle', async () => {
  const h = harness(); const spawn = h.dependencies.spawn;
  h.dependencies.spawn = command => { h.disconnect(); return spawn(command); };
  h.receive(start()); await tick();
  assert.equal(h.commands.length, 1); assert.deepEqual(h.child.signals, ['SIGTERM']);
  assert.equal(h.output.some(value => value.type === 'ready'), false);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed');
});

it('does not start after a blocking metadata read consumes acquisition budget before timers run', async () => {
  const h = harness(); const stat = h.dependencies.lstat;
  h.dependencies.lstat = async path => { h.clock.time = 101; return stat(path); };
  h.receive(start()); await tick();
  assert.equal(h.commands.length, 0); assert.equal(h.output.some(value => value.type === 'ready'), false);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed');
});

it('one start only means a repeated valid start stops rather than extending the lease', async () => {
  const h = harness(); h.receive(start()); await tick(); h.receive(start()); await tick();
  assert.equal(h.commands.length, 1); assert.deepEqual(h.child.signals, ['SIGTERM']);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed');
});

it('operational expiry sends TERM then bounded KILL without restarting cleanup reserve', async () => {
  const h = harness(); h.child.exitOn = 'SIGKILL'; h.receive(start()); await tick();
  await h.clock.advance(300); assert.deepEqual(h.child.signals, ['SIGTERM']);
  await h.clock.advance(10); assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed'); assert.equal(h.finishes(), 1);
});

it('unconfirmed child exit produces stable unverified receipt before retained late cleanup', async () => {
  const h = harness(); h.child.exitOn = null; h.receive(start()); await tick();
  h.receive({ type: 'stop', leaseId }); await tick(); await h.clock.advance(20);
  const result = await h.supervisor.done; assert.equal(result?.outcome.state, 'unverified');
  assert.equal(h.finishes(), 0); assert.equal(h.events.includes('unlink'), false);
  h.child.emit('exited'); await tick();
  assert.equal(h.paths.size, 0); assert.equal(h.finishes(), 1);
  assert.equal(await h.supervisor.done, result); assert.equal(result?.outcome.state, 'unverified');
  assert.equal(h.output.filter(value => value.type === 'cleanup').length, 1);
});

for (const path of [directoryPath, socketPath]) it(`retains replaced ${path === directoryPath ? 'directory' : 'socket'} identity after exit`, async () => {
  const h = harness(); h.receive(start()); await tick();
  h.paths.set(path, { ...h.paths.get(path)!, ino: 'replacement' }); h.disconnect(); await tick();
  assert.equal((await h.supervisor.done)?.outcome.state, 'unverified');
  assert.equal(h.events.includes('unlink'), false); assert.equal(h.events.includes('rmdir'), false);
});

it('child closure before socket identity is obtained never publishes readiness', async () => {
  const h = harness(); const stat = h.dependencies.lstat; const late = deferred<ForwardPathIdentity | null>();
  h.dependencies.lstat = path => path === socketPath && h.commands.length ? late.promise : stat(path);
  h.receive(start()); await tick(); h.child.emit('exited'); late.resolve(socketIdentity); await tick();
  assert.equal(h.output.some(value => value.type === 'ready'), false);
  assert.equal((await h.supervisor.done)?.outcome.state, 'closed');
});

it('counts and discards bounded stderr without forwarding diagnostics into receipts', async () => {
  const h = harness(); h.receive(start()); await tick(); h.child.stderr.write(Buffer.alloc(65537, 'S')); await tick();
  assert.deepEqual(h.child.signals, ['SIGTERM']); assert.equal((await h.supervisor.done)?.outcome.state, 'closed');
  assert.equal(JSON.stringify(h.output).includes('SSSS'), false);
});

it('readiness is refused if a socket appeared before the one owned child started', async () => {
  const h = harness(); h.paths.set(socketPath, socketIdentity); h.receive(start()); await tick();
  assert.equal(h.commands.length, 0); assert.equal(h.output.some(value => value.type === 'ready'), false);
  assert.equal((await h.supervisor.done)?.outcome.state, 'unverified'); assert.equal(h.events.includes('unlink'), false);
});
