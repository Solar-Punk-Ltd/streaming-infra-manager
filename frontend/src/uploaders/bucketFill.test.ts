/**
 * How full a batch is, as the stamps table and the change dialogs say it.
 *
 * bee's utilization counts the chunks in a batch's fullest bucket, which is
 * what fills and refuses uploads, so that is the number shown, beside what one
 * bucket holds. The host's 1080p batch of 2026-09-24 held 128 of its 128.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_VALUE } from '../format';
import { bucketFill } from './bucketFill';

const hostBatch = { depth: 23, bucketDepth: 16, utilization: 128, immutableFlag: true };

describe('how full a batch reads', () => {
  it('reads the host’s full immutable batch as full, 128 of 128', () => {
    assert.deepEqual(bucketFill(hostBatch), { percent: '100%', chunks: '128 of 128', warning: 'full' });
  });

  it('warns about an immutable batch past the uploader’s start ceiling', () => {
    assert.deepEqual(bucketFill({ ...hostBatch, utilization: 122 }), {
      percent: '95%',
      chunks: '122 of 128',
      warning: 'nearly-full',
    });
  });

  // A mutable batch never refuses, so it is never full here, but past the
  // ceiling it warns as its readiness step does: once full it overwrites its
  // oldest chunks, and the uploader of stack v3.3 refuses a restart on it.
  it('warns about a mutable batch past the ceiling without ever calling it full', () => {
    assert.equal(bucketFill({ ...hostBatch, immutableFlag: false }).warning, 'nearly-full');
    assert.equal(bucketFill({ ...hostBatch, utilization: 122, immutableFlag: false }).warning, 'nearly-full');
    assert.equal(bucketFill({ ...hostBatch, utilization: 64, immutableFlag: false }).warning, null);
  });

  it('reads a batch with room as its share, with no warning', () => {
    assert.deepEqual(bucketFill({ ...hostBatch, utilization: 64 }), {
      percent: '50%',
      chunks: '64 of 128',
      warning: null,
    });
  });

  it('says nothing where the node did not report enough to work it out', () => {
    assert.deepEqual(bucketFill({ depth: 23, bucketDepth: 16 }), {
      percent: NO_VALUE,
      chunks: null,
      warning: null,
    });
  });
});
