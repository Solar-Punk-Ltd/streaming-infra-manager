import type { Readable } from 'node:stream';

export interface ForwardClock { now(): number; schedule(call: () => void, milliseconds: number): () => void }
export interface ForwardPathIdentity { readonly kind: 'directory' | 'socket' | 'other'; readonly dev: string; readonly ino: string; readonly uid: number; readonly mode: number }
export type ForwardChildState = 'starting' | 'running' | 'failed' | 'exited';
/** The factory owns errors before returning. Observation immediately replays durable state, including a synchronous exit. */
export interface ForwardChild {
  readonly stderr: Readable;
  observe(listener: (state: ForwardChildState) => void): () => void;
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export type ForwardResource = 'directory' | 'child' | 'socket';
export type ForwardCleanupReason = 'pending_resource' | 'child_exit_unconfirmed' | 'path_identity_changed' | 'cleanup_failed';
export type SshForwardCleanup = Readonly<{ state: 'closed' }> |
  Readonly<{ state: 'unverified'; reason: ForwardCleanupReason; remaining: readonly ForwardResource[] }>;
