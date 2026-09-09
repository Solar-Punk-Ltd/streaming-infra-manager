/**
 * The argument reader every manager command shares: what it accepts, and what
 * it refuses by name rather than guessing at.
 *
 * `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFlags } from '../../../src/cli/flags.js';

const SPEC = { valued: ['--source', '--out'], repeated: ['--dist'], switches: ['--adopt-inputs'] };

describe('the options a manager command takes', () => {
  it('reads a value, every value of a repeated option in order, and a switch', () => {
    const flags = parseFlags(['--source', '/checkout', '--dist', 'a/dist', '--dist', 'b/dist', '--adopt-inputs'], SPEC);

    assert.equal(flags.required('--source'), '/checkout');
    assert.deepEqual(flags.list('--dist'), ['a/dist', 'b/dist']);
    assert.equal(flags.has('--adopt-inputs'), true);
    assert.equal(flags.has('--out'), false);
  });

  it('refuses an empty value by name, instead of carrying it into a path or an identity', () => {
    assert.throws(() => parseFlags(['--source', ''], SPEC), /--source/);
  });

  it('refuses an option it does not take by name', () => {
    assert.throws(() => parseFlags(['--profile', 'public'], SPEC), /--profile/);
  });

  it('refuses an option whose value is the next option, or missing altogether', () => {
    assert.throws(() => parseFlags(['--source', '--out', '/elsewhere'], SPEC), /--source/);
    assert.throws(() => parseFlags(['--source'], SPEC), /--source/);
  });

  it('refuses an option given twice that takes one value, and names a missing one', () => {
    assert.throws(() => parseFlags(['--source', '/one', '--source', '/two'], SPEC), /--source/);
    assert.throws(() => parseFlags([], SPEC).required('--out'), /--out/);
  });
});
