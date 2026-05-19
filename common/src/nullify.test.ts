import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nullify } from './nullify.js';

describe('nullify', () => {
  it('converts undefined values to null', () => {
    const result = nullify({ a: undefined, b: 'x', c: undefined });
    assert.deepEqual(result, { a: null, b: 'x', c: null });
  });

  it('preserves existing null values', () => {
    const result = nullify({ a: null, b: undefined });
    assert.deepEqual(result, { a: null, b: null });
  });

  it('preserves falsy non-undefined values', () => {
    const result = nullify({
      zero: 0,
      empty: '',
      no: false,
      missing: undefined,
    });
    assert.deepEqual(result, { zero: 0, empty: '', no: false, missing: null });
  });

  it('preserves arrays and nested objects by reference', () => {
    const arr = [1, 2, 3];
    const obj = { nested: true };
    const result = nullify({ arr, obj, gone: undefined });
    assert.equal(result.arr, arr);
    assert.equal(result.obj, obj);
    assert.equal(result.gone, null);
  });

  it('returns an empty object for an empty input', () => {
    assert.deepEqual(nullify({}), {});
  });

  it('does not mutate the input', () => {
    const input = { a: undefined, b: 1 };
    nullify(input);
    assert.equal(input.a, undefined);
    assert.equal(input.b, 1);
  });
});
