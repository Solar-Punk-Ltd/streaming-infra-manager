import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { nativeForwardPaths } from '../../utils/nativeSshForward.js';
import { spawnSupervisedForward } from '../../utils/nativeSupervisedForward.js';
import type { SshForwardCleanup } from '../../utils/sshForwardResources.js';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { acquireDockerBeeStream, normalizeDockerBeeAcquisitionOptions, type DockerBeeAcquisitionOptions, type AcquiredDockerBeeStream } from './acquireDockerBeeStream.js';
import { acquireLocalDockerBeeStream, openUnixDockerConnection, type ConnectUnixDocker, type LocalDockerLocator } from './acquireLocalDockerBeeStream.js';
import { beginSshDockerBeeAcquisition, type SshDockerDependencies } from './sshDockerBeeAcquisition.js';
import type { ChequebookDockerTransports } from './ChequebookDockerTransports.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import type { QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';

export type ChequebookTransportCleanup = Readonly<{ leaseId: string }> & SshForwardCleanup;
interface OwnedTransport { dispose(): void; readonly cleanup: Promise<SshForwardCleanup> }
export interface ChequebookTransportDependencies { readonly connectUnix?: ConnectUnixDocker; readonly ssh?: SshDockerDependencies }

function nativeSshDependencies(): SshDockerDependencies {
  return { ...nativeForwardPaths, uid: process.getuid?.() ?? -1, spawn: spawnSupervisedForward,
    connect: openUnixDockerConnection, acquire: acquireDockerBeeStream,
    clock: { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } } };
}

/** Retain ownership before awaiting acquisition. Closed leases leave the set, unverified cleanup remains observable. */
export class OwnedChequebookTransports {
  readonly #owned = new Map<string, OwnedTransport>();
  readonly #connect: ConnectUnixDocker;
  readonly #ssh: SshDockerDependencies;
  #closing = false;
  #shutdown: Promise<readonly ChequebookTransportCleanup[]> | undefined;

  constructor(private readonly registry: ChequebookDockerTransports, dependencies: ChequebookTransportDependencies = {}) {
    this.#connect = dependencies.connectUnix ?? openUnixDockerConnection;
    this.#ssh = dependencies.ssh ?? nativeSshDependencies();
  }

  async acquire(target: FrozenChequebookTarget, options: Readonly<DockerBeeAcquisitionOptions>, signal: AbortSignal): Promise<AcquiredDockerBeeStream> {
    const started = performance.now(); const remoteStarted = this.#ssh.clock.now();
    if (this.#closing || signal.aborted) throw new DockerBeeAcquisitionError();
    const limits = normalizeDockerBeeAcquisitionOptions(structuredClone(options));
    const selected = this.registry.select(target.alias);
    const deadline = started + limits.acquisitionTimeoutMs;
    if (this.#closing || signal.aborted || performance.now() >= deadline) throw new DockerBeeAcquisitionError();
    if (selected.locator.kind === 'unix') {
      return this.local(target, selected.locator, limits, selected.qualify, signal, deadline);
    }
    const locator = selected.locator;
    const handle = beginSshDockerBeeAcquisition(target, async () => locator, limits, this.#ssh, selected.qualify, signal,
      remoteStarted + limits.acquisitionTimeoutMs);
    this.retain(handle);
    return handle.result;
  }

  shutdown(): Promise<readonly ChequebookTransportCleanup[]> {
    if (this.#shutdown) return this.#shutdown;
    this.#closing = true;
    const retained = [...this.#owned.entries()];
    const cleanup = Promise.all(retained.map(async ([leaseId, handle]) => Object.freeze({ leaseId, ...await handle.cleanup })));
    this.#shutdown = cleanup;
    for (const [, handle] of retained) handle.dispose();
    return cleanup;
  }

  private retain(handle: OwnedTransport): void {
    const id = randomUUID(); this.#owned.set(id, handle);
    void handle.cleanup.then(outcome => { if (outcome.state === 'closed') this.#owned.delete(id); });
  }

  private async local(target: FrozenChequebookTarget, locator: LocalDockerLocator, limits: Readonly<Required<DockerBeeAcquisitionOptions>>,
    qualify: QualifiedBeeBridgeExecution, signal: AbortSignal, deadline: number): Promise<AcquiredDockerBeeStream> {
    let raw: Duplex | undefined; let acquired: AcquiredDockerBeeStream | undefined;
    let closing = false; let workDone = false; let rawClosed = false; let reported = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let resolveCleanup!: (outcome: SshForwardCleanup) => void;
    const cleanup = new Promise<SshForwardCleanup>(resolve => { resolveCleanup = resolve; });
    const lifetime = new AbortController();
    const report = (outcome: SshForwardCleanup) => {
      if (reported) return;
      reported = true; clearTimeout(cleanupTimer); signal.removeEventListener('abort', dispose);
      resolveCleanup(outcome);
    };
    const maybeClosed = () => { if (closing && workDone && (!raw || rawClosed)) report(Object.freeze({ state: 'closed' })); };
    const dispose = () => {
      if (!closing) {
        closing = true; lifetime.abort();
        cleanupTimer = setTimeout(() => report(Object.freeze({ state: 'unverified', reason: 'cleanup_failed', remaining: Object.freeze(['socket' as const]) })), limits.cleanupGraceMs);
      }
      if (acquired && !acquired.stream.destroyed) acquired.stream.destroy();
      if (raw && !raw.destroyed) raw.destroy();
      maybeClosed();
    };
    this.retain(Object.freeze({ cleanup, dispose }));
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted || this.#closing) dispose();
    try {
      acquired = await acquireLocalDockerBeeStream(target, async () => locator, limits, qualify, lifetime.signal, path => {
        if (closing || performance.now() >= deadline) throw new DockerBeeAcquisitionError();
        const connection = this.#connect(path); raw = connection.stream;
        raw.on('error', dispose);
        raw.once('close', () => { rawClosed = true; dispose(); });
        if (raw.closed) { rawClosed = true; dispose(); }
        return connection;
      }, deadline);
      if (closing || signal.aborted) throw new DockerBeeAcquisitionError();
      acquired.stream.once('close', dispose); acquired.stream.on('error', dispose);
      return acquired;
    } catch { dispose(); throw new DockerBeeAcquisitionError(); }
    finally { workDone = true; maybeClosed(); }
  }
}
