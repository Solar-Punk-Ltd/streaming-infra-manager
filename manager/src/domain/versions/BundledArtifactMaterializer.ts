import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolvedBundledShipment, type BundledMaterialization, type BundledShipmentRecord } from './BundledShipment.js';
import { copyBundledArtifact, verifyBundledArtifact } from './bundledArtifactFiles.js';
import { verifyBundledPackage, type VerifiedBundledPackage } from './bundledShipmentPackage.js';
import { assertOwnedDirectory } from './ownedTreePaths.js';
import { PostgresBundledShipmentRepository } from './PostgresBundledShipmentRepository.js';
import { materializationsRootFor, stackRootOf } from './stackPaths.js';

interface ArtifactFiles {
  copy: typeof copyBundledArtifact;
  verify: typeof verifyBundledArtifact;
  rename: (source: string, destination: string) => Promise<void>;
}
export interface BundledMaterializationOptions { reuseFromShipmentId?: string }

function privateParent(record: BundledShipmentRecord): string {
  return materializationsRootFor(record.rootPath);
}
export function bundledMaterializationPath(record: BundledShipmentRecord): string {
  if (!record.materializationId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.materializationId)) throw new Error('Shipment has no selected materialization copy.');
  return join(privateParent(record), record.materializationId);
}
function finalPath(record: BundledShipmentRecord): string {
  return stackRootOf({ rootPath: record.rootPath, layout: 'builds', buildId: record.candidateBuildId });
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function ensurePrivateParent(record: BundledShipmentRecord): Promise<void> {
  const parent = privateParent(record);
  await mkdir(parent, { mode: 0o700, recursive: true });
  await assertOwnedDirectory(parent);
  if (((await lstat(parent)).mode & 0o077) !== 0) throw new Error('Materialization directory must be private.');
}

export class BundledArtifactMaterializer {
  private readonly files: ArtifactFiles;
  constructor(private readonly shipments: PostgresBundledShipmentRepository, files: Partial<ArtifactFiles> = {}) {
    this.files = { copy: copyBundledArtifact, verify: verifyBundledArtifact, rename, ...files };
  }

  async materialize(
    shipmentId: string,
    loadPackage: () => Promise<VerifiedBundledPackage>,
    options: BundledMaterializationOptions = {},
  ): Promise<BundledMaterialization> {
    let record = await this.shipments.find(shipmentId);
    if (!record) throw new Error('Shipment was not registered.');
    const previous = resolvedBundledShipment(record);
    if (previous) return previous;
    try {
      if (record.state === 'registered') {
        if (!record.candidateBuildId || !record.candidateManifest || !record.candidateMetadata) throw new Error('Shipment has no reserved candidate.');
        const supplied = await loadPackage();
        const source = await verifyBundledPackage(supplied.root, { shipmentId, commit: record.commitSha, digest: record.packageDigest });
        if (record.candidateKind === 'reuse') record = await this.prepareReuse(record, source, options.reuseFromShipmentId);
        else {
          await ensurePrivateParent(record);
          const materializationId = randomUUID();
          const path = bundledMaterializationPath({ ...record, materializationId });
          const artifact = await this.files.copy(source, path, record);
          // An uncertain preparation acknowledgement retains this copy. Only a confirmed different winner permits removal.
          record = await this.shipments.markPrepared(shipmentId, { artifactDigest: artifact.digest, contract: artifact.contract, materializationId });
          if (record.materializationId !== materializationId) await rm(path, { recursive: true, force: true });
        }
      }
      const resolved = resolvedBundledShipment(record);
      if (resolved) return resolved;
      return await this.install(record);
    } catch (error) {
      const latest = await this.shipments.find(shipmentId);
      const outcome = latest && resolvedBundledShipment(latest);
      if (outcome) return outcome;
      throw error;
    }
  }

  private async prepareReuse(record: BundledShipmentRecord, source: VerifiedBundledPackage, originId?: string): Promise<BundledShipmentRecord> {
    if (!originId) throw new Error('Reuse requires a recorded published artifact.');
    const origin = await this.shipments.find(originId);
    if (!origin?.receipt || !origin.artifactDigest || origin.versionId !== record.versionId || origin.rootPath !== record.rootPath ||
        origin.commitSha !== record.commitSha || origin.candidateBuildId !== record.candidateBuildId ||
        !isDeepStrictEqual(origin.candidateManifest, record.candidateManifest) || !isDeepStrictEqual(origin.candidateMetadata, record.candidateMetadata)) {
      throw new Error('Reuse provenance does not match the reserved candidate.');
    }
    const artifact = await this.files.verify(finalPath(origin), origin);
    if (source.manifest.commit !== artifact.packageManifest.commit || !isDeepStrictEqual(source.manifest.inputs.hashes, artifact.packageManifest.inputs.hashes)) {
      throw new Error('Incoming complete input set differs from the artifact selected for reuse.');
    }
    return this.shipments.markPrepared(record.shipmentId, { artifactDigest: artifact.digest, contract: artifact.contract, materializationId: null });
  }

  private async install(record: BundledShipmentRecord): Promise<BundledMaterialization> {
    const checked = await this.shipments.withPreparedCandidate(record);
    if (checked.status !== 'prepared') return checked;
    record = checked.shipment;
    const destination = finalPath(record);
    const parent = dirname(destination);
    await mkdir(parent, { recursive: true });
    await assertOwnedDirectory(parent);
    let source: string | null = null;
    let inode: number | null = null;
    if (await exists(destination)) await this.files.verify(destination, record);
    else {
      if (record.candidateKind !== 'new') throw new Error('Reused artifact is missing.');
      source = bundledMaterializationPath(record);
      try {
        await this.files.verify(source, record);
        inode = (await lstat(source)).ino;
      } catch (error) {
        // A duplicate installer may have consumed this exact selected source while its peer verified it.
        if (!(await exists(destination))) throw error;
        await this.files.verify(destination, record);
        source = null;
      }
    }
    const installed = await this.shipments.withPreparedCandidate(record, async () => {
      await assertOwnedDirectory(parent);
      if (await exists(destination)) return;
      if (!source) throw new Error('Verified final artifact disappeared before installation.');
      await assertOwnedDirectory(privateParent(record));
      const current = await lstat(source);
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== inode) throw new Error('Selected materialization copy changed before installation.');
      await this.files.rename(source, destination);
    });
    if (installed.status !== 'prepared') return installed;
    await this.files.verify(destination, installed.shipment);
    return installed;
  }
}
