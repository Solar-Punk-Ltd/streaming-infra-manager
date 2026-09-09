import { PassThrough } from 'node:stream';
import type { AcquiredDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import type { ForwardClock, ForwardChild, ForwardChildState, ForwardPathIdentity, SshDockerDependencies } from '../../src/domain/chequebook/sshDockerBeeAcquisition.js';
import type { TrustedSshDockerLocator } from '../../src/domain/chequebook/sshDockerForwardCommand.js';
import { syntheticTarget } from './syntheticDockerBee.js';

export const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
export function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export class FakeForwardClock implements ForwardClock {
  time = 0;
  tasks = new Set<{ at: number; call: () => void }>();
  now = () => this.time;
  schedule = (call: () => void, ms: number) => { const task = { at: this.time + ms, call }; this.tasks.add(task); return () => { this.tasks.delete(task); }; };
  async advance(ms: number, timers = true) {
    this.time += ms;
    if (timers) {
      for (const task of [...this.tasks].sort((a, b) => a.at - b.at)) if (task.at <= this.time && this.tasks.delete(task)) task.call();
    }
    await tick();
  }
}
export class FakeForwardChild implements ForwardChild {
  stderr = new PassThrough();
  state: ForwardChildState = 'running';
  listeners = new Set<(state: ForwardChildState) => void>();
  exitOn: 'SIGTERM' | 'SIGKILL' | null = 'SIGTERM';
  signals: string[] = [];
  constructor(readonly events: string[]) {}
  observe(listener: (state: ForwardChildState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  signal(value: 'SIGTERM' | 'SIGKILL') { this.events.push(value); this.signals.push(value); if (this.exitOn === value) this.emit('exited'); }
  emit(value: ForwardChildState) { this.state = value; for (const listener of [...this.listeners]) listener(value); }
}
export const directoryPath = '/synthetic/t09-owned';
export const socketPath = `${directoryPath}/docker.sock`;
export const dirIdentity: ForwardPathIdentity = { kind: 'directory', dev: '1', ino: '2', uid: 123, mode: 0o700 };
export const socketIdentity: ForwardPathIdentity = { kind: 'socket', dev: '1', ino: '3', uid: 123, mode: 0o600 };
export const forwardLimits = { acquisitionTimeoutMs: 100, preflightTimeoutMs: 100, postTimeoutMs: 100, cleanupGraceMs: 20 };
export const remoteLocator = (): TrustedSshDockerLocator => ({ kind: 'ssh-unix', alias: syntheticTarget.alias, host: 'example.invalid', port: 22,
  user: 'synthetic', remoteSocketPath: '/run/docker.sock', identityPublicKeyPath: '/synthetic/selected.pub', agentSocketPath: '/synthetic/agent.sock',
  knownHostsPath: '/synthetic/known_hosts', hostKeyAlias: 'synthetic-daemon' });

export function fakeForwardHarness() {
  const events: string[] = []; const clock = new FakeForwardClock(); const child = new FakeForwardChild(events);
  const paths = new Map<string, ForwardPathIdentity>(); const raw = new PassThrough(); const decoded = new PassThrough();
  raw.on('error', () => {}); decoded.on('error', () => {});
  let destroyCount = 0;
  raw.on('close', () => { destroyCount++; });
  const originalDestroy = raw.destroy.bind(raw);
  raw.destroy = (...args) => { if (!raw.destroyed) events.push('raw-dispose'); return originalDestroy(...args); };
  const dependencies: SshDockerDependencies = {
    clock, uid: 123,
    async createDirectory() { events.push('mkdir'); paths.set(directoryPath, { ...dirIdentity }); return { path: directoryPath, identity: { ...dirIdentity } }; },
    async lstat(path) { events.push(`stat:${path}`); return paths.get(path) ?? null; },
    async unlink(path) { events.push('unlink'); paths.delete(path); },
    async rmdir(path) { events.push('rmdir'); if (paths.has(socketPath)) throw new Error('nonempty'); paths.delete(path); },
    spawn(command) { events.push('spawn'); paths.set(socketPath, { ...socketIdentity }); return child; },
    connect(path) { events.push('connect'); return { stream: raw, connected: Promise.resolve() }; },
    async acquire(stream, target, options, qualify, signal, cap) {
      events.push('handshake'); return { stream: decoded, binding: { containerId: 'a'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`,
        daemonId: target.daemonId, project: target.profile.name, service: 'bee-uploader', internalPort: 1633, publishedPort: target.reservation.port } } as AcquiredDockerBeeStream;
    },
  };
  return { events, clock, child, paths, raw, decoded, dependencies, destroyCount: () => destroyCount };
}
