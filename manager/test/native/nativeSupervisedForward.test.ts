import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { createNativeSupervisorProcess, spawnSupervisedForward } from '../../src/utils/nativeSupervisedForward.js';
import { nativeForwardPaths } from '../../src/utils/nativeSshForward.js';
import { openUnixDockerConnection } from '../../src/domain/chequebook/acquireLocalDockerBeeStream.js';
import { sshDockerForwardCommand } from '../../src/domain/chequebook/sshDockerForwardCommand.js';
import { remoteLocator } from '../support/sshForwardLifecycle.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const end = performance.now() + timeout;
  while (!check()) { if (performance.now() >= end) throw new Error('Owned synthetic fixture timed out'); await pause(10); }
}
async function absent(path: string): Promise<boolean> { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; } }

it('actual native IPC delegates one binary Unix connection and observes exact cleanup without a manager second cleaner', { timeout: 12000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 't09-managed-')); const socketPath = `${directory}/docker.sock`;
  const identity = await nativeForwardPaths.lstat(directory); assert.ok(identity);
  let supervisor: ChildProcess | undefined; let supervisorClosed = false; let delegated = false; let running = false;
  const now = performance.now();
  const command = sshDockerForwardCommand(remoteLocator().alias, remoteLocator(), { localSocketPath: socketPath, acquisitionTimeoutMs: 2000 });
  const child = spawnSupervisedForward(command, { directory: { path: directory, identity }, socketPath,
    acquisitionDeadlineMs: now + 2000, operationalDeadlineMs: now + 2500, cleanupDeadlineMs: now + 3500,
    delegateCleanup() { delegated = true; },
  }, { uid: process.getuid!(), nowNs: () => process.hrtime.bigint(), nowMs: () => performance.now(), leaseId: randomUUID,
    createProcess: () => createNativeSupervisorProcess(() => {
      supervisor = fork(fileURLToPath(new URL('../support/sshSupervisorFixture.ts', import.meta.url)), ['quiet'], {
        execArgv: ['--import', import.meta.resolve('tsx'), '--conditions=development'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
      supervisor.on('close', () => { supervisorClosed = true; }); return supervisor;
    }),
  });
  child.stderr.resume(); child.observe(state => { running = state === 'running'; });
  t.diagnostic(`Owned supervisor PID ${supervisor!.pid}, directory ${directory}`);
  t.after(async () => {
    child.signal('SIGTERM'); await until(() => supervisorClosed);
    if (!delegated && !await absent(directory) && await absent(socketPath)) await rmdir(directory);
    assert.equal(await absent(directory), true, 'Supervisor did not clean its delegated directory');
    t.diagnostic(`Verified exact supervisor close and directory removal: ${directory}`);
  });
  await until(() => running); assert.equal(delegated, true);
  const connection = openUnixDockerConnection(socketPath); t.after(() => connection.stream.destroy()); await connection.connected;
  const expected = Buffer.from([0, 255, 1, 128, 13, 10]); const seen: Buffer[] = [];
  connection.stream.on('data', value => seen.push(Buffer.from(value))); connection.stream.write(expected);
  await until(() => Buffer.concat(seen).length === expected.length); assert.deepEqual(Buffer.concat(seen), expected);
  child.signal('SIGTERM'); child.signal('SIGKILL');
  assert.deepEqual(await child.delegatedCleanup.receipt, { state: 'closed' });
  assert.equal(supervisorClosed, true); assert.equal(await absent(directory), true);
});
