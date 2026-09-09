import { posix } from 'node:path';
import { targetAlias } from '../ports/DeployTargets.js';
import { assertExecutionId, assertExecutionRegistration, executionRootPath, type ExecutionRootRecord, type ExecutionSource } from './ExecutionRoot.js';
import { captureExecutionMounts, normalizedExecutionPath, type ExecutionCaptureOptions, type ExecutionContainerObservation, type ExecutionDockerReader, type ExecutionMountCapture } from './executionMountCapture.js';

export interface ExecutionMountRegistry {
  daemonId: string;
  executionsParent: string;
  records: ExecutionRootRecord[];
}
export interface ExecutionDependency { executionId: string; source: ExecutionSource }
export type ExecutionAttribution = {
  state: 'registered-execution'; executionId: string; source: ExecutionSource;
  profile: ExecutionRootRecord['profile']; jobReferenceId: number;
} | { state: 'unknown'; reason: 'no-registered-working-directory' | 'unverified-compose-identity' | 'unregistered-execution-mount' }
  | { state: 'ambiguous'; reason: 'mixed-execution-roots' };
export interface AttributedExecutionContainer extends ExecutionContainerObservation {
  dependencies: ExecutionDependency[];
  dependencyState: 'none' | 'single' | 'multiple' | 'unknown';
  unmatchedBindSources: string[];
  workingDirectoryExecutionId: string | null;
  attribution: ExecutionAttribution;
}
export type ExecutionMountObservation = {
  state: 'complete'; daemonId: string; containers: AttributedExecutionContainer[]; cleanupAuthorized: false;
} | Extract<ExecutionMountCapture, { state: 'unknown' }>
  | { state: 'unknown'; reason: 'invalid-registry'; cleanupAuthorized: false };
const UNRELEASED = new Set(['registered', 'copying', 'ready', 'launch-uncertain', 'deleting']);
function contains(root: string, path: string): boolean { return path === root || path.startsWith(root === '/' ? root : `${root}/`); }
function validateRegistry(input: ExecutionMountRegistry): ExecutionRootRecord[] {
  if (typeof input.daemonId !== 'string' || !input.daemonId.trim() || input.daemonId.length > 4096 || input.daemonId.includes('\0') ||
      !normalizedExecutionPath(input.executionsParent) || !Array.isArray(input.records) || input.records.length > 10000) throw new Error('Invalid registry.');
  const ids = new Set<string>(); const roots = new Set<string>(); const jobs = new Set<number>(); const references = new Set<number>();
  for (const record of input.records) {
    assertExecutionRegistration(record);
    targetAlias(record.target.alias);
    if (record.project !== record.profile.name || !UNRELEASED.has(record.state) ||
        !normalizedExecutionPath(record.source.root) || !normalizedExecutionPath(record.root) ||
        record.root !== executionRootPath(input.executionsParent, record.executionId) ||
        !Number.isSafeInteger(record.referenceId) || record.referenceId < 1 ||
        !(record.createdAt instanceof Date) || !Number.isFinite(record.createdAt.valueOf()) ||
        ids.has(record.executionId) || roots.has(`${record.target.daemonId}\0${record.root}`) || jobs.has(record.jobReferenceId) || references.has(record.referenceId)) {
      throw new Error('Invalid registry.');
    }
    if (record.copyToken !== null) assertExecutionId(record.copyToken);
    if (['copying', 'ready', 'launch-uncertain'].includes(record.state) && record.copyToken === null) throw new Error('Invalid registry.');
    ids.add(record.executionId); roots.add(`${record.target.daemonId}\0${record.root}`); jobs.add(record.jobReferenceId); references.add(record.referenceId);
  }
  return input.records.filter(record => record.target.daemonId === input.daemonId);
}
function containingRecord(path: string, roots: Map<string, ExecutionRootRecord>): ExecutionRootRecord | undefined {
  let ancestor = path;
  while (true) {
    const record = roots.get(ancestor);
    if (record) return record;
    const next = posix.dirname(ancestor);
    if (next === ancestor) return undefined;
    ancestor = next;
  }
}
function descendantRecords(records: ExecutionRootRecord[]): Map<string, ExecutionRootRecord[]> {
  const descendants = new Map<string, ExecutionRootRecord[]>();
  for (const record of records) {
    let ancestor = posix.dirname(record.root);
    while (true) {
      const rows = descendants.get(ancestor) ?? [];
      rows.push(record);
      descendants.set(ancestor, rows);
      const next = posix.dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }
  return descendants;
}
function attribute(container: ExecutionContainerObservation, roots: Map<string, ExecutionRootRecord>,
  descendants: Map<string, ExecutionRootRecord[]>, workingDirectories: Map<string, ExecutionRootRecord>, parent: string): AttributedExecutionContainer {
  const dependencies = new Map<string, ExecutionDependency>();
  const unmatched = new Set<string>();
  for (const mount of container.mounts) {
    if (mount.type !== 'bind' || mount.source === null) continue;
    const record = containingRecord(mount.source, roots);
    const matches = record ? [record] : descendants.get(mount.source) ?? [];
    for (const match of matches) dependencies.set(match.executionId, { executionId: match.executionId, source: match.source });
    if (matches.length === 0) unmatched.add(mount.source);
  }
  const working = container.workingDirectory === null ? undefined : workingDirectories.get(container.workingDirectory);
  const unknownExecutionMount = [...unmatched].some(path => contains(parent, path));
  let attribution: ExecutionAttribution;
  if (!working) attribution = { state: 'unknown', reason: 'no-registered-working-directory' };
  else if ([...dependencies.keys()].some(id => id !== working.executionId)) attribution = { state: 'ambiguous', reason: 'mixed-execution-roots' };
  else if (unknownExecutionMount) attribution = { state: 'unknown', reason: 'unregistered-execution-mount' };
  else if (container.project !== working.project || container.service === null || !working.services.includes(container.service)) {
    attribution = { state: 'unknown', reason: 'unverified-compose-identity' };
  } else attribution = { state: 'registered-execution', executionId: working.executionId, source: working.source,
    profile: working.profile, jobReferenceId: working.jobReferenceId };
  return { ...container, dependencies: [...dependencies.values()].sort((a, b) => a.executionId.localeCompare(b.executionId)),
    dependencyState: unknownExecutionMount ? 'unknown' : dependencies.size > 1 ? 'multiple' : dependencies.size === 1 ? 'single' : 'none',
    unmatchedBindSources: [...unmatched].sort(), workingDirectoryExecutionId: working?.executionId ?? null, attribution };
}

/** Matching a registered working directory and Compose identity attributes the
 * recorded execution. Bind dependencies are independent of that provenance.
 * They cover registered execution copies, including copies below a mounted
 * ancestor. Direct mounts of source artifacts remain unmatched evidence here.
 * Neither result proves launcher termination, runtime configuration or permission
 * to retire a source/copy. No registered match is not evidence of safe removal. */
export async function observeExecutionMounts(
  reader: ExecutionDockerReader, registry: ExecutionMountRegistry, options: ExecutionCaptureOptions = {},
): Promise<ExecutionMountObservation> {
  let input: ExecutionMountRegistry; let records: ExecutionRootRecord[];
  try { input = structuredClone(registry); records = validateRegistry(input); }
  catch { return { state: 'unknown', reason: 'invalid-registry', cleanupAuthorized: false }; }
  const captured = await captureExecutionMounts(reader, { daemonId: input.daemonId }, options);
  if (captured.state !== 'complete') return captured;
  const roots = new Map(records.map(record => [record.root, record]));
  const descendants = descendantRecords(records);
  const workingDirectories = new Map(records.map(record => [posix.join(record.root, 'deploy'), record]));
  return { state: 'complete', daemonId: captured.daemonId,
    containers: captured.containers.map(container => attribute(container, roots, descendants, workingDirectories, input.executionsParent)), cleanupAuthorized: false };
}
