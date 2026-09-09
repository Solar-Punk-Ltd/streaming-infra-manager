import { isDeepStrictEqual } from 'node:util';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseStackContract, stackVersionNameProblem, type StackContract } from '@streaming-infra-manager/common';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, buildIdProblem, parseBuildManifestBytes } from '../versions/buildManifest.js';
import { inventoryOwnedTree, ownedTreeDigest, sha256 } from '../versions/ownedTreeInventory.js';
import { assertOwnedVersionParent } from '../versions/ownedVersionParent.js';
import { buildDirFor, versionRootFor } from '../versions/stackPaths.js';
import type { StackVersionRecord } from '../versions/StackVersionRepository.js';

type RecoveryVersion = Pick<StackVersionRecord, 'id' | 'name' | 'rootPath' | 'layout' | 'buildId' | 'commitSha' | 'contract'>;
export type RolloutRecoveryDescriptor = {
  format: 1;
  kind: 'immutable-build';
  version: RecoveryVersion & { layout: 'builds'; rootPath: string; buildId: string; commitSha: string; contract: StackContract };
  artifactDigest: string;
  manifestHash: string;
  completeHash: string;
} | {
  format: 1;
  kind: 'legacy-unproven';
  version: RecoveryVersion & { layout: 'legacy' };
  reason: 'mutable-legacy-source';
  artifactDigest?: never;
};

export type RolloutRecoveryCapture = (version: StackVersionRecord, versionsRoot: string) => Promise<RolloutRecoveryDescriptor>;
const INVALID = 'Invalid rollout recovery descriptor.';
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{7,40}$/;
const VERSION_KEYS = ['id', 'name', 'rootPath', 'layout', 'buildId', 'commitSha', 'contract'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

export function recoveryVersionOf(version: RecoveryVersion): RecoveryVersion {
  return structuredClone({ id: version.id, name: version.name, rootPath: version.rootPath, layout: version.layout,
    buildId: version.buildId, commitSha: version.commitSha, contract: version.contract });
}

function assertRecoveryVersion(version: unknown): asserts version is RecoveryVersion {
  if (!isRecord(version) || !exactKeys(version, VERSION_KEYS) || !Number.isSafeInteger(version.id) || (version.id as number) < 1 ||
      typeof version.name !== 'string' || stackVersionNameProblem(version.name) ||
      (version.layout !== 'legacy' && version.layout !== 'builds') ||
      (version.rootPath !== null && (typeof version.rootPath !== 'string' || !isAbsolute(version.rootPath) || resolve(version.rootPath) !== version.rootPath)) ||
      (version.buildId !== null && (typeof version.buildId !== 'string' || buildIdProblem(version.buildId))) ||
      (version.commitSha !== null && (typeof version.commitSha !== 'string' || !COMMIT.test(version.commitSha))) ||
      (version.contract !== null && !isDeepStrictEqual(parseStackContract(version.contract), version.contract))) throw new Error(INVALID);
  if (version.layout === 'builds' && (!version.rootPath || !version.buildId || !version.commitSha || !version.contract)) throw new Error(INVALID);
}

/** Null is historical absence. Malformed evidence must never be promoted into recovery authority. */
export function parseRolloutRecoveryDescriptor(value: unknown): RolloutRecoveryDescriptor | null {
  if (value === null) return null;
  if (!isRecord(value) || value.format !== 1) throw new Error(INVALID);
  assertRecoveryVersion(value.version);
  const version = value.version;
  if (value.kind === 'immutable-build') {
    if (!exactKeys(value, ['format', 'kind', 'version', 'artifactDigest', 'manifestHash', 'completeHash']) ||
        version.layout !== 'builds' || !version.rootPath || !version.buildId || !version.commitSha || !version.contract ||
        [value.artifactDigest, value.manifestHash, value.completeHash].some(hash => typeof hash !== 'string' || !HASH.test(hash))) throw new Error(INVALID);
  } else if (value.kind === 'legacy-unproven') {
    if (!exactKeys(value, ['format', 'kind', 'version', 'reason']) || version.layout !== 'legacy' || value.reason !== 'mutable-legacy-source') throw new Error(INVALID);
  } else throw new Error(INVALID);
  return structuredClone(value) as RolloutRecoveryDescriptor;
}

function artifactRoot(version: RecoveryVersion, versionsRoot: string): string {
  if (version.layout !== 'builds' || !version.buildId || version.rootPath !== versionRootFor(versionsRoot, version.name)) {
    throw new Error('Recovery artifact root differs from its configured version parent.');
  }
  assertOwnedVersionParent(versionsRoot);
  const root = buildDirFor(versionsRoot, version.name, version.buildId);
  assertOwnedVersionParent(root);
  return root;
}

/** Metadata is bounded before it is read inside the admission transaction. Payload hashing stays outside. */
function evidenceBytes(root: string, file: string): Buffer {
  const limit = file === BUILD_MANIFEST_FILE ? 65536 : 4096;
  assertOwnedVersionParent(root);
  const path = join(root, file);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Recovery evidence must be a regular file, never a symbolic link.');
  if (before.size > BigInt(limit)) throw new Error('Recovery evidence exceeds its bounded size limit.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (length > limit) throw new Error('Recovery evidence exceeds its bounded size limit.');
    if ([opened, after, current].some(info => !info.isFile() || info.isSymbolicLink() || info.dev !== before.dev || info.ino !== before.ino ||
      info.size !== before.size || info.mode !== before.mode || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs)) throw new Error('Recovery evidence changed while reading.');
    assertOwnedVersionParent(root);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

function evidenceOf(version: RecoveryVersion, versionsRoot: string) {
  const root = artifactRoot(version, versionsRoot);
  const manifestBytes = evidenceBytes(root, BUILD_MANIFEST_FILE);
  const completeBytes = evidenceBytes(root, BUILD_COMPLETE_MARKER);
  const manifest = parseBuildManifestBytes(manifestBytes, join(root, BUILD_MANIFEST_FILE)).manifest;
  if (manifest?.buildId !== version.buildId || manifest.commit !== version.commitSha) throw new Error('Recovery manifest does not match the selected build identity.');
  return { root, manifestHash: sha256(manifestBytes), completeHash: sha256(completeBytes) };
}

/** The caller guarantees immutable source ownership. Existing mutable runtime callers must not activate this API. */
export async function captureRolloutRecovery(
  input: StackVersionRecord,
  versionsRoot: string,
  options: { afterInventory?: () => Promise<void> } = {},
): Promise<RolloutRecoveryDescriptor> {
  const version = recoveryVersionOf(input);
  assertRecoveryVersion(version);
  if (version.layout === 'legacy') {
    return parseRolloutRecoveryDescriptor({ format: 1, kind: 'legacy-unproven', version, reason: 'mutable-legacy-source' })!;
  }
  const evidence = evidenceOf(version, versionsRoot);
  const inventory = await inventoryOwnedTree(evidence.root);
  await options.afterInventory?.();
  if (!isDeepStrictEqual(await inventoryOwnedTree(evidence.root), inventory) ||
      !isDeepStrictEqual(evidenceOf(version, versionsRoot), evidence)) throw new Error('Recovery source changed during capture.');
  return parseRolloutRecoveryDescriptor({ format: 1, kind: 'immutable-build', version,
    artifactDigest: ownedTreeDigest(inventory),
    manifestHash: evidence.manifestHash, completeHash: evidence.completeHash })!;
}

/** The current version/profile locks are held. This checks exact bounded evidence, never scans payload files. */
export function validateCapturedRecovery(descriptor: RolloutRecoveryDescriptor, version: StackVersionRecord, versionsRoot: string): void {
  const captured = parseRolloutRecoveryDescriptor(descriptor)!;
  if (!isDeepStrictEqual(captured.version, recoveryVersionOf(version))) throw new Error('Recovery selected version identity changed.');
  if (captured.kind === 'immutable-build') {
    const current = evidenceOf(version, versionsRoot);
    if (current.manifestHash !== captured.manifestHash || current.completeHash !== captured.completeHash) throw new Error('Recovery evidence changed after capture.');
  }
}
