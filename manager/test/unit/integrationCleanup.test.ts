import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreatedResourceInventory } from '../integration/createdResources.js';
import { cleanupCreatedResources, IntegrationCleanupError, type CleanupAdapter } from '../integration/cleanupCreatedResources.js';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const THIRD = '10000000-0000-4000-8000-000000000003';
const short = { requestTimeoutMs: 15, removalTimeoutMs: 35, intervalMs: 1 };

async function inventory(ids: string[]) {
  const result = new CreatedResourceInventory('run');
  for (const instance_id of ids) {
    await result.capture({ kind: 'profile' }, async () => ({ status: 202, body: { instance_id, name: `itest-run-profile-${instance_id.slice(-1)}` } }));
  }
  return result;
}

const adapter = (overrides: Partial<CleanupAdapter> = {}): CleanupAdapter => ({
  remove: async () => 'accepted',
  read: async () => 'absent',
  removeEmptyGroup: async () => 'accepted',
  groupExists: async () => false,
  ...overrides,
});

describe('confirmed integration cleanup', () => {
  it('passes exact confirmed instance identity and never discovers extra members', async () => {
    const created = new CreatedResourceInventory('run');
    await created.capture({ kind: 'group', expectedMembers: 1 }, async () => ({ status: 202, body: {
      group: { id: 19, name: 'itest-run-group' },
      profiles: [{ name: 'itest-run-group-profile-42', instance_id: FIRST }],
    } }));
    const calls: unknown[] = [];
    await cleanupCreatedResources(created.snapshot(), adapter({
      remove: async identity => { calls.push(identity); return 'accepted'; },
      removeEmptyGroup: async group => { calls.push(group); return 'accepted'; },
    }), short);
    assert.deepEqual(calls, [
      { name: 'itest-run-group-profile-42', instanceId: FIRST },
      { id: 19, name: 'itest-run-group' },
    ]);
  });

  it('reports DELETE failure, disappearance timeout and unresolved create after attempting all resources', async () => {
    const created = await inventory([FIRST, SECOND, THIRD]);
    await created.capture({ kind: 'profile' }, async () => ({ status: 503, body: null }));
    const removed: string[] = [];
    await assert.rejects(cleanupCreatedResources(created.snapshot(), adapter({
      remove: async identity => {
        removed.push(identity.instanceId);
        if (identity.instanceId === FIRST) throw new Error('synthetic-private-server-body');
        return 'accepted';
      },
      read: async identity => identity.instanceId === SECOND ? 'present' : 'absent',
    }), short), error => {
      assert.ok(error instanceof IntegrationCleanupError);
      assert.deepEqual(error.failures.map(failure => failure.reason), ['request-failed', 'removal-timeout', 'response-unavailable']);
      assert.ok(!error.message.includes('synthetic-private-server-body'));
      assert.ok(error.message.includes(FIRST));
      assert.ok(error.message.includes(SECOND));
      return true;
    });
    assert.deepEqual(removed, [FIRST, SECOND, THIRD]);
  });

  it('aborts a hanging request, reports it once and continues without retrying DELETE', { timeout: 2000 }, async () => {
    const created = await inventory([FIRST, SECOND]);
    let aborted = false;
    const removed: string[] = [];
    await assert.rejects(cleanupCreatedResources(created.snapshot(), adapter({
      remove: async (identity, signal) => {
        removed.push(identity.instanceId);
        if (identity.instanceId === FIRST) {
          signal.addEventListener('abort', () => { aborted = true; });
          return new Promise(() => {});
        }
        return 'absent';
      },
    }), short), error => {
      assert.ok(error instanceof IntegrationCleanupError);
      assert.deepEqual(error.failures.map(failure => failure.reason), ['request-timeout']);
      return true;
    });
    assert.equal(aborted, true);
    assert.deepEqual(removed, [FIRST, SECOND]);
  });

  it('accepts exact instance absence or replacement without removing the replacement', async () => {
    const created = await inventory([FIRST, SECOND, THIRD]);
    const read: string[] = [];
    await cleanupCreatedResources(created.snapshot(), adapter({
      remove: async identity => identity.instanceId === FIRST ? 'absent' : identity.instanceId === SECOND ? 'replaced' : 'accepted',
      read: async identity => { read.push(identity.instanceId); return 'replaced'; },
    }), short);
    assert.deepEqual(read, [THIRD]);
  });

  it('reports a confirmed group that remains after known members disappear', async () => {
    const created = new CreatedResourceInventory('run');
    await created.capture({ kind: 'group', expectedMembers: 1 }, async () => ({ status: 202, body: {
      group: { id: 19, name: 'itest-run-group' }, profiles: null,
    } }));
    await assert.rejects(cleanupCreatedResources(created.snapshot(), adapter({ groupExists: async () => true }), short), error => {
      assert.ok(error instanceof IntegrationCleanupError);
      assert.deepEqual(error.failures.map(failure => failure.reason), ['removal-timeout', 'missing-members']);
      assert.ok(error.message.includes('group 19'));
      return true;
    });
  });

  it('does not call the adapter for a refused name collision', async () => {
    const created = new CreatedResourceInventory('run');
    await created.capture({ kind: 'profile' }, async () => ({ status: 409, body: { name: 'itest-run-collision', instance_id: FIRST } }));
    await cleanupCreatedResources(created.snapshot(), adapter({ remove: async () => { assert.fail('No confirmed identity'); } }), short);
  });

  it('reports malformed removal evidence and failed group polling without claiming success', async () => {
    const created = new CreatedResourceInventory('run');
    await created.capture({ kind: 'group', expectedMembers: 1 }, async () => ({ status: 202, body: {
      group: { id: 19, name: 'itest-run-group' }, profiles: [{ name: 'itest-run-member', instance_id: FIRST }],
    } }));
    await assert.rejects(cleanupCreatedResources(created.snapshot(), adapter({
      remove: async () => undefined as never,
      groupExists: async () => { throw new Error('private response'); },
    }), short), error => {
      assert.ok(error instanceof IntegrationCleanupError);
      assert.deepEqual(error.failures.map(failure => failure.reason), ['invalid-response', 'request-failed']);
      return true;
    });
  });

  it('reports a changed or nonempty group without adopting or deleting its other members', async () => {
    for (const refusal of ['changed', 'not-empty'] as const) {
      const created = new CreatedResourceInventory('run');
      await created.capture({ kind: 'group', expectedMembers: 1 }, async () => ({ status: 202, body: {
        group: { id: 19, name: 'itest-run-group' }, profiles: [{ name: 'itest-run-member', instance_id: FIRST }],
      } }));
      const removed: string[] = [];
      await assert.rejects(cleanupCreatedResources(created.snapshot(), adapter({
        remove: async identity => { removed.push(identity.instanceId); return 'absent'; },
        removeEmptyGroup: async () => refusal,
        groupExists: async () => { assert.fail('Must not poll or adopt a refused group'); },
      }), short), error => {
        assert.ok(error instanceof IntegrationCleanupError);
        assert.deepEqual(error.failures.map(failure => failure.reason), [refusal === 'changed' ? 'identity-changed' : 'group-not-empty']);
        return true;
      });
      assert.deepEqual(removed, [FIRST]);
    }
  });
});
