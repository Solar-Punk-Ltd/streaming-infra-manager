import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  installReleaseGuard,
  ReleaseGuardStore,
} from '../../src/releaseGuard/ReleaseGuardStore.js';
import {
  digestTree,
  runReleaseTransition,
  type ReleaseAdapter,
} from '../../src/releaseGuard/ReleaseTransition.js';

const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

async function temporaryRoot(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'release-guard-state-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function capableManagerCandidate(root: string) {
  await mkdir(join(root, 'deploy'), { recursive: true });
  await writeFile(
    join(root, 'deploy/release-capabilities.json'),
    `${JSON.stringify({ schemaVersion: 1, capabilities: { srsLifecycle: 1 } })}\n`,
  );
}

function countingAdapter(counters: { preflight: number; build: number; transition: number }): ReleaseAdapter {
  return {
    async preflight() { counters.preflight += 1; },
    async build() {
      counters.build += 1;
      return { schemaVersion: 1, images: [{ service: 'api', imageId: IMAGE_ID }] };
    },
    async transition() { counters.transition += 1; },
    async verify() {
      return { schemaVersion: 1, images: [{ service: 'api', imageId: IMAGE_ID }] };
    },
  };
}

describe('release guard state preflight', () => {
  it('does not build when installed state is corrupt', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableManagerCandidate(candidate);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    await writeFile(join(stateRoot, 'state.json'), '{broken');
    const counters = { preflight: 0, build: 0, transition: 0 };

    await assert.rejects(
      runReleaseTransition({
        store: new ReleaseGuardStore(stateRoot),
        candidateRoot: candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: countingAdapter(counters),
      }),
      /installed guard state is invalid/,
    );
    assert.deepEqual(counters, { preflight: 0, build: 0, transition: 0 });
  });

  it('does not build while a verified receipt is unresolved', async (t) => {
    const root = await temporaryRoot(t);
    const candidate = join(root, 'candidate');
    await capableManagerCandidate(candidate);
    const stateRoot = join(root, 'state');
    await installReleaseGuard(stateRoot, INSTALLATION_ID);
    const store = new ReleaseGuardStore(stateRoot);
    const artifact = {
      treeDigest: await digestTree(candidate),
      images: [{ service: 'api', imageId: IMAGE_ID }],
    };
    await store.withTransition(async (lease) => {
      const pending = await lease.prepare({
        slot: { role: 'manager', id: 'default' },
        artifact,
      });
      await lease.markVerified(pending.body);
    });
    const counters = { preflight: 0, build: 0, transition: 0 };

    await assert.rejects(
      runReleaseTransition({
        store,
        candidateRoot: candidate,
        slot: { role: 'manager', id: 'default' },
        adapter: countingAdapter(counters),
      }),
      /receipt is unresolved/,
    );
    assert.deepEqual(counters, { preflight: 0, build: 0, transition: 0 });
  });
});
