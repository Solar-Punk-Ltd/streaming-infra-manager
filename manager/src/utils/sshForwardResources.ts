import type { Readable } from 'node:stream';

export interface ForwardClock { now(): number; schedule(call: () => void, milliseconds: number): () => void }
export interface ForwardPathIdentity { readonly kind: 'directory' | 'socket' | 'other'; readonly dev: string; readonly ino: string; readonly uid: number; readonly mode: number }
export interface OwnedForwardPath { readonly path: string; readonly identity: ForwardPathIdentity }
export interface ForwardSpawnOwnership {
  readonly directory: OwnedForwardPath;
  readonly socketPath: string;
  readonly acquisitionDeadlineMs: number;
  readonly operationalDeadlineMs: number;
  readonly cleanupDeadlineMs: number;
  /** Call immediately before attempted start delivery. Lost acknowledgment never restores manager cleanup authority. */
  delegateCleanup(): void;
}
export interface DelegatedForwardCleanup {
  readonly leaseId: string;
  /** Bound to this lease and exact paths. Closed requires both the valid receipt and supervisor close. */
  readonly receipt: Promise<SshForwardCleanup | undefined>;
  readySocket(): ForwardPathIdentity | undefined;
}
export type ForwardChildState = 'starting' | 'running' | 'failed' | 'exited';
/** The factory owns errors before returning. Observation immediately replays durable state, including a synchronous exit. */
export interface ForwardChild {
  readonly stderr: Readable;
  readonly delegatedCleanup?: DelegatedForwardCleanup;
  observe(listener: (state: ForwardChildState) => void): () => void;
  signal(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export type ForwardResource = 'directory' | 'child' | 'socket';
export type ForwardCleanupReason = 'pending_resource' | 'child_exit_unconfirmed' | 'path_identity_changed' | 'cleanup_failed';
export type SshForwardCleanup = Readonly<{ state: 'closed' }> |
  Readonly<{ state: 'unverified'; reason: ForwardCleanupReason; remaining: readonly ForwardResource[] }>;
