import type { ForwardChild, ForwardChildState, ForwardPathIdentity, SshForwardCleanup } from './sshForwardResources.js';
import type { SshDockerForwardCommand } from '../domain/chequebook/sshDockerForwardCommand.js';
import { isForwardStop, NS_PER_MS, privateForwardIdentity, sameForwardIdentity, validateForwardStart,
  type ForwardCleanupReceipt, type ForwardReady, type OwnedForwardPath, type ValidatedForwardStart } from './sshForwardProtocol.js';

export type SupervisorMessage = ForwardReady | ForwardCleanupReceipt;
export interface SupervisorChannel {
  onMessage(listener: (value: unknown) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  send(value: SupervisorMessage): void;
  finish(): void;
}
export interface SupervisorDependencies {
  nowNs(): bigint;
  schedule(call: () => void, milliseconds: number): () => void;
  readonly uid: number;
  lstat(path: string): Promise<ForwardPathIdentity | null>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  spawn(command: SshDockerForwardCommand): ForwardChild;
}
const ignoreError = () => {};
const NO_START_MS = 1000;
const STDERR_LIMIT = 64 * 1024;

/** One independent process owns one forward and its exact paths. Native creation is supplied separately. */
export function runSshForwardSupervisor(channel: SupervisorChannel, dependencies: SupervisorDependencies): { readonly done: Promise<ForwardCleanupReceipt | undefined> } {
  let resolveDone!: (value: ForwardCleanupReceipt | undefined) => void;
  const done = new Promise<ForwardCleanupReceipt | undefined>(resolve => { resolveDone = resolve; });
  let validated: ValidatedForwardStart | undefined; let attempted = false; let closing = false; let finished = false;
  let child: ForwardChild | undefined; let childState: ForwardChildState = 'starting'; let socket: OwnedForwardPath | undefined;
  let termSent = false; let killSent = false; let initialSocketAbsent = false; let childStarted = false;
  let pending = false; let cleaning = false; let directoryRemoved = false; let socketRemoved = false;
  let fault: Extract<SshForwardCleanup, { state: 'unverified' }>['reason'] | undefined;
  let outcome: ForwardCleanupReceipt | undefined; let closeDeadline = 0n; let stderrBytes = 0;
  let stopAcquisition: (() => void) | undefined; let stopLifetime: (() => void) | undefined; let stopKill: (() => void) | undefined;
  let stopFinal: (() => void) | undefined; let stopPoll: (() => void) | undefined; let unobserve: (() => void) | undefined;
  let wakePoll: (() => void) | undefined;
  const noStartDeadline = dependencies.nowNs() + BigInt(NO_START_MS) * NS_PER_MS;
  const after = (deadline: bigint, call: () => void) => dependencies.schedule(call, Math.max(0, Number(deadline - dependencies.nowNs()) / 1e6));
  const stopNoStart = dependencies.schedule(() => close(), NO_START_MS);
  const offMessage = channel.onMessage(receive); const offDisconnect = channel.onDisconnect(close);

  function exited(): boolean { return !child || childState === 'exited'; }
  function finish(): void {
    if (finished || !exited()) return;
    finished = true; stopNoStart(); stopAcquisition?.(); stopLifetime?.(); stopKill?.(); stopFinal?.(); stopPoll?.();
    offMessage(); offDisconnect(); unobserve?.();
    if (child) { child.stderr.removeListener('data', stderr); child.stderr.removeListener('error', close); child.stderr.on('error', ignoreError); child.stderr.resume(); }
    if (!validated) resolveDone(undefined);
    channel.finish();
  }
  function report(reason?: Extract<SshForwardCleanup, { state: 'unverified' }>['reason']): void {
    if (outcome || !validated) return;
    const remaining = Object.freeze([...(directoryRemoved ? [] : ['directory' as const]), ...(exited() ? [] : ['child' as const]),
      ...(!socketRemoved && (socket || childStarted) ? ['socket' as const] : [])]);
    const result: SshForwardCleanup = reason ? Object.freeze({ state: 'unverified', reason, remaining }) : Object.freeze({ state: 'closed' });
    outcome = Object.freeze({ type: 'cleanup', leaseId: validated.start.leaseId, directory: validated.start.directory, socket: socket ?? null, outcome: result });
    try { channel.send(outcome); } catch { /* The parent treats a lost receipt as unverified. This owner still finishes cleanup. */ }
    resolveDone(outcome);
  }
  function signal(force = false): void {
    if (!child || exited()) return;
    if (!termSent) { termSent = true; try { child.signal('SIGTERM'); } catch { fault ??= 'cleanup_failed'; } }
    if (!exited() && force && !killSent) { killSent = true; try { child.signal('SIGKILL'); } catch { fault ??= 'cleanup_failed'; } }
  }
  function close(): void {
    if (finished) return;
    if (!closing) {
      closing = true; stopNoStart(); stopAcquisition?.(); stopLifetime?.(); stopPoll?.(); wakePoll?.(); wakePoll = undefined;
      if (!validated) { finish(); return; }
      const reserve = validated.cleanupDeadline - validated.operationalDeadline;
      closeDeadline = dependencies.nowNs() + reserve < validated.cleanupDeadline ? dependencies.nowNs() + reserve : validated.cleanupDeadline;
      stopKill = after(dependencies.nowNs() + (closeDeadline - dependencies.nowNs()) / 2n, () => { signal(true); requestCleanup(); });
      stopFinal = after(closeDeadline, () => { signal(true); report(fault ?? (!exited() ? 'child_exit_unconfirmed' : pending ? 'pending_resource' : 'cleanup_failed')); if (exited()) finish(); });
    }
    signal(dependencies.nowNs() >= closeDeadline); requestCleanup();
  }
  function active(): boolean {
    return !closing && !finished && !!validated && dependencies.nowNs() < validated.acquisitionDeadline;
  }
  function stderr(value: unknown): void {
    if (!Buffer.isBuffer(value) || (stderrBytes += value.length) > STDERR_LIMIT) close();
  }
  function observe(state: ForwardChildState): void {
    childState = state;
    if (state === 'failed' || state === 'exited') close();
    if (state === 'exited') { stopKill?.(); requestCleanup(); }
  }
  async function directoryMatches(): Promise<boolean> {
    const directory = validated!.start.directory;
    return sameForwardIdentity(await dependencies.lstat(directory.path), directory.identity);
  }
  async function clean(): Promise<void> {
    if (!validated || pending || !exited()) return;
    if (!await directoryMatches()) { fault ??= 'path_identity_changed'; return; }
    const path = validated.start.socketPath; const current = await dependencies.lstat(path);
    if (current) {
      if (!socket && initialSocketAbsent && childStarted) socket = Object.freeze({ path, identity: privateForwardIdentity(current, 'socket', dependencies.uid) });
      if (!socket || !sameForwardIdentity(current, socket.identity) || !await directoryMatches() ||
          !sameForwardIdentity(await dependencies.lstat(path), socket.identity)) { fault ??= 'path_identity_changed'; return; }
      await dependencies.unlink(path);
    }
    socketRemoved = true;
    if (!await directoryMatches()) { fault ??= 'path_identity_changed'; return; }
    await dependencies.rmdir(validated.start.directory.path); directoryRemoved = true;
  }
  function requestCleanup(): void {
    if (!closing || !validated || finished || pending || cleaning || !exited()) return;
    if (fault) { report(fault); finish(); return; }
    cleaning = true;
    void clean().catch(() => { fault ??= 'cleanup_failed'; }).finally(() => {
      cleaning = false;
      if (directoryRemoved) { report(); finish(); }
      else if (fault) { report(fault); finish(); }
    });
  }
  async function work(): Promise<void> {
    const value = validated!;
    pending = true;
    try {
      if (!active()) return;
      if (!await directoryMatches()) { fault = 'path_identity_changed'; return; }
      if (!active()) return;
      if (await dependencies.lstat(value.start.socketPath)) { fault = 'path_identity_changed'; return; }
      initialSocketAbsent = true;
      if (!active()) return;
      childStarted = true; child = dependencies.spawn(value.command);
      unobserve = child.observe(observe); child.stderr.on('error', close); child.stderr.on('data', stderr);
      if (!active()) { signal(); return; }
      while (active()) {
        if (!await directoryMatches()) { fault = 'path_identity_changed'; return; }
        if (!active()) return;
        const current = await dependencies.lstat(value.start.socketPath);
        if (current) socket = Object.freeze({ path: value.start.socketPath, identity: privateForwardIdentity(current, 'socket', dependencies.uid) });
        if (!active()) return;
        if (socket && childState === 'running') {
          stopAcquisition?.();
          channel.send(Object.freeze({ type: 'ready', leaseId: value.start.leaseId, directory: value.start.directory, socket }));
          return;
        }
        await new Promise<void>(resolve => { wakePoll = resolve; stopPoll = dependencies.schedule(resolve, 10); });
        wakePoll = undefined;
      }
    } finally {
      pending = false;
      if (!socket || childState !== 'running' || !active()) close();
      if (closing) requestCleanup();
    }
  }
  function receive(input: unknown): void {
    if (finished) return;
    if (!attempted && dependencies.nowNs() >= noStartDeadline) { close(); return; }
    if (attempted) { if (validated && isForwardStop(input, validated.start.leaseId)) close(); else close(); return; }
    attempted = true; stopNoStart();
    try {
      validated = validateForwardStart(input, dependencies.nowNs(), dependencies.uid);
      stopAcquisition = after(validated.acquisitionDeadline, close); stopLifetime = after(validated.operationalDeadline, close);
      void work().catch(close);
    } catch { close(); }
  }
  return Object.freeze({ done });
}
