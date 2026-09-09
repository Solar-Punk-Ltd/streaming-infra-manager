import { lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BundledArtifactMaterializer } from './BundledArtifactMaterializer.js';
import { resolvedBundledShipment, type BundledActivation, type BundledShipmentRecord } from './BundledShipment.js';
import { verifyBundledArtifact } from './bundledArtifactFiles.js';
import { claimBundledPackage, BUNDLED_CLAIM_PAYLOAD } from './bundledPackageClaim.js';
import { validateBundledShipmentId, validateBundledShipmentIdentity, verifyBundledPackage, type BundledShipmentIdentity } from './bundledShipmentPackage.js';
import { assertOwnedVersionParent } from './ownedVersionParent.js';
import { PostgresBundledShipmentRepository } from './PostgresBundledShipmentRepository.js';
import { stackRootOf } from './stackPaths.js';

export interface BundledPublicationRequest {
  identity: BundledShipmentIdentity;
  readyPath: string;
  toolchain: string;
  reuseFromShipmentId?: string;
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Invoked by the fixed new-image command after the upgrade guard has stopped the old API and migrated the database.
 * Publication never prunes. Historical receipts do not require the package or artifact to survive. */
export class BundledPublicationCommand {
  private readonly materializer: BundledArtifactMaterializer;
  constructor(private readonly shipments: PostgresBundledShipmentRepository, private readonly claimsRoot: string,
    private readonly packagesRoot = dirname(claimsRoot)) {
    this.materializer = new BundledArtifactMaterializer(shipments);
    for (const path of [claimsRoot, packagesRoot]) if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Package roots must be absolute owned paths.');
  }

  async publish(input: BundledPublicationRequest): Promise<BundledActivation> {
    const identity = validateBundledShipmentIdentity(input.identity);
    const selected = { identity, readyPath: input.readyPath, toolchain: input.toolchain,
      reuseFromShipmentId: input.reuseFromShipmentId === undefined ? undefined : validateBundledShipmentId(input.reuseFromShipmentId) };
    const existing = await this.shipments.find(identity.shipmentId);
    if (existing && (existing.commitSha !== identity.commit || existing.packageDigest !== identity.digest)) throw new Error('Shipment UUID records another identity.');
    const previous = existing && resolvedBundledShipment(existing);
    if (previous) return previous;
    if (selected.readyPath !== join(this.packagesRoot, `sealed-${identity.shipmentId}`) || typeof selected.toolchain !== 'string' ||
      selected.toolchain.length > 256 || !selected.toolchain.trim() || /[\x00-\x1f\x7f]/.test(selected.toolchain)) throw new Error('Invalid owned package path or toolchain identity.');
    let record = await this.shipments.register(identity);
    const registered = resolvedBundledShipment(record);
    if (registered) return registered;
    const loadPackage = async () => {
      assertOwnedVersionParent(this.packagesRoot);
      assertOwnedVersionParent(this.claimsRoot, true);
      await mkdir(this.claimsRoot, { recursive: true, mode: 0o700 });
      assertOwnedVersionParent(this.claimsRoot);
      const claim = join(this.claimsRoot, identity.shipmentId);
      if (await exists(claim)) {
        assertOwnedVersionParent(claim);
        return verifyBundledPackage(join(claim, BUNDLED_CLAIM_PAYLOAD), identity);
      }
      return claimBundledPackage(selected.readyPath, claim, identity);
    };
    if (!record.candidateBuildId) {
      const source = await loadPackage();
      if (selected.reuseFromShipmentId) {
        const origin = await this.shipments.find(selected.reuseFromShipmentId);
        if (!origin?.receipt || origin.versionId !== record.versionId || origin.rootPath !== record.rootPath ||
          origin.commitSha !== identity.commit || !origin.candidateBuildId || !origin.candidateManifest || !origin.candidateMetadata) {
          throw new Error('Reuse requires an exact published artifact identity.');
        }
        record = await this.shipments.reserveCandidate(identity.shipmentId, {
          buildId: origin.candidateBuildId, kind: 'reuse', manifest: origin.candidateManifest, metadata: origin.candidateMetadata,
        });
      } else {
        // The UUID owns this suffix. No unregistered directory is selected or adopted by scanning timestamps.
        const buildId = `${identity.commit}-r${BigInt(`0x${identity.shipmentId.replaceAll('-', '')}`)}`;
        record = await this.shipments.reserveCandidate(identity.shipmentId, { buildId, kind: 'new', manifest: {
          buildId, commit: identity.commit, builtAt: record.createdAt.toISOString(), toolchain: selected.toolchain,
          inputGeneration: source.manifest.inputs.generation, inputHashes: source.manifest.inputs.hashes,
        } });
      }
    }
    const resolved = resolvedBundledShipment(record);
    if (resolved) return resolved;
    const materialized = await this.materializer.materialize(identity.shipmentId, loadPackage,
      { reuseFromShipmentId: selected.reuseFromShipmentId });
    if (materialized.status !== 'prepared') return materialized;
    return this.shipments.activate(identity.shipmentId, async (candidate: BundledShipmentRecord) => {
      await verifyBundledArtifact(stackRootOf({ rootPath: candidate.rootPath, layout: 'builds', buildId: candidate.candidateBuildId }), candidate);
    });
  }
}
