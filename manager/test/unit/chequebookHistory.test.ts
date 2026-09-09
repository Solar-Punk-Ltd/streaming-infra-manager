import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { historyCursor, normalizeHistoryQuery } from '../../src/domain/chequebook/chequebookHistory.js';

const id = '12345678-1234-4321-8321-123456789abc';
describe('bounded chequebook history', () => {
  it('preserves PostgreSQL microseconds and normalizes its bounded query', () => {
    const cursor = historyCursor('2026-09-08T02:03:04.123456Z', id);
    assert.deepEqual(normalizeHistoryQuery({ cursor, limit: 2, profileName: 'removed-profile' }), {
      limit: 2, profileName: 'removed-profile', after: { createdAt: '2026-09-08T02:03:04.123456Z', id },
    });
    assert.deepEqual(normalizeHistoryQuery({}), { limit: 50, after: null });
  });

  it('rejects malformed pagination without coercing arrays, objects or oversized values', () => {
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '2' }, { cursor: '' }, { cursor: [] },
      { cursor: 'x'.repeat(1000) }, { cursor: Buffer.from('{"createdAt":"private-value"}').toString('base64url') },
      { profileName: '' }, { profileName: {} }, { profileName: 'x'.repeat(201) }]) {
      assert.throws(() => normalizeHistoryQuery(query as never), error => error instanceof Error && !error.message.includes('private-value'));
    }
    assert.throws(() => historyCursor('2026-02-30T02:03:04.123456Z', id));
  });
});
