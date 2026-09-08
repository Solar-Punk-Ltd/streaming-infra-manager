import { randomUUID } from 'node:crypto';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BundledShipmentRecord } from '../../src/domain/versions/BundledShipment.js';
import { bundledArtifactMetadata } from '../../src/domain/versions/bundledArtifactMetadata.js';
import { sealBundledPackage } from '../../src/domain/versions/bundledShipmentPackage.js';
import { commitHostConfig } from '../../src/domain/versions/hostConfigCapture.js';

export async function bundledArtifactFixture(root: string, options: { commit?: string; shipmentId?: string; reservedFile?: string; input?: string; advanceGeneration?: boolean } = {}) {
  const commit = options.commit ?? 'a'.repeat(40);
  const shipmentId = options.shipmentId ?? randomUUID();
  const source = join(root, `source-${shipmentId}`);
  await mkdir(join(source, 'deploy', 'scripts'), { recursive: true });
  await writeFile(join(source, 'deploy', 'scripts', '_lib.sh'), 'readonly PORT_VARS=(\n  "RTMP_PORT:1935:19000"\n)\n');
  await writeFile(join(source, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh\n# --portSlot=<N> (1-99)\n');
  await chmod(join(source, 'deploy', 'scripts', 'deploy.sh'), 0o755);
  await writeFile(join(source, 'deploy', 'docker-compose.yml'), 'services:\n  srs:\n    image: synthetic/srs:fixed\n    ports:\n      - "${RTMP_PORT}:1935/tcp"\n');
  await writeFile(join(source, '.stack-commit'), commit + '\n');
  await mkdir(join(source, 'empty'));
  await symlink('deploy/scripts/deploy.sh', join(source, 'entry'));
  const inputs = { '.env': Buffer.from(`ENGINE=${options.input ?? 'synthetic'}\n`), 'deploy/config.json': Buffer.from('{}\n') };
  let revision = await commitHostConfig(source, inputs);
  if (options.advanceGeneration) {
    await commitHostConfig(source, { '.env': Buffer.from('ENGINE=temporary\n') });
    revision = await commitHostConfig(source, inputs);
  }
  if (options.reservedFile) await writeFile(join(source, options.reservedFile), 'unexpected');
  const sealed = await sealBundledPackage(source, join(root, `sealed-${shipmentId}`), { shipmentId, commit, inputs: { generation: revision.generation, hashes: revision.files } });
  const manifest = { commit, buildId: commit, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic', inputGeneration: revision.generation, inputHashes: revision.files };
  const record: BundledShipmentRecord = {
    shipmentId, versionId: 1, packageDigest: sealed.identity.digest, commitSha: commit, expectedRevision: '0', rootPath: join(root, 'bundled'), state: 'registered',
    candidateBuildId: commit, candidateKind: 'new', candidateManifest: manifest, candidateMetadata: bundledArtifactMetadata(manifest), materializationId: null,
    artifactDigest: null, candidateContract: null, receipt: null, createdAt: new Date('2026-09-09T00:00:00.000Z'),
  };
  return { sealed, source, record };
}
