import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, type TestContext } from 'node:test';
import { remoteLocator } from '../support/sshForwardLifecycle.js';
import type { ForwardStart } from '../../src/utils/sshForwardProtocol.js';
import { nativeForwardPaths } from '../../src/utils/nativeSshForward.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, timeout = 4000): Promise<void> {
  const limit = performance.now() + timeout;
  while (!await check()) { if (performance.now() >= limit) throw new Error('Synthetic condition timed out'); await pause(10); }
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function fixture(t: TestContext, mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 't09-supervisor-'));
  const identity = await nativeForwardPaths.lstat(directory); assert.ok(identity); const path = `${directory}/docker.sock`;
  const manager: ChildProcess = fork(fileURLToPath(new URL('../support/sshManagerFixture.ts', import.meta.url)), [mode], {
    execArgv: ['--import', import.meta.resolve('tsx'), '--conditions=development'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const messages: any[] = []; let closed = false;
  manager.stderr!.resume(); manager.on('error', () => {}); manager.on('close', () => { closed = true; });
  manager.on('message', value => messages.push(value));
  t.after(async () => {
    if (!closed) { manager.kill('SIGTERM'); await until(() => closed).catch(() => { manager.kill('SIGKILL'); }); }
    const supervisor = messages.find(value => value.fixture === 'supervisor')?.pid;
    if (supervisor && alive(supervisor)) {
      process.kill(supervisor, 'SIGTERM'); await until(() => !alive(supervisor)).catch(() => {});
    }
    // The owner must remove the socket. An absent socket allows exact nonrecursive cleanup of a never-delegated directory.
    if (await exists(directory) && !await exists(path)) await rmdir(directory);
    assert.equal(await exists(directory), false, 'Owned fixture directory was not cleaned');
    t.diagnostic(`Verified exact fixture removed: ${directory}`);
  });
  await until(() => messages.some(value => value.fixture === 'supervisor'));
  const now = process.hrtime.bigint();
  const start: ForwardStart = { type: 'start', leaseId: '9ffaf922-4131-4a8e-80ef-9513033fb47d', locator: remoteLocator(), socketPath: path,
    directory: { path: directory, identity },
    acquisitionDeadlineNs: String(now + 2000_000_000n), operationalDeadlineNs: String(now + 2500_000_000n), cleanupDeadlineNs: String(now + 3500_000_000n) };
  t.diagnostic(`Owned Node fixture manager PID ${manager.pid}, supervisor PID ${messages[0].pid}, directory ${directory}`);
  return { directory, manager, messages, start, closed: () => closed, send: () => manager.send(start) };
}

it('independent Node supervisor cleans its child and exact paths after manager SIGKILL', { timeout: 12000 }, async t => {
  const f = await fixture(t); f.send(); await until(() => f.messages.some(value => value.type === 'ready'));
  const childPid = f.messages.find(value => value.fixture === 'child').pid as number;
  assert.equal(alive(childPid), true); f.manager.kill('SIGKILL');
  await until(async () => !alive(childPid) && !await exists(f.directory));
  assert.equal(f.closed(), true); t.diagnostic(`Verified exited synthetic forwarding child PID ${childPid}`);
});

it('parent disconnect during child creation still leaves the supervisor owning and cleaning the new child', { timeout: 12000 }, async t => {
  const f = await fixture(t, 'delay-spawn'); f.send(); await until(() => f.messages.some(value => value.fixture === 'before-spawn'));
  f.manager.kill('SIGKILL'); await until(async () => !await exists(f.directory));
  const supervisor = f.messages.find(value => value.fixture === 'supervisor').pid as number;
  await until(() => !alive(supervisor));
});

it('parent death before start does not claim an undelegated directory was removed', { timeout: 12000 }, async t => {
  const f = await fixture(t); f.manager.kill('SIGKILL');
  const supervisor = f.messages.find(value => value.fixture === 'supervisor').pid as number;
  await until(() => !alive(supervisor)); assert.equal(await exists(f.directory), true);
  assert.equal(f.messages.some(value => value.fixture === 'child'), false);
});

it('a synthetic child that ignores TERM is killed within the inherited cleanup reserve', { timeout: 12000 }, async t => {
  const f = await fixture(t, 'ignore-term'); f.send(); await until(() => f.messages.some(value => value.type === 'ready'));
  const childPid = f.messages.find(value => value.fixture === 'child').pid as number;
  f.manager.kill('SIGKILL'); await until(async () => !alive(childPid) && !await exists(f.directory));
});
