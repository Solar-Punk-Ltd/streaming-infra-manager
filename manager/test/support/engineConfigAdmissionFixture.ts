import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import { InMemoryBuildLedger } from './InMemoryBuildLedger.js';
import { InMemoryDeployAttempts } from './InMemoryDeployAttempts.js';
import type { InMemoryEngineConfigOperations } from './InMemoryEngineConfigOperations.js';
import type { InMemoryStackVersionRepository } from './InMemoryStackVersionRepository.js';
import type { ProfileServiceHarness } from './profileServiceHarness.js';

/** Real immutable file evidence for the in-memory service's synthetic database rows. */
export async function publishEngineConfigFixture(versions: InMemoryStackVersionRepository, root: string) {
  const version = (await versions.findById(1))!;
  const buildId = randomBytes(20).toString('hex');
  const artifact = buildDirFor(root, version.name, buildId);
  await mkdir(artifact, { recursive: true });
  await cp(join(root, 'engines'), join(artifact, 'engines'), { recursive: true });
  await writeFile(join(artifact, '.env'), await readFile(join(root, '.env'), 'utf8').catch(() => 'ENGINE=srs\n'));
  await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ buildId, commit: buildId, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
  await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
  return (await versions.publish(version.id, { rootPath: join(root, version.name), buildId, commitSha: buildId, contract: version.contract! }))!;
}

export async function configureEngineConfigAdmission(harness: ProfileServiceHarness, operations: InMemoryEngineConfigOperations, root: string) {
  const attempts = new InMemoryDeployAttempts();
  operations.deployments = { versions: harness.versions, versionsRoot: root,
    ledger: new InMemoryBuildLedger(harness.profiles, harness.versions, root, operations), attempts,
    daemonId: 'daemon-1', onClaim: profile => { harness.orchestrator.reserved.push(profile.name); } };
  harness.orchestrator.rolloutAttempts = attempts;
  return publishEngineConfigFixture(harness.versions, root);
}
