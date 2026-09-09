import { posix } from 'node:path';
import { Duplex } from 'node:stream';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { targetLockIdentity, type FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { requireBeeBindingTarget } from './DockerBeeBinding.js';
import { normalizeDockerBeeAcquisitionOptions, type acquireDockerBeeStream, type AcquiredDockerBeeStream,
  type DockerBeeAcquisitionOptions, type QualifiedBeeBridgeExecution } from './acquireDockerBeeStream.js';
import type { ConnectUnixDocker } from './acquireLocalDockerBeeStream.js';
import { sshDockerForwardCommand, type SshDockerForwardCommand, type TrustedSshDockerLocator } from './sshDockerForwardCommand.js';
import type { ForwardClock, ForwardChild, ForwardChildState, ForwardPathIdentity, ForwardResource as Resource,
  ForwardCleanupReason as CleanupReason, SshForwardCleanup } from '../../utils/sshForwardResources.js';
export type { ForwardClock, ForwardChild, ForwardChildState, ForwardPathIdentity, SshForwardCleanup } from '../../utils/sshForwardResources.js';

interface OwnedForwardDirectory { readonly path: string; readonly identity?: ForwardPathIdentity }
/** Injected resources only. No native process, filesystem adapter or production factory is activated here. */
export interface SshDockerDependencies {
  clock: ForwardClock;
  uid: number;
  /** Return the path immediately after atomic creation, with no fallible metadata work. The owner captures metadata separately. */
  createDirectory(): Promise<string>;
  lstat(path: string): Promise<ForwardPathIdentity | null>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  spawn(command: SshDockerForwardCommand): ForwardChild;
  connect: ConnectUnixDocker;
  acquire: typeof acquireDockerBeeStream;
}
export interface SshDockerAcquisition {
  readonly result: Promise<AcquiredDockerBeeStream>;
  /** Resolves once. A returned unverified observation never becomes closed, even if retained late cleanup subsequently succeeds. */
  readonly cleanup: Promise<SshForwardCleanup>;
  dispose(): void;
}
const ignoreLateError = () => {};
const STDERR_LIMIT = 64 * 1024;
const POLL_MS = 10;

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
function sameIdentity(left: ForwardPathIdentity | null, right: ForwardPathIdentity): boolean {
  return !!left && left.kind === right.kind && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}
function privateIdentity(value: ForwardPathIdentity | undefined | null, kind: 'directory' | 'socket', uid: number): value is ForwardPathIdentity {
  return value?.kind === kind && value.uid === uid && value.mode === (kind === 'directory' ? 0o700 : 0o600) &&
    typeof value.dev === 'string' && !!value.dev && typeof value.ino === 'string' && !!value.ino;
}

/** The remote lease has an operational deadline earlier than its cleanup allowance. Every byte boundary checks it monotonically. */
class ForwardLease extends Duplex {
  #pressured = false;
  constructor(private readonly inner: Duplex, private readonly active: () => boolean, private readonly closeOwner: () => void) {
    super({ allowHalfOpen: true });
    this.on('error', ignoreLateError);
    inner.on('error', this.failed); inner.on('close', this.failed); inner.on('end', this.ended); inner.on('readable', this.onReadable);
  }
  override read(size?: number): Buffer | null {
    if (!this.usable()) return null;
    const value: unknown = super.read(size);
    if (value === null || Buffer.isBuffer(value)) return value;
    this.failed(); return null;
  }
  override _read(): void { this.#pressured = false; this.pump(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.usable() || !Buffer.isBuffer(chunk)) { callback(new DockerBeeAcquisitionError()); return; }
    try { this.inner.write(chunk, error => callback(error || !this.usable() ? new DockerBeeAcquisitionError() : undefined)); }
    catch { this.failed(); callback(new DockerBeeAcquisitionError()); }
  }
  override _final(callback: (error?: Error | null) => void): void {
    if (!this.usable()) { callback(new DockerBeeAcquisitionError()); return; }
    try { this.inner.end(() => callback(this.usable() ? undefined : new DockerBeeAcquisitionError())); }
    catch { this.failed(); callback(new DockerBeeAcquisitionError()); }
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner.removeListener('readable', this.onReadable); this.inner.removeListener('end', this.ended);
    this.inner.removeListener('error', this.failed); this.inner.removeListener('close', this.failed);
    this.inner.on('error', ignoreLateError); if (!this.inner.destroyed) this.inner.destroy();
    this.closeOwner(); callback(error ? new DockerBeeAcquisitionError() : null);
  }
  private usable(): boolean {
    if (this.destroyed || this.inner.destroyed || !this.active()) { this.failed(); return false; }
    return true;
  }
  private readonly failed = () => { if (!this.destroyed) this.destroy(new DockerBeeAcquisitionError()); };
  private readonly ended = () => { if (this.usable()) this.push(null); };
  private readonly onReadable = () => this.pump();
  private pump(): void {
    if (!this.usable() || this.#pressured) return;
    try {
      if (this.inner.readableEncoding || this.inner.readableObjectMode) throw new DockerBeeAcquisitionError();
      while (!this.#pressured && this.usable()) {
        if (!this.inner.readableLength) this.inner.read(0);
        if (!this.inner.readableLength) return;
        const chunk: unknown = this.inner.read(Math.min(this.inner.readableLength, this.readableHighWaterMark));
        if (!Buffer.isBuffer(chunk)) throw new DockerBeeAcquisitionError();
        this.#pressured = !this.push(chunk);
      }
    } catch { this.failed(); }
  }
}

/** Begins one inactive, fully owned forward. All resource construction is supplied by trusted dependencies. */
export function beginSshDockerBeeAcquisition(expected: FrozenChequebookTarget, resolveLocator: (alias: string) => Promise<TrustedSshDockerLocator>,
  options: DockerBeeAcquisitionOptions, dependencies: SshDockerDependencies, qualifyImage: QualifiedBeeBridgeExecution = () => false,
  signal?: AbortSignal): SshDockerAcquisition {
  const clock = dependencies.clock;
  const uid = dependencies.uid;
  const startedAt = clock.now();
  let resolveResult!: (value: AcquiredDockerBeeStream) => void; let rejectResult!: (error: Error) => void;
  let resolveCleanup!: (value: SshForwardCleanup) => void;
  const result = new Promise<AcquiredDockerBeeStream>((yes, no) => { resolveResult = yes; rejectResult = no; });
  result.catch(ignoreLateError);
  const cleanup = new Promise<SshForwardCleanup>(resolve => { resolveCleanup = resolve; });
  let target: FrozenChequebookTarget;
  let limits: Readonly<Required<DockerBeeAcquisitionOptions>>;
  let acquisitionDeadline = startedAt; let operationalDeadline = startedAt; let finalDeadline = startedAt;
  let closing = false; let published = false; let outcomeSent = false; let resourcesClosed = false;
  let directory: OwnedForwardDirectory | undefined; let socket: ForwardPathIdentity | undefined;
  let path: string | undefined; let initialSocketAbsent = false; let spawnCalled = false;
  let child: ForwardChild | undefined; let childState: ForwardChildState = 'starting'; let unobserve: (() => void) | undefined;
  let raw: Duplex | undefined; let acquired: AcquiredDockerBeeStream | undefined; let lease: ForwardLease | undefined;
  let pendingDirectory = false; let pendingHandshake = false;
  let termSent = false; let killSent = false; let cleanupBusy = false; let rerunCleanup = false;
  let cleanupFault: CleanupReason | undefined; let cleanupDeadline = startedAt;
  let cancelAcquisition: (() => void) | undefined; let cancelLifetime: (() => void) | undefined;
  let cancelKill: (() => void) | undefined; let cancelCleanup: (() => void) | undefined; let cancelPoll: (() => void) | undefined;
  let stderrSize = 0;
  const lifetime = new AbortController();

  function remaining(): Resource[] {
    return [...(directory || pendingDirectory ? ['directory' as const] : []), ...(child && childState !== 'exited' ? ['child' as const] : []),
      ...(pendingHandshake || socket || (raw && !raw.destroyed) || (lease && !lease.destroyed) ? ['socket' as const] : [])];
  }
  function report(reason?: CleanupReason): void {
    if (outcomeSent) return;
    const resources = remaining();
    if (!reason && resources.length) return;
    outcomeSent = true;
    resolveCleanup(reason ? Object.freeze({ state: 'unverified', reason, remaining: Object.freeze(resources) }) : Object.freeze({ state: 'closed' }));
    cancelCleanup?.();
  }
  function failCleanup(reason: CleanupReason): void { cleanupFault ??= reason; }
  function cleanupExpired(): void {
    signalChild(true);
    report(cleanupFault ?? (pendingDirectory || pendingHandshake ? 'pending_resource' : child && childState !== 'exited' ? 'child_exit_unconfirmed' : 'cleanup_failed'));
  }
  function signalChild(force = false): void {
    if (!child || childExited()) return;
    if (!termSent) {
      termSent = true;
      try { child.signal('SIGTERM'); } catch { failCleanup('cleanup_failed'); }
    }
    if (childExited()) return;
    if ((force || clock.now() >= cleanupDeadline) && !killSent) {
      killSent = true;
      try { child.signal('SIGKILL'); } catch { failCleanup('cleanup_failed'); }
    }
  }
  function childExited(): boolean { return childState === 'exited'; }
  function disposeStreams(): void {
    if (raw && !raw.destroyed) raw.destroy();
    if (acquired && !acquired.stream.destroyed) acquired.stream.destroy();
    if (lease && !lease.destroyed) lease.destroy();
  }
  function close(): void {
    if (resourcesClosed) return;
    if (!closing) {
      closing = true;
      cleanupDeadline = Math.min(finalDeadline, clock.now() + (limits?.cleanupGraceMs ?? 1));
      cancelAcquisition?.(); cancelLifetime?.(); cancelPoll?.();
      signal?.removeEventListener('abort', close);
      if (!published) rejectResult(new DockerBeeAcquisitionError());
      disposeStreams(); lifetime.abort();
      signalChild();
      cancelKill = clock.schedule(() => { signalChild(true); requestCleanup(); }, Math.max(0, Math.min(1000, (cleanupDeadline - clock.now()) / 2)));
      cancelCleanup = clock.schedule(cleanupExpired, Math.max(0, cleanupDeadline - clock.now()));
    } else { disposeStreams(); signalChild(clock.now() >= cleanupDeadline); }
    requestCleanup();
  }
  function active(requireChild = false): void {
    if (closing || signal?.aborted || clock.now() >= acquisitionDeadline || (requireChild && childState !== 'running')) throw new DockerBeeAcquisitionError();
  }
  function observeChild(state: ForwardChildState): void {
    childState = state;
    if (state === 'failed' || state === 'exited') close();
    if (state === 'exited') { cancelKill?.(); requestCleanup(); }
  }
  const stderrFailed = () => close();
  const stderrData = (value: unknown) => {
    if (!Buffer.isBuffer(value) || (stderrSize += value.length) > STDERR_LIMIT) close();
  };

  function requestCleanup(): void {
    if (!closing) return;
    if (cleanupBusy) { rerunCleanup = true; return; }
    cleanupBusy = true;
    void cleanPaths().catch(() => failCleanup('cleanup_failed')).finally(() => {
      cleanupBusy = false;
      if (rerunCleanup) { rerunCleanup = false; requestCleanup(); }
      else if (!remaining().length && !cleanupFault) finishClosed();
    });
  }
  function finishClosed(): void {
    if (resourcesClosed) return;
    resourcesClosed = true;
    cancelKill?.(); cancelCleanup?.(); cancelPoll?.(); unobserve?.();
    if (child) {
      child.stderr.removeListener('data', stderrData); child.stderr.removeListener('error', stderrFailed);
      child.stderr.on('error', ignoreLateError); child.stderr.resume();
    }
    report();
  }
  async function checkedDirectory(): Promise<boolean> {
    if (!directory) return false;
    if (!directory.identity) { failCleanup('cleanup_failed'); return false; }
    const current = await dependencies.lstat(directory.path);
    if (!privateIdentity(directory.identity, 'directory', uid) || !sameIdentity(current, directory.identity)) { failCleanup('path_identity_changed'); return false; }
    return true;
  }
  async function cleanPaths(): Promise<void> {
    disposeStreams(); signalChild(clock.now() >= cleanupDeadline);
    if (pendingDirectory || pendingHandshake || (child && childState !== 'exited') || !directory || cleanupFault) return;
    if (!await checkedDirectory()) return;
    if (path) {
      const current = await dependencies.lstat(path);
      if (current) {
        if (!socket && spawnCalled && initialSocketAbsent && privateIdentity(current, 'socket', uid)) socket = Object.freeze({ ...current });
        if (!socket || !sameIdentity(current, socket)) { failCleanup('path_identity_changed'); return; }
        if (!await checkedDirectory()) return;
        if (!sameIdentity(await dependencies.lstat(path), socket)) { failCleanup('path_identity_changed'); return; }
        await dependencies.unlink(path);
      }
      socket = undefined;
    }
    if (!await checkedDirectory()) return;
    await dependencies.rmdir(directory.path); directory = undefined;
  }
  async function waitForSocket(): Promise<void> {
    while (true) {
      active();
      if (!await checkedDirectory()) throw new DockerBeeAcquisitionError();
      active();
      const value = await dependencies.lstat(path!);
      active();
      if (value) {
        if (!privateIdentity(value, 'socket', uid)) throw new DockerBeeAcquisitionError();
        socket = Object.freeze({ ...value });
        if (childState === 'running') return;
      }
      await new Promise<void>(resolve => { cancelPoll = clock.schedule(resolve, Math.min(POLL_MS, Math.max(1, acquisitionDeadline - clock.now()))); });
    }
  }
  async function work(): Promise<void> {
    active();
    const located = await resolveLocator(targetLockIdentity(target).alias);
    active();
    const locator = freezeTree(structuredClone(located));
    // Validate trusted routing before creating any local resource. The placeholder is never used for a connection.
    sshDockerForwardCommand(target.alias, locator, { localSocketPath: '/pending/docker.sock', acquisitionTimeoutMs: Math.max(1, Math.floor(acquisitionDeadline - clock.now())) });
    active(); pendingDirectory = true;
    try {
      const created = await dependencies.createDirectory();
      directory = Object.freeze({ path: created });
      if (typeof created !== 'string' || !posix.isAbsolute(created) || posix.normalize(created) !== created || created === '/' || created.endsWith('/') || /[\s:\u0000-\u001f\u007f]/.test(created)) throw new DockerBeeAcquisitionError();
      const identity = await dependencies.lstat(created);
      if (!privateIdentity(identity, 'directory', uid)) { failCleanup('path_identity_changed'); throw new DockerBeeAcquisitionError(); }
      directory = Object.freeze({ path: created, identity: Object.freeze({ ...identity }) });
    } finally { pendingDirectory = false; if (closing) requestCleanup(); }
    active();
    path = `${directory.path}/docker.sock`;
    if (!await checkedDirectory()) throw new DockerBeeAcquisitionError();
    active();
    if (await dependencies.lstat(path)) throw new DockerBeeAcquisitionError();
    initialSocketAbsent = true; active();
    const command = sshDockerForwardCommand(target.alias, locator, { localSocketPath: path, acquisitionTimeoutMs: Math.max(1, Math.floor(acquisitionDeadline - clock.now())) });
    active(); spawnCalled = true;
    child = dependencies.spawn(command);
    unobserve = child.observe(observeChild);
    child.stderr.on('error', stderrFailed); child.stderr.on('data', stderrData);
    if (closing) { close(); throw new DockerBeeAcquisitionError(); }
    active(); await waitForSocket(); active(true);
    const connection = dependencies.connect(path);
    raw = connection.stream; raw.on('error', ignoreLateError);
    const connected = Promise.resolve(connection.connected); connected.catch(ignoreLateError);
    active(true); await connected; active(true);
    if (raw.destroyed) throw new DockerBeeAcquisitionError();
    raw.once('close', close); raw.once('error', close);
    pendingHandshake = true;
    try {
      acquired = await dependencies.acquire(raw, target, { ...limits, acquisitionTimeoutMs: Math.max(1, Math.floor(acquisitionDeadline - clock.now())) },
        qualifyImage, lifetime.signal, acquisitionDeadline);
    } finally { pendingHandshake = false; if (closing) requestCleanup(); }
    active(true);
    if (acquired.stream.destroyed) throw new DockerBeeAcquisitionError();
    const binding = freezeTree(structuredClone(acquired.binding)); requireBeeBindingTarget(binding, target);
    lease = new ForwardLease(acquired.stream, () => !closing && childState === 'running' && clock.now() < operationalDeadline, close);
    active(true);
    published = true; cancelAcquisition?.();
    resolveResult(Object.freeze({ stream: lease, binding }));
  }

  try {
    target = freezeTree(structuredClone(expected)); limits = normalizeDockerBeeAcquisitionOptions(structuredClone(options));
    if (!Number.isSafeInteger(uid) || uid < 0) throw new DockerBeeAcquisitionError();
    targetLockIdentity(target);
    acquisitionDeadline = startedAt + limits.acquisitionTimeoutMs;
    operationalDeadline = acquisitionDeadline + limits.preflightTimeoutMs + limits.postTimeoutMs;
    finalDeadline = operationalDeadline + limits.cleanupGraceMs;
    cancelAcquisition = clock.schedule(close, Math.max(0, acquisitionDeadline - clock.now()));
    cancelLifetime = clock.schedule(close, Math.max(0, operationalDeadline - clock.now()));
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    queueMicrotask(() => { void work().catch(close); });
  } catch { close(); }
  return Object.freeze({ result, cleanup, dispose: close });
}
