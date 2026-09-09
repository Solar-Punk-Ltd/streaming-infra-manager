import { chmod, lchmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { StackContract } from '@streaming-infra-manager/common';

import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from './buildManifest.js';
import type { BundledShipmentRecord } from './BundledShipment.js';
import { bundledArtifactMetadata } from './bundledArtifactMetadata.js';
import { assertCopiedBundledInputs, BUNDLED_PACKAGE_MANIFEST, parseBundledPackageManifest, verifyBundledPackage, type BundledPackageManifest, type VerifiedBundledPackage } from './bundledShipmentPackage.js';
import { byPath, inventoryOwnedTree, sha256, type OwnedTreeEntry } from './ownedTreeInventory.js';
import { assertSeparateOwnedTrees, readOwnedFile } from './ownedTreePaths.js';
import { readStackContract } from './stackContract.js';

export interface VerifiedBundledArtifact { digest: string; contract: StackContract; packageManifest: BundledPackageManifest }
export interface CopyBundledArtifactOptions { onProgress?: (copiedFiles: number) => Promise<void> }

function candidateMetadata(candidate: BundledShipmentRecord, manifest: BundledPackageManifest) {
  const selected = candidate.candidateManifest;
  if (!selected || !candidate.candidateMetadata || !candidate.candidateBuildId ||
      selected.buildId !== candidate.candidateBuildId || selected.commit !== candidate.commitSha || selected.commit !== manifest.commit) {
    throw new Error('Artifact does not match its reserved candidate identity.');
  }
  if (!isDeepStrictEqual(selected.inputHashes, manifest.inputs.hashes) || selected.inputGeneration !== manifest.inputs.generation) {
    throw new Error('Candidate input metadata does not match the complete captured input set.');
  }
  if (manifest.entries.some(entry => entry.path === BUILD_MANIFEST_FILE || entry.path === BUILD_COMPLETE_MARKER)) {
    throw new Error('Package contains a reserved generated artifact file.');
  }
  return bundledArtifactMetadata(selected, candidate.candidateMetadata);
}

function packageIdentity(candidate: BundledShipmentRecord) {
  return { shipmentId: candidate.shipmentId, commit: candidate.commitSha, digest: candidate.packageDigest };
}

/** Reads every final path. The full digest has no excluded file or self-referential digest file. */
export async function verifyBundledArtifact(root: string, candidate: BundledShipmentRecord): Promise<VerifiedBundledArtifact> {
  const packageBytes = await readOwnedFile(root, BUNDLED_PACKAGE_MANIFEST);
  const manifest = parseBundledPackageManifest(packageBytes);
  const metadata = candidateMetadata(candidate, manifest);
  if (candidate.candidateKind === 'new') {
    if (!isDeepStrictEqual(packageIdentity(candidate), { shipmentId: manifest.shipmentId, commit: manifest.commit, digest: manifest.digest })) {
      throw new Error('Artifact package identity differs from the registered shipment.');
    }
  } else if (candidate.candidateKind !== 'reuse' || !candidate.artifactDigest) throw new Error('Reuse requires a recorded final artifact digest.');

  const generated: OwnedTreeEntry[] = [
    { path: BUNDLED_PACKAGE_MANIFEST, type: 'file', mode: 0o600, sha256: sha256(packageBytes) },
    { path: BUILD_MANIFEST_FILE, type: 'file', mode: metadata.manifestMode, sha256: sha256(metadata.manifestBytes) },
    { path: BUILD_COMPLETE_MARKER, type: 'file', mode: metadata.completeMode, sha256: sha256(metadata.completeBytes) },
  ];
  const actual = await inventoryOwnedTree(root);
  const expectedEntries = [...manifest.entries, ...generated].sort(byPath);
  if (actual.rootMode !== manifest.rootMode || !isDeepStrictEqual(actual.entries, expectedEntries)) throw new Error('Final artifact inventory differs from its exact package and generated files.');
  await assertCopiedBundledInputs(root, manifest.inputs);
  const digest = sha256(JSON.stringify({ format: 1, rootMode: actual.rootMode, entries: actual.entries }));
  if (candidate.artifactDigest !== null && candidate.artifactDigest !== digest) throw new Error('Final artifact digest differs from its prepared identity.');
  const contract = readStackContract(root);
  if (candidate.candidateContract !== null && !isDeepStrictEqual(candidate.candidateContract, contract)) throw new Error('Final artifact contract differs from its prepared identity.');
  if (!isDeepStrictEqual(await inventoryOwnedTree(root), actual)) throw new Error('Final artifact changed during verification.');
  return { digest, contract, packageManifest: manifest };
}

/** The source remains immutable. Only this invocation's fresh destination may be written or removed. */
export async function copyBundledArtifact(
  source: VerifiedBundledPackage,
  destination: string,
  candidate: BundledShipmentRecord,
  options: CopyBundledArtifactOptions = {},
): Promise<VerifiedBundledArtifact> {
  if (candidate.candidateKind !== 'new') throw new Error('Only a new candidate may materialize a private copy.');
  await assertSeparateOwnedTrees(source.root, destination);
  const verified = await verifyBundledPackage(source.root, packageIdentity(candidate));
  const metadata = candidateMetadata(candidate, verified.manifest);
  const baseline = await inventoryOwnedTree(source.root);
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const entry of baseline.entries.filter(entry => entry.type === 'directory')) await mkdir(join(destination, entry.path), { mode: 0o700 });
    let copied = 0;
    for (const entry of baseline.entries) {
      if (entry.type === 'file') {
        const bytes = await readOwnedFile(source.root, entry.path);
        if (sha256(bytes) !== entry.sha256) throw new Error('Package source changed during artifact copying.');
        await writeFile(join(destination, entry.path), bytes, { flag: 'wx', mode: entry.mode });
        await chmod(join(destination, entry.path), entry.mode);
        await options.onProgress?.(++copied);
      } else if (entry.type === 'symlink') {
        await symlink(entry.target, join(destination, entry.path));
        if (((await lstat(join(destination, entry.path))).mode & 0o7777) !== entry.mode) await lchmod(join(destination, entry.path), entry.mode);
      }
    }
    if (!isDeepStrictEqual(await inventoryOwnedTree(source.root), baseline)) throw new Error('Package source changed during artifact copying.');
    await writeFile(join(destination, BUILD_MANIFEST_FILE), metadata.manifestBytes, { flag: 'wx', mode: metadata.manifestMode });
    await chmod(join(destination, BUILD_MANIFEST_FILE), metadata.manifestMode);
    for (const entry of baseline.entries.filter(entry => entry.type === 'directory').reverse()) await chmod(join(destination, entry.path), entry.mode);
    await writeFile(join(destination, BUILD_COMPLETE_MARKER), metadata.completeBytes, { flag: 'wx', mode: metadata.completeMode });
    await chmod(join(destination, BUILD_COMPLETE_MARKER), metadata.completeMode);
    await chmod(destination, baseline.rootMode);
    return await verifyBundledArtifact(destination, candidate);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
