import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StackContract } from '@streaming-infra-manager/common';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';

const COMMIT = 'a'.repeat(40);
const NEXT_COMMIT = 'b'.repeat(40);
const CONTRACT = {} as StackContract;

describe('approval invalidation history', () => {
  it('records the first update that invalidates approval, keeps default and clears only on reapproval or withdrawal', async () => {
    const repository = new InMemoryStackVersionRepository();
    const { id } = repository.seedBundled();
    await repository.publish(id, { commitSha: COMMIT, buildId: COMMIT, contract: CONTRACT });
    await repository.setTested(id, true, COMMIT, COMMIT);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.publish(id, { commitSha: COMMIT, buildId: COMMIT, contract: CONTRACT });
    assert.equal((await repository.findById(id))?.tested, true);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.publish(id, { commitSha: COMMIT, buildId: `${COMMIT}-r1`, contract: CONTRACT });
    const first = (await repository.findById(id))!;
    assert.ok(first.testedInvalidatedAt instanceof Date);
    assert.equal(first.tested, false);
    assert.equal(first.isDefault, true);
    await repository.publish(id, { commitSha: NEXT_COMMIT, buildId: NEXT_COMMIT, contract: CONTRACT });
    assert.deepEqual((await repository.findById(id))?.testedInvalidatedAt, first.testedInvalidatedAt);
    await repository.setTested(id, true, NEXT_COMMIT, NEXT_COMMIT);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setTested(id, false);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
  });

  it('records bundled refresh and legacy build invalidation without inventing earlier dates', async () => {
    const repository = new InMemoryStackVersionRepository();
    const { id } = repository.seedBundled();
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setCommitSha(id, COMMIT);
    await repository.setTested(id, true, COMMIT);
    await repository.setCommitSha(id, COMMIT);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setCommitSha(id, NEXT_COMMIT);
    assert.ok((await repository.findById(id))?.testedInvalidatedAt instanceof Date);
    await repository.setTested(id, true, NEXT_COMMIT);
    await repository.markBuilt(id, { commitSha: COMMIT, contract: CONTRACT });
    assert.ok((await repository.findById(id))?.testedInvalidatedAt instanceof Date);
    await repository.setTested(id, false);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setCommitSha(id, NEXT_COMMIT);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
  });
});
