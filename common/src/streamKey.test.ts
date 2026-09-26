import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressOfStreamKey } from './streamKey.js';

describe('addressOfStreamKey', () => {
  it('derives the checksummed address of a key, with or without surrounding space', () => {
    assert.equal(addressOfStreamKey(`0x${'0'.repeat(63)}1`), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    assert.equal(addressOfStreamKey(` 0x${'0'.repeat(63)}1\n`), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  });

  it('answers null for anything that is not a key, and for a key outside the curve order', () => {
    for (const value of ['', '0x', `${'0'.repeat(63)}1`, `0x${'0'.repeat(63)}g`, `0x${'0'.repeat(62)}1`, `0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`]) {
      assert.equal(addressOfStreamKey(value), null, value);
    }
  });
});
