import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ForwardChild, ForwardChildState, ForwardPathIdentity } from './sshForwardResources.js';
import { runSshForwardSupervisor, type SupervisorDependencies, type SupervisorMessage } from './sshForwardSupervisor.js';

/** Metadata only. Directory creation returns its path before any fallible metadata read. */
export const nativeForwardPaths = Object.freeze({
  createDirectory: () => mkdtemp(join(tmpdir(), 'sim-forward-')),
  async lstat(path: string): Promise<ForwardPathIdentity | null> {
    try {
      const stat = await lstat(path, { bigint: true });
      return Object.freeze({ kind: stat.isDirectory() ? 'directory' : stat.isSocket() ? 'socket' : 'other',
        dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), mode: Number(stat.mode & 0o7777n) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Forward path observation failed');
    }
  },
  unlink: (path: string) => unlink(path),
  rmdir: (path: string) => rmdir(path),
});

/** Install listeners immediately. Only close, including stdio completion, is exit evidence. */
export function observeNativeForwardChild(child: ChildProcess): ForwardChild {
  let state: ForwardChildState = 'starting';
  const listeners = new Set<(state: ForwardChildState) => void>();
  const publish = (next: ForwardChildState) => { state = next; for (const listener of [...listeners]) listener(state); };
  child.on('error', () => publish('failed'));
  child.once('spawn', () => { if (state === 'starting') publish('running'); });
  child.once('close', () => publish('exited'));
  const stderr = child.stderr ?? new PassThrough();
  stderr.on('error', () => publish('failed'));
  if (!child.stderr) publish('failed');
  return Object.freeze({ stderr,
    observe(listener: (value: ForwardChildState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    signal(value: 'SIGTERM' | 'SIGKILL') { if (state !== 'exited') child.kill(value); },
  });
}

/** Fixed packaged supervisor entry. Test substitutions are code dependencies, never IPC or environment options. */
export function runNativeSshForwardSupervisor(overrides: Pick<Partial<SupervisorDependencies>, 'spawn'> = {}): void {
  const onMessage = new Set<(value: unknown) => void>(); const onDisconnect = new Set<() => void>();
  const disconnect = () => { for (const listener of [...onDisconnect]) listener(); };
  const message = (value: unknown) => { for (const listener of [...onMessage]) listener(value); };
  process.on('message', message); process.on('disconnect', disconnect); process.on('SIGTERM', disconnect); process.on('SIGINT', disconnect);
  let pendingMessages = 0; let finishing = false;
  const finish = () => {
    if (!finishing || pendingMessages) return;
    process.removeListener('message', message); process.removeListener('disconnect', disconnect);
    process.removeListener('SIGTERM', disconnect); process.removeListener('SIGINT', disconnect);
    if (process.connected) process.disconnect();
  };
  const send = (value: SupervisorMessage) => {
    if (!process.connected || !process.send) return;
    pendingMessages++;
    try { process.send(value, () => { pendingMessages--; finish(); }); }
    catch { pendingMessages--; finish(); }
  };
  runSshForwardSupervisor({
    onMessage(listener) { onMessage.add(listener); return () => { onMessage.delete(listener); }; },
    onDisconnect(listener) { onDisconnect.add(listener); return () => { onDisconnect.delete(listener); }; },
    send, finish() { finishing = true; finish(); },
  }, {
    ...nativeForwardPaths, uid: process.getuid?.() ?? -1, nowNs: () => process.hrtime.bigint(),
    schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); },
    spawn: overrides.spawn ?? (command => observeNativeForwardChild(spawn('/usr/bin/ssh', [...command.args], {
      shell: false, detached: false, stdio: ['ignore', 'ignore', 'pipe'], env: { ...command.options.env },
    }))),
  });
  if (!process.connected) queueMicrotask(disconnect);
}
