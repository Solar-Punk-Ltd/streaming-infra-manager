import { posix } from 'node:path';

/** All methods must use one acquired daemon-bound transport. Implementations must
 * bound response bytes, list every container in every state and honor abort.
 * A mutable target alias or independent reconnecting Docker clients do not satisfy
 * this contract. No production transport is activated by this helper. */
export interface ExecutionDockerReader {
  readDaemonId(signal: AbortSignal): Promise<unknown>;
  listAllContainers(signal: AbortSignal): Promise<unknown>;
  inspectContainer(id: string, signal: AbortSignal): Promise<unknown>;
}
export interface ExecutionMount {
  type: string;
  source: string | null;
  destination: string;
}
export interface ExecutionContainerObservation {
  id: string;
  status: string;
  project: string | null;
  service: string | null;
  workingDirectory: string | null;
  mounts: ExecutionMount[];
}
export type ExecutionCaptureProblem = 'invalid-request' | 'daemon-mismatch' | 'invalid-container-list' |
  'container-set-changed' | 'invalid-container-inspect' | 'reader-failed' | 'limit-exceeded' | 'timed-out';
export type ExecutionMountCapture = {
  state: 'complete'; daemonId: string; containers: ExecutionContainerObservation[]; cleanupAuthorized: false;
} | { state: 'unknown'; reason: ExecutionCaptureProblem; cleanupAuthorized: false };
export interface ExecutionCaptureOptions {
  timeoutMs?: number;
  maxContainers?: number;
  maxMountsPerContainer?: number;
  now?: () => number;
}
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
const MOUNT_TYPES = new Set(['bind', 'volume', 'tmpfs', 'npipe', 'cluster', 'image']);
class CaptureFailure extends Error { constructor(readonly reason: ExecutionCaptureProblem) { super(reason); } }
function fail(reason: ExecutionCaptureProblem): never { throw new CaptureFailure(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'); }
export function normalizedExecutionPath(value: unknown): value is string {
  return boundedText(value) && !value.includes('\\') && posix.isAbsolute(value) && posix.normalize(value) === value &&
    (value === '/' || !value.endsWith('/'));
}
function containerIds(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return fail('invalid-container-list');
  if (raw.length > max) return fail('limit-exceeded');
  const ids = raw.map(row => {
    if (!object(row) || typeof row.Id !== 'string' || !CONTAINER_ID.test(row.Id)) return fail('invalid-container-list');
    return row.Id;
  });
  if (new Set(ids).size !== ids.length) return fail('invalid-container-list');
  return ids.sort();
}
function inspect(raw: unknown, expectedId: string, maxMounts: number): ExecutionContainerObservation {
  if (!object(raw) || raw.Id !== expectedId || !object(raw.State) || typeof raw.State.Status !== 'string' ||
      !STATUSES.has(raw.State.Status) || !Array.isArray(raw.Mounts) || !object(raw.Config)) return fail('invalid-container-inspect');
  if (raw.Mounts.length > maxMounts) return fail('limit-exceeded');
  const labels = raw.Config.Labels;
  if (labels !== undefined && labels !== null && !object(labels)) return fail('invalid-container-inspect');
  function label(key: string): string | null {
    const value = object(labels) ? labels[key] : undefined;
    if (value === undefined) return null;
    if (!boundedText(value)) return fail('invalid-container-inspect');
    return value;
  }
  const workingDirectory = label('com.docker.compose.project.working_dir');
  if (workingDirectory !== null && !normalizedExecutionPath(workingDirectory)) return fail('invalid-container-inspect');
  const mounts = raw.Mounts.map((mount): ExecutionMount => {
    if (!object(mount) || typeof mount.Type !== 'string' || !MOUNT_TYPES.has(mount.Type) ||
        !normalizedExecutionPath(mount.Destination)) return fail('invalid-container-inspect');
    const source = mount.Source ?? null;
    if ((mount.Type === 'bind' && source === null) || (source !== null && !normalizedExecutionPath(source))) return fail('invalid-container-inspect');
    return { type: mount.Type, source, destination: mount.Destination };
  });
  return { id: expectedId, status: raw.State.Status, project: label('com.docker.compose.project'),
    service: label('com.docker.compose.service'), workingDirectory, mounts };
}

/** A consistent double list is observational evidence only. It cannot prove that
 * an active or orphaned launcher will not create another container afterward. */
export async function captureExecutionMounts(
  reader: ExecutionDockerReader, expected: { daemonId: string }, options: ExecutionCaptureOptions = {},
): Promise<ExecutionMountCapture> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const daemonId = expected.daemonId;
    const timeoutMs = options.timeoutMs ?? 15000;
    const maxContainers = options.maxContainers ?? 4096;
    const maxMounts = options.maxMountsPerContainer ?? 256;
    const now = options.now ?? (() => performance.now());
    const started = now();
    if (!boundedText(daemonId) || !Number.isFinite(started) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isInteger(maxContainers) || maxContainers < 0 || maxContainers > 4096 ||
        !Number.isInteger(maxMounts) || maxMounts < 0 || maxMounts > 256) return fail('invalid-request');
    const deadline = started + timeoutMs;
    const readDaemon = reader.readDaemonId.bind(reader);
    const listAll = reader.listAllContainers.bind(reader);
    const readContainer = reader.inspectContainer.bind(reader);
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new CaptureFailure('timed-out')); }, timeoutMs);
    });
    async function read<T>(operation: () => Promise<T>): Promise<T> {
      const check = () => { const current = now(); if (!Number.isFinite(current) || current < started || current >= deadline) fail('timed-out'); };
      check();
      const result = await Promise.race([operation(), expired]);
      check();
      return result;
    }
    const signal = controller.signal;
    if (await read(() => readDaemon(signal)) !== daemonId) return fail('daemon-mismatch');
    const ids = containerIds(await read(() => listAll(signal)), maxContainers);
    const containers: ExecutionContainerObservation[] = [];
    for (const id of ids) containers.push(inspect(await read(() => readContainer(id, signal)), id, maxMounts));
    const finalIds = containerIds(await read(() => listAll(signal)), maxContainers);
    if (ids.length !== finalIds.length || ids.some((id, index) => id !== finalIds[index])) return fail('container-set-changed');
    if (await read(() => readDaemon(signal)) !== daemonId) return fail('daemon-mismatch');
    return { state: 'complete', daemonId, containers, cleanupAuthorized: false };
  } catch (error) {
    return { state: 'unknown', reason: error instanceof CaptureFailure ? error.reason : 'reader-failed', cleanupAuthorized: false };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
