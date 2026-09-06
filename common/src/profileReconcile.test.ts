import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconcileProfiles } from './profileReconcile.js';

const at = (iso: string): number => Date.parse(iso);

const row = (name: string, updated_at: string): { name: string; updated_at: string } => ({
  name,
  updated_at,
});

describe('reconcileProfiles', () => {
  it('takes the snapshot when nothing was on screen', () => {
    const snapshot = [row('a', '2026-09-06T10:00:00Z'), row('b', '2026-09-06T10:00:00Z')];

    const result = reconcileProfiles([], snapshot, at('2026-09-06T10:00:05Z'));

    assert.deepEqual(result, snapshot);
  });

  it('keeps the snapshot row when it changed later than the one on screen', () => {
    const previous = [row('a', '2026-09-06T10:00:00Z')];
    const snapshot = [row('a', '2026-09-06T10:00:09Z')];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, snapshot);
  });

  it('keeps the row on screen when an event updated it after the fetch went out', () => {
    const previous = [row('a', '2026-09-06T10:00:11Z')];
    const snapshot = [row('a', '2026-09-06T10:00:09Z')];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, previous);
  });

  it('prefers the snapshot when both rows carry the same timestamp', () => {
    const previous = [row('a', '2026-09-06T10:00:09Z')];
    const snapshot = [{ ...row('a', '2026-09-06T10:00:09Z'), status: 'STOPPED' }];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, snapshot);
  });

  it('drops a row the snapshot no longer has', () => {
    const previous = [row('a', '2026-09-06T10:00:00Z'), row('gone', '2026-09-06T10:00:01Z')];
    const snapshot = [row('a', '2026-09-06T10:00:00Z')];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, snapshot);
  });

  it('keeps a row the snapshot is missing when it arrived while the fetch was in flight', () => {
    const previous = [row('new', '2026-09-06T10:00:12Z'), row('a', '2026-09-06T10:00:00Z')];
    const snapshot = [row('a', '2026-09-06T10:00:00Z')];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, [previous[0], snapshot[0]]);
  });

  it('adds rows only the snapshot has, in the order the snapshot gives them', () => {
    const previous = [row('b', '2026-09-06T10:00:00Z')];
    const snapshot = [
      row('a', '2026-09-06T10:00:00Z'),
      row('b', '2026-09-06T10:00:00Z'),
      row('c', '2026-09-06T10:00:00Z'),
    ];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(
      result.map((r) => r.name),
      ['a', 'b', 'c'],
    );
  });

  it('drops a row whose timestamp cannot be read rather than resurrecting it', () => {
    const previous = [row('broken', 'not a date')];
    const snapshot = [row('a', '2026-09-06T10:00:00Z')];

    const result = reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(result, snapshot);
  });

  it('does not mutate either list', () => {
    const previous = [row('a', '2026-09-06T10:00:11Z')];
    const snapshot = [row('a', '2026-09-06T10:00:09Z'), row('b', '2026-09-06T10:00:09Z')];

    reconcileProfiles(previous, snapshot, at('2026-09-06T10:00:10Z'));

    assert.deepEqual(previous, [row('a', '2026-09-06T10:00:11Z')]);
    assert.deepEqual(snapshot, [
      row('a', '2026-09-06T10:00:09Z'),
      row('b', '2026-09-06T10:00:09Z'),
    ]);
  });
});
