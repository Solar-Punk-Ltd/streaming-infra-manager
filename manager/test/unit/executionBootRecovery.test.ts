/**
 * What a gone manager's execution copies cost the next boot.
 *
 * Unit test, no database and no Docker, but the copies are real directories.
 * `pnpm test` in manager/.
 *
 * A copy that never reached ready had nothing run from it, and no copy is
 * being written while the manager is starting, so boot takes those back. A
 * copy a job may have spawned under is left exactly as it is: only its
 * deployment moving on retires one.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ExecutionRootService } from '../../src/domain/versions/ExecutionRootService.js';
import type { ExecutionRootRecord, ExecutionRootState } from '../../src/domain/versions/ExecutionRoot.js';
import { InMemoryExecutionRoots } from '../support/InMemoryExecutionRoots.js';

const commit = 'a'.repeat(40);
let root: string;
let executions: string;
let store: InMemoryExecutionRoots;
let service: ExecutionRootService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'execution-boot-'));
  executions = join(root, '.executions');
  await mkdir(executions, { mode: 0o700 });
  store = new InMemoryExecutionRoots(executions, () => randomUUID());
  service = new ExecutionRootService(store, executions);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A copy on disk in the state a restart left it, with a row to match. */
async function copyLeftBehind(state: ExecutionRootState): Promise<ExecutionRootRecord> {
  const record = await store.register({
    executionId: randomUUID(),
    source: { versionId: 2, buildId: commit, commit, root: join(root, 'v3.builds', commit), artifactDigest: 'b'.repeat(64) },
    profile: { name: 'stage', instanceId: randomUUID(), intentRevision: 1, status: 'DEPLOYING' },
    jobReferenceId: store.records.length + 1,
    target: { alias: 'localhost', daemonId: 'daemon' },
    action: 'deploy',
    services: ['srs'],
  });
  await mkdir(record.root, { recursive: true, mode: 0o700 });
  await writeFile(join(dirname(record.root), 'owner.json'), JSON.stringify({ executionId: record.executionId }));
  if (state !== 'registered') {
    const copying = (await store.beginCopy(record.executionId))!;
    if (state === 'ready' || state === 'launch-uncertain') await store.markReady(record.executionId, copying.copyToken!, record.source.artifactDigest);
    if (state === 'launch-uncertain') await store.claimLaunch(record.executionId);
    if (state === 'deleting') await store.claimInterruptedCopyCleanup(record.executionId);
  }
  return record;
}

describe('the execution copies a restart left', () => {
  it('takes back everything no script can have run from, and says which', async () => {
    const left = [
      await copyLeftBehind('registered'),
      await copyLeftBehind('copying'),
      await copyLeftBehind('ready'),
      await copyLeftBehind('deleting'),
    ];

    const outcome = await service.reclaimInterrupted();

    assert.deepEqual(outcome.removed.sort(), left.map(record => record.executionId).sort());
    assert.deepEqual(outcome.kept, []);
    for (const record of left) assert.equal(existsSync(dirname(record.root)), false);
    assert.deepEqual(new Set(store.records.map(record => record.state)), new Set(['released']));
  });

  it('leaves a copy a job may have spawned under exactly as it is', async () => {
    const launched = await copyLeftBehind('launch-uncertain');

    const outcome = await service.reclaimInterrupted();

    assert.deepEqual(outcome, { removed: [], kept: [launched.executionId] });
    assert.equal(existsSync(launched.root), true);
    assert.equal(store.stateOf(launched.executionId), 'launch-uncertain');
  });

  it('keeps a copy it could not remove, and carries on with the rest', async () => {
    const stubborn = await copyLeftBehind('ready');
    const ordinary = await copyLeftBehind('ready');
    const removeOwnedRoot = store.completeCleanup.bind(store);
    store.completeCleanup = async (id, remove) => {
      if (id === stubborn.executionId) throw new Error('the directory is busy');
      return removeOwnedRoot(id, remove);
    };

    const outcome = await service.reclaimInterrupted();

    assert.deepEqual(outcome, { removed: [ordinary.executionId], kept: [stubborn.executionId] });
    assert.equal(existsSync(stubborn.root), true);
    assert.equal(existsSync(dirname(ordinary.root)), false);
  });

  it('has nothing to say when no copy was left', async () => {
    assert.deepEqual(await service.reclaimInterrupted(), { removed: [], kept: [] });
  });
});
