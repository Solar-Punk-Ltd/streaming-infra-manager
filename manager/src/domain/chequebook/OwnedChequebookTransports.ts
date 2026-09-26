import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { nativeForwardPaths } from '../../utils/nativeSshForward.js';
import { spawnSupervisedForward } from '../../utils/nativeSupervisedForward.js';
import type { SshForwardCleanup } from '../../utils/sshForwardResources.js';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { acquireDockerBeeStream, normalizeDockerBeeAcquisitionOptions, type DockerBeeAcquisitionOptions, type AcquiredDockerBeeStream } from './acquireDockerBeeStream.js';
import { acquireLocalDockerBeeStream, connectNativeUnixDocker, type ConnectUnixDocker, type DockerConnectionRole,
  type LocalDockerLocator } from './acquireLocalDockerBeeStream.js';
import { automaticBeeBridgeQualification, type AutomaticBeeBridgeQualification } from './automaticBeeBridgeQualification.js';
import { beginSshDockerBeeAcquisition, type SshDockerDependencies } from './sshDockerBeeAcquisition.js';
import type { ChequebookDockerTransports, SelectedBridgeQualification } from './ChequebookDockerTransports.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import type { QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';
import type { BeeBridgeQualificationStore } from './BeeBridgeQualificationStore.js';

export type ChequebookTransportCleanup = Readonly<{ leaseId: string }> & SshForwardCleanup;
const ignoreProbeError = () => {};
interface OwnedTransport { dispose(): void; readonly cleanup: Promise<SshForwardCleanup> }
export interface ChequebookTransportDependencies {
  readonly connectUnix?: ConnectUnixDocker;
  readonly ssh?: SshDockerDependencies;
  /** Where the manager keeps the images it checked itself. A route that pins no qualification ids refuses without it. */
  readonly bridgeQualifications?: BeeBridgeQualificationStore;
}
type BridgeQualification = QualifiedBeeBridgeExecution | AutomaticBeeBridgeQualification;

function nativeSshDependencies(): SshDockerDependencies {
  return { ...nativeForwardPaths, uid: process.getuid?.() ?? -1, spawn: spawnSupervisedForward,
    connect: connectNativeUnixDocker, acquire: acquireDockerBeeStream,
    clock: { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } } };
}

/** Retain ownership before awaiting acquisition. Closed leases leave the set, unverified cleanup remains observable. */
export class OwnedChequebookTransports {
  readonly #owned = new Map<string, OwnedTransport>();
  readonly #connect: ConnectUnixDocker;
  readonly #ssh: SshDockerDependencies;
  readonly #qualifications: BeeBridgeQualificationStore | undefined;
  #closing = false;
  #shutdown: Promise<readonly ChequebookTransportCleanup[]> | undefined;

  constructor(private readonly registry: ChequebookDockerTransports, dependencies: ChequebookTransportDependencies = {}) {
    this.#connect = dependencies.connectUnix ?? connectNativeUnixDocker;
    this.#ssh = dependencies.ssh ?? nativeSshDependencies();
    this.#qualifications = dependencies.bridgeQualifications;
  }

  async acquire(target: FrozenChequebookTarget, options: Readonly<DockerBeeAcquisitionOptions>, signal: AbortSignal): Promise<AcquiredDockerBeeStream> {
    const started = performance.now(); const remoteStarted = this.#ssh.clock.now();
    if (this.#closing || signal.aborted) throw new DockerBeeAcquisitionError();
    const limits = normalizeDockerBeeAcquisitionOptions(structuredClone(options));
    const selected = this.registry.select(target.alias);
    const deadline = started + limits.acquisitionTimeoutMs;
    if (this.#closing || signal.aborted || performance.now() >= deadline) throw new DockerBeeAcquisitionError();
    const qualification = this.qualification(selected.qualification);
    if (selected.locator.kind === 'unix') {
      return this.local(target, selected.locator, limits, qualification, signal, deadline);
    }
    const locator = selected.locator;
    const handle = beginSshDockerBeeAcquisition(target, async () => locator, limits, this.#ssh, qualification, signal,
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

  private qualification(selected: SelectedBridgeQualification): BridgeQualification {
    if (selected.kind === 'pinned') return selected.qualify;
    if (!this.#qualifications) throw new DockerBeeAcquisitionError('unavailable');
    return automaticBeeBridgeQualification(selected.catalog, this.#qualifications);
  }

  private retain(handle: OwnedTransport): void {
    const id = randomUUID(); this.#owned.set(id, handle);
    void handle.cleanup.then(outcome => { if (outcome.state === 'closed') this.#owned.delete(id); });
  }

  private async local(target: FrozenChequebookTarget, locator: LocalDockerLocator, limits: Readonly<Required<DockerBeeAcquisitionOptions>>,
    qualification: BridgeQualification, signal: AbortSignal, deadline: number): Promise<AcquiredDockerBeeStream> {
    const open = new Set<Duplex>(); let acquired: AcquiredDockerBeeStream | undefined;
    let closing = false; let workDone = false; let reported = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let resolveCleanup!: (outcome: SshForwardCleanup) => void;
    const cleanup = new Promise<SshForwardCleanup>(resolve => { resolveCleanup = resolve; });
    const lifetime = new AbortController();
    const report = (outcome: SshForwardCleanup) => {
      if (reported) return;
      reported = true; clearTimeout(cleanupTimer); signal.removeEventListener('abort', dispose);
      resolveCleanup(outcome);
    };
    const maybeClosed = () => { if (closing && workDone && !open.size) report(Object.freeze({ state: 'closed' })); };
    const dispose = () => {
      if (!closing) {
        closing = true; lifetime.abort();
        cleanupTimer = setTimeout(() => report(Object.freeze({ state: 'unverified', reason: 'cleanup_failed', remaining: Object.freeze(['socket' as const]) })), limits.cleanupGraceMs);
      }
      if (acquired && !acquired.stream.destroyed) acquired.stream.destroy();
      for (const raw of open) if (!raw.destroyed) raw.destroy();
      maybeClosed();
    };
    /** A probe connection closing is its job done. The bridge connection closing ends the lease. */
    const connect = (path: string, role: DockerConnectionRole = 'bridge') => {
      if (closing || performance.now() >= deadline) throw new DockerBeeAcquisitionError();
      const connection = this.#connect(path, role); const raw = connection.stream;
      open.add(raw);
      const closed = () => { open.delete(raw); if (role === 'bridge') dispose(); else maybeClosed(); };
      raw.on('error', role === 'bridge' ? dispose : ignoreProbeError);
      raw.once('close', closed);
      if (raw.closed) closed();
      return connection;
    };
    this.retain(Object.freeze({ cleanup, dispose }));
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted || this.#closing) dispose();
    try {
      acquired = await acquireLocalDockerBeeStream(target, async () => locator, limits, qualification, lifetime.signal, connect, deadline);
      if (closing || signal.aborted) throw new DockerBeeAcquisitionError();
      acquired.stream.once('close', dispose); acquired.stream.on('error', dispose);
      return acquired;
    } catch (error) { dispose(); throw DockerBeeAcquisitionError.keeping(error); }
    finally { workDone = true; maybeClosed(); }
  }
}
