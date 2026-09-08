import { isDeepStrictEqual } from 'node:util';
import type { BuildManifest } from './buildManifest.js';
import type { BundledArtifactMetadata } from './BundledShipment.js';

export function bundledArtifactMetadata(manifest: BuildManifest, supplied?: BundledArtifactMetadata): BundledArtifactMetadata {
  const metadata = supplied ?? { manifestBytes: JSON.stringify(manifest, null, 2) + '\n', manifestMode: 0o644, completeBytes: '', completeMode: 0o644 };
  if (typeof metadata.manifestBytes !== 'string' || metadata.manifestMode !== 0o644 || metadata.completeBytes !== '' || metadata.completeMode !== 0o644 ||
      !isDeepStrictEqual(Object.keys(metadata).sort(), ['completeBytes', 'completeMode', 'manifestBytes', 'manifestMode'])) {
    throw new Error('Invalid bundled artifact metadata.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(metadata.manifestBytes); } catch { throw new Error('Invalid bundled artifact manifest bytes.'); }
  if (!isDeepStrictEqual(parsed, manifest)) throw new Error('Artifact metadata differs from the candidate manifest.');
  return { ...metadata };
}
