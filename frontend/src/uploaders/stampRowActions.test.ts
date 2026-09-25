/**
 * Which of a stamps table row's controls can be pressed, and what the row says
 * where it cannot.
 *
 * The table offered Use on a full immutable batch, which records a batch its
 * node refuses every upload on: the base branch's review found it. Use is now
 * unavailable there, and the row says why and what fixes it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BeeStamp } from './stampApi';
import { stampRowActions } from './stampRowActions';

/** The host's full 1080p batch of 2026-09-24: depth 23, 128 of 128 chunks in its fullest bucket. */
const fullBatch: BeeStamp = {
  batchID: 'a'.repeat(64),
  utilization: 128,
  usable: true,
  depth: 23,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: 2 * 86_400,
};

const roomyBatch: BeeStamp = { ...fullBatch, utilization: 64 };

describe('Use on a stamps table row', () => {
  it('is unavailable on a full immutable batch, and the row says to dilute it first', () => {
    assert.deepEqual(stampRowActions(fullBatch, false).use, {
      enabled: false,
      note: 'full, dilute it first',
    });
  });

  it('is offered on a usable batch with room, and on a full mutable one, which overwrites', () => {
    assert.deepEqual(stampRowActions(roomyBatch, false).use, { enabled: true, note: null });
    assert.deepEqual(stampRowActions({ ...fullBatch, immutableFlag: false }, false).use, {
      enabled: true,
      note: null,
    });
  });

  it('stays off for an expired batch and one not usable yet, which the Usable column already names', () => {
    assert.deepEqual(stampRowActions({ ...roomyBatch, batchTTL: 0 }, false).use, {
      enabled: false,
      note: null,
    });
    assert.deepEqual(stampRowActions({ ...roomyBatch, usable: false }, false).use, {
      enabled: false,
      note: null,
    });
  });

  it('stays off while another change is in flight', () => {
    assert.equal(stampRowActions(roomyBatch, true).use.enabled, false);
  });

  it('says why in words with no dash or semicolon', () => {
    assert.doesNotMatch(stampRowActions(fullBatch, false).use.note ?? '', /[—;]/);
  });
});

describe('Top up on a stamps table row', () => {
  it('is offered on a live batch, a full one included, since time is what it buys', () => {
    assert.deepEqual(stampRowActions(roomyBatch, false).topUp, { enabled: true, note: null });
    assert.deepEqual(stampRowActions(fullBatch, false).topUp, { enabled: true, note: null });
  });

  it('stays off for an expired batch, one not usable yet, and while another change is in flight', () => {
    assert.equal(stampRowActions({ ...roomyBatch, batchTTL: 0 }, false).topUp.enabled, false);
    assert.equal(stampRowActions({ ...roomyBatch, usable: false }, false).topUp.enabled, false);
    assert.equal(stampRowActions(roomyBatch, true).topUp.enabled, false);
  });
});

describe('Dilute on a stamps table row', () => {
  it('is offered on a live batch, and on a full one above all, since room is what it buys', () => {
    assert.deepEqual(stampRowActions(fullBatch, false).dilute, { enabled: true, note: null });
    assert.deepEqual(stampRowActions(roomyBatch, false).dilute, { enabled: true, note: null });
  });

  it('is unavailable on a batch already at the deepest depth this manager offers, and says so', () => {
    assert.deepEqual(stampRowActions({ ...roomyBatch, depth: 40 }, false).dilute, {
      enabled: false,
      note: 'already at depth 40',
    });
  });

  it('stays off for an expired batch, one not usable yet, and while another change is in flight', () => {
    assert.equal(stampRowActions({ ...fullBatch, batchTTL: 0 }, false).dilute.enabled, false);
    assert.equal(stampRowActions({ ...fullBatch, usable: false }, false).dilute.enabled, false);
    assert.equal(stampRowActions(fullBatch, true).dilute.enabled, false);
  });
});
