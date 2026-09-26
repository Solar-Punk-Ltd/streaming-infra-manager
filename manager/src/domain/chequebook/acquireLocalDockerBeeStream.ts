import net from 'node:net';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import { targetLockIdentity, type FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { acquireDockerBeeStream, normalizeDockerBeeAcquisitionOptions,
  type AcquiredDockerBeeStream, type DockerBeeAcquisitionOptions, type QualifiedBeeBridgeExecution } from './acquireDockerBeeStream.js';
import { isAutomaticBeeBridgeQualification, type AutomaticBeeBridgeQualification } from './automaticBeeBridgeQualification.js';

/** A trusted runtime locator. The connection must separately prove the captured daemon identity. */
export interface LocalDockerLocator { readonly kind: 'unix'; readonly alias: string; readonly socketPath: string }
export type ResolveLocalDockerLocator = (alias: string) => Promise<LocalDockerLocator>;
export interface OwnedUnixConnection { readonly stream: Duplex; readonly connected: Promise<void> }
/** A probe connection reads the image and runs the bridge check, and closes. The bridge connection carries the transfer. */
export type DockerConnectionRole = 'probe' | 'bridge';
/** Ownership begins synchronously, before readiness is awaited. No retry, and at most one connection per role. */
export type ConnectUnixDocker = (socketPath: string, role?: DockerConnectionRole) => OwnedUnixConnection;
type CreateUnixSocket = (options: { path: string }) => Duplex;
const ignoreLateError = () => {};

/** Creates one native Unix connection. The caller owns it even while connection is pending. */
export function openUnixDockerConnection(socketPath: string, createSocket: CreateUnixSocket = options => net.createConnection(options)): OwnedUnixConnection {
  let stream: Duplex | undefined;
  let connected: Promise<void> | undefined;
  try {
    stream = createSocket({ path: socketPath });
    stream.on('error', ignoreLateError);
    let resolve!: () => void; let reject!: (error: Error) => void;
    connected = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const clear = () => { stream!.removeListener('connect', ready); stream!.removeListener('error', failed); stream!.removeListener('close', failed); };
    const ready = () => { clear(); resolve(); };
    const failed = () => { clear(); reject(new DockerBeeAcquisitionError()); };
    stream.once('connect', ready);
    stream.once('error', failed);
    stream.once('close', failed);
    if (stream.destroyed) failed();
    return Object.freeze({ stream, connected });
  } catch {
    connected?.catch(ignoreLateError);
    if (stream && !stream.destroyed) stream.destroy();
    throw new DockerBeeAcquisitionError();
  }
}

/** What is left of the acquisition allowance, refusing once nothing is. */
function remaining(deadline: number): number {
  const milliseconds = Math.floor(deadline - performance.now());
  if (milliseconds < 1) throw new DockerBeeAcquisitionError();
  return milliseconds;
}

/** The native connector every role uses. */
export const connectNativeUnixDocker: ConnectUnixDocker = socketPath => openUnixDockerConnection(socketPath);

function capturedLocator(value: LocalDockerLocator, alias: string): Readonly<LocalDockerLocator> {
  const result = structuredClone(value);
  if (result?.kind !== 'unix' || result.alias !== alias || typeof result.socketPath !== 'string' ||
      !isAbsolute(result.socketPath) || result.socketPath.includes('\0')) throw new DockerBeeAcquisitionError();
  return Object.freeze(result);
}

/** Inactive adapter. Resolution, the probe's connection on an automatic route, the bridge's connection and their handshakes share one acquisition allowance. */
export async function acquireLocalDockerBeeStream(expected: FrozenChequebookTarget, resolveLocator: ResolveLocalDockerLocator,
  options: DockerBeeAcquisitionOptions = {}, qualifyImage: QualifiedBeeBridgeExecution | AutomaticBeeBridgeQualification = () => false,
  signal?: AbortSignal, connectUnix: ConnectUnixDocker = connectNativeUnixDocker, acquisitionDeadlineCap?: number): Promise<AcquiredDockerBeeStream> {
  const startedAt = performance.now();
  let probeRaw: Duplex | undefined;
  let raw: Duplex | undefined;
  let acquired: AcquiredDockerBeeStream | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failed = false;
  let rejectCancelled: ((error: Error) => void) | undefined;
  const dispose = () => {
    if (acquired && !acquired.stream.destroyed) acquired.stream.destroy();
    if (probeRaw && !probeRaw.destroyed) probeRaw.destroy();
    if (raw && !raw.destroyed) raw.destroy();
  };
  const cancel = () => { failed = true; dispose(); rejectCancelled?.(new DockerBeeAcquisitionError()); };
  try {
    const target = structuredClone(expected);
    const limits = normalizeDockerBeeAcquisitionOptions(structuredClone(options));
    const alias = targetLockIdentity(target).alias;
    if (acquisitionDeadlineCap !== undefined && !Number.isFinite(acquisitionDeadlineCap)) throw new DockerBeeAcquisitionError();
    const deadline = Math.min(startedAt + limits.acquisitionTimeoutMs, acquisitionDeadlineCap ?? Infinity);
    const requireActive = () => {
      if (failed || signal?.aborted || performance.now() >= deadline) throw new DockerBeeAcquisitionError();
    };
    requireActive();
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    timer = setTimeout(cancel, Math.max(1, deadline - performance.now()));
    signal?.addEventListener('abort', cancel, { once: true });
    const work = async () => {
      try {
        requireActive();
        const result = await resolveLocator(alias);
        requireActive();
        const locator = capturedLocator(result, alias);
        requireActive();
        let qualify: QualifiedBeeBridgeExecution;
        if (isAutomaticBeeBridgeQualification(qualifyImage)) {
          const probe = connectUnix(locator.socketPath, 'probe');
          probeRaw = probe.stream;
          probeRaw.on('error', ignoreLateError);
          const probed = Promise.resolve(probe.connected);
          probed.catch(ignoreLateError);
          requireActive();
          await probed;
          requireActive();
          qualify = await qualifyImage.probe(probeRaw, target, { ...limits, acquisitionTimeoutMs: remaining(deadline) }, signal, deadline);
          probeRaw.destroy();
          requireActive();
        } else qualify = qualifyImage;
        const connection = connectUnix(locator.socketPath, 'bridge');
        raw = connection.stream;
        raw.on('error', ignoreLateError);
        const connected = Promise.resolve(connection.connected);
        connected.catch(ignoreLateError);
        requireActive();
        await connected;
        requireActive();
        if (raw.destroyed) throw new DockerBeeAcquisitionError();
        acquired = await acquireDockerBeeStream(raw, target, { ...limits, acquisitionTimeoutMs: remaining(deadline) }, qualify, signal, deadline);
        requireActive();
        if (acquired.stream.destroyed) throw new DockerBeeAcquisitionError();
        return acquired;
      } catch (error) { dispose(); throw DockerBeeAcquisitionError.keeping(error); }
    };
    const result = await Promise.race([work(), cancelled]);
    requireActive();
    return result;
  } catch (error) {
    failed = true; dispose(); throw DockerBeeAcquisitionError.keeping(error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
