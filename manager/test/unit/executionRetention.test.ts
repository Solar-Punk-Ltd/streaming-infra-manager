/**
 * How many private copies a deployment keeps, and which one it is running from.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Levi's decision (D11): one copy per deployment, replaced on the next
 * successful deploy, the previous one kept until that deploy is healthy. So a
 * deploy that fails leaves the tree that last worked in place, and a deploy
 * that succeeds takes it. Anything older than the previous goes as soon as a
 * new deploy launches, which is what stops repeated failures filling the disk.
 *
 * This file decides only which copies are offered for retirement. Whether one
 * may actually go is the database's answer, under its own locks.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { ExecutionRootRecord, ExecutionRootState } from '../../src/domain/versions/ExecutionRoot.js';
import { currentExecutionOf, executionsToRetire } from '../../src/domain/versions/executionRetention.js';

const commit = 'a'.repeat(40);
const instance = randomUUID();

function copy(input: {
  minute: number;
  name?: string;
  instanceId?: string;
  state?: ExecutionRootState;
  executionId?: string;
}): ExecutionRootRecord {
  const executionId = input.executionId ?? randomUUID();
  const name = input.name ?? 'stage';
  return {
    executionId,
    source: { versionId: 2, buildId: commit, commit, root: `/srv/versions/v3.builds/${commit}`, artifactDigest: 'b'.repeat(64) },
    profile: { name, instanceId: input.instanceId ?? instance, intentRevision: 1, status: 'DEPLOYING' },
    jobReferenceId: input.minute + 1,
    target: { alias: 'localhost', daemonId: 'daemon' },
    project: name,
    action: 'deploy',
    services: ['srs'],
    root: `/srv/versions/.executions/${executionId}/tree`,
    referenceId: input.minute + 100,
    state: input.state ?? 'launch-uncertain',
    copyToken: randomUUID(),
    createdAt: new Date(Date.UTC(2026, 8, 11, 10, input.minute)),
  };
}

const idsOf = (records: readonly ExecutionRootRecord[]) => records.map(record => record.executionId);

describe('which copies a deployment retires', () => {
  it('offers none when it has no copies at all', () => {
    assert.deepEqual(executionsToRetire([], { profileName: 'stage', keepPrevious: true }), []);
    assert.deepEqual(executionsToRetire([], { profileName: 'stage', keepPrevious: false }), []);
  });

  it('never offers the copy it is running from', () => {
    const only = copy({ minute: 1 });
    assert.deepEqual(executionsToRetire([only], { profileName: 'stage', keepPrevious: true }), []);
    assert.deepEqual(executionsToRetire([only], { profileName: 'stage', keepPrevious: false }), []);
  });

  it('keeps the one previous copy while a deploy is in flight, and takes it once one succeeds', () => {
    const previous = copy({ minute: 1 });
    const current = copy({ minute: 2 });

    assert.deepEqual(executionsToRetire([previous, current], { profileName: 'stage', keepPrevious: true }), []);
    assert.deepEqual(idsOf(executionsToRetire([previous, current], { profileName: 'stage', keepPrevious: false })), [previous.executionId]);
  });

  it('offers everything older than the previous one, so repeated failures do not grow the disk', () => {
    const oldest = copy({ minute: 1 });
    const older = copy({ minute: 2 });
    const previous = copy({ minute: 3 });
    const current = copy({ minute: 4 });
    const records = [current, oldest, previous, older];

    assert.deepEqual(idsOf(executionsToRetire(records, { profileName: 'stage', keepPrevious: true })), [older.executionId, oldest.executionId]);
    assert.deepEqual(
      idsOf(executionsToRetire(records, { profileName: 'stage', keepPrevious: false })),
      [previous.executionId, older.executionId, oldest.executionId],
    );
  });

  it('offers only launched copies, because an unfinished one is retired as an unstarted job', () => {
    const launched = copy({ minute: 1 });
    const records = [
      launched,
      copy({ minute: 2, state: 'registered' }),
      copy({ minute: 3, state: 'copying' }),
      copy({ minute: 4, state: 'ready' }),
      copy({ minute: 5, state: 'deleting' }),
      copy({ minute: 6, state: 'released' }),
    ];

    assert.deepEqual(executionsToRetire(records, { profileName: 'stage', keepPrevious: false }), []);
    assert.deepEqual(idsOf(executionsToRetire([...records, copy({ minute: 7 })], { profileName: 'stage', keepPrevious: false })), [launched.executionId]);
  });

  it('never offers another deployment its copies', () => {
    const mine = copy({ minute: 1 });
    const current = copy({ minute: 2 });
    const theirs = copy({ minute: 3, name: 'other' });

    assert.deepEqual(idsOf(executionsToRetire([mine, current, theirs], { profileName: 'stage', keepPrevious: false })), [mine.executionId]);
  });

  it('offers a copy left by an earlier instance of the same name, which no longer exists', () => {
    const beforeRemoval = copy({ minute: 1, instanceId: randomUUID() });
    const current = copy({ minute: 2 });

    assert.deepEqual(idsOf(executionsToRetire([beforeRemoval, current], { profileName: 'stage', keepPrevious: false })), [beforeRemoval.executionId]);
  });

  it('breaks a tie on the same timestamp by identity, so two runs agree', () => {
    const first = copy({ minute: 1, executionId: '11111111-1111-1111-1111-111111111111' });
    const second = copy({ minute: 1, executionId: '22222222-2222-2222-2222-222222222222' });

    assert.deepEqual(idsOf(executionsToRetire([first, second], { profileName: 'stage', keepPrevious: false })), [first.executionId]);
    assert.deepEqual(idsOf(executionsToRetire([second, first], { profileName: 'stage', keepPrevious: false })), [first.executionId]);
  });
});

describe('the copy a deployment is running from', () => {
  it('is the newest launched one of that deployment and instance', () => {
    const previous = copy({ minute: 1 });
    const current = copy({ minute: 2 });

    assert.equal(currentExecutionOf([previous, current], { name: 'stage', instanceId: instance })?.executionId, current.executionId);
  });

  it('is none while the first deploy is still copying, and none for a deployment with no copies', () => {
    assert.equal(currentExecutionOf([copy({ minute: 1, state: 'ready' })], { name: 'stage', instanceId: instance }), null);
    assert.equal(currentExecutionOf([], { name: 'stage', instanceId: instance }), null);
  });

  it('is never a copy of another deployment or of an earlier instance of this name', () => {
    const theirs = copy({ minute: 3, name: 'other' });
    const earlier = copy({ minute: 2, instanceId: randomUUID() });

    assert.equal(currentExecutionOf([theirs, earlier], { name: 'stage', instanceId: instance }), null);
  });
});
