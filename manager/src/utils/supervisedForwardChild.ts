import { isDeepStrictEqual } from 'node:util';
import type { Readable } from 'node:stream';
import type { ForwardChild, ForwardChildState, DelegatedForwardCleanup, SshForwardCleanup } from './sshForwardResources.js';
import { privateForwardIdentity, validateForwardStart, type ForwardCleanupReceipt, type ForwardReady, type ForwardStart } from './sshForwardProtocol.js';

export type SupervisorProcessEvent = { readonly type: 'message'; readonly value: unknown } | { readonly type: 'closed' } | { readonly type: 'failed' };
/** Own the process and its error listeners before attaching. A closed event means process and stdio completion. */
export interface SupervisorProcess {
  readonly stderr: Readable;
  observe(listener: (event: SupervisorProcessEvent) => void): () => void;
  send(value: ForwardStart | Readonly<{ type: 'stop'; leaseId: string }>): void;
}
export interface SupervisedForwardChild extends ForwardChild { readonly delegatedCleanup: DelegatedForwardCleanup }
interface OwnershipContext { readonly uid: number; nowNs(): bigint; delegateCleanup(): void }

function exact(value: unknown, fields: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== fields) throw new Error('Invalid forward evidence');
  return value as Record<string, unknown>;
}
function outcome(value: unknown): SshForwardCleanup {
  const input = value as Record<string, unknown>;
  if (input?.state === 'closed') { exact(input, 'state'); return Object.freeze({ state: 'closed' }); }
  const checked = exact(input, 'reason,remaining,state');
  if (checked.state !== 'unverified' || !['pending_resource', 'child_exit_unconfirmed', 'path_identity_changed', 'cleanup_failed'].includes(String(checked.reason)) ||
      !Array.isArray(checked.remaining) || checked.remaining.length > 3 || new Set(checked.remaining).size !== checked.remaining.length ||
      checked.remaining.some(value => !['directory', 'child', 'socket'].includes(value))) throw new Error('Invalid forward outcome');
  return Object.freeze({ state: 'unverified', reason: checked.reason as Extract<SshForwardCleanup, { state: 'unverified' }>['reason'], remaining: Object.freeze([...checked.remaining]) });
}

/** One start, one stop and immutable exact evidence. This wrapper never has a process-kill capability. */
export function attachSupervisedForwardChild(input: ForwardStart, process: SupervisorProcess, context: OwnershipContext): SupervisedForwardChild {
  const uid = context.uid;
  let state: ForwardChildState = 'starting'; let closed = false; let invalid = false; let attempted = false; let stopped = false;
  let start: ForwardStart | undefined; let ready: ForwardReady | undefined; let receipt: ForwardCleanupReceipt | undefined;
  const listeners = new Set<(state: ForwardChildState) => void>();
  let resolveReceipt!: (value: SshForwardCleanup | undefined) => void;
  const completion = new Promise<SshForwardCleanup | undefined>(resolve => { resolveReceipt = resolve; });
  function publish(next: ForwardChildState): void { state = next; for (const listener of [...listeners]) listener(next); }
  function stop(): void {
    if (closed || stopped) return;
    stopped = true;
    try { process.send(Object.freeze({ type: 'stop', leaseId: start?.leaseId ?? 'invalid' })); }
    catch { invalid = true; publish('failed'); }
  }
  function fail(): void { if (closed) return; invalid = true; publish('failed'); stop(); }
  function evidence(value: unknown): void {
    if (!start || !attempted) throw new Error('No delegated start');
    const raw = structuredClone(value) as Record<string, unknown>;
    const isReady = raw?.type === 'ready';
    const message = exact(raw, isReady ? 'directory,leaseId,socket,type' : 'directory,leaseId,outcome,socket,type');
    if (message.leaseId !== start.leaseId || !isDeepStrictEqual(message.directory, start.directory) || (!isReady && message.type !== 'cleanup')) throw new Error('Forward identity conflict');
    let socket: ForwardReady['socket'] | null = null;
    if (message.socket !== null) {
      const supplied = exact(message.socket, 'identity,path');
      if (supplied.path !== start.socketPath) throw new Error('Forward path conflict');
      socket = Object.freeze({ path: start.socketPath, identity: privateForwardIdentity(supplied.identity, 'socket', uid) });
    }
    if (ready && !isDeepStrictEqual(socket, ready.socket)) throw new Error('Forward socket conflict');
    if (isReady) {
      if (!socket || receipt) throw new Error('Invalid forward readiness');
      ready = Object.freeze({ type: 'ready', leaseId: start.leaseId, directory: start.directory, socket });
      if (!invalid && !stopped) publish('running');
    } else {
      const candidate: ForwardCleanupReceipt = Object.freeze({ type: 'cleanup', leaseId: start.leaseId, directory: start.directory, socket, outcome: outcome(message.outcome) });
      if (receipt && !isDeepStrictEqual(receipt, candidate)) throw new Error('Forward receipt conflict');
      receipt = candidate;
    }
  }
  process.observe(event => {
    if (closed) return;
    if (event.type === 'closed') {
      closed = true;
      const proven = !invalid && receipt ? receipt.outcome : undefined;
      resolveReceipt(proven); publish(proven?.state === 'closed' ? 'exited' : 'failed');
    } else if (event.type === 'failed') fail();
    else { try { evidence(event.value); } catch { fail(); } }
  });
  try {
    start = validateForwardStart(input, context.nowNs(), uid).start;
    if (!closed && !invalid) {
      context.delegateCleanup(); attempted = true;
      process.send(start);
    }
  } catch { fail(); }
  return Object.freeze({ stderr: process.stderr, delegatedCleanup: Object.freeze({ leaseId: start?.leaseId ?? '', receipt: completion,
    readySocket: () => ready?.socket.identity }),
    observe(listener: (value: ForwardChildState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    signal: stop,
  });
}
