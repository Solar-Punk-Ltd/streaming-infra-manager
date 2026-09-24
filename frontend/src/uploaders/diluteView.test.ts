/**
 * What the dilute dialog shows before the operator confirms: what the batch
 * will hold, how full it will be and how long it will last at the new depth.
 *
 * The batch is the host's full 1080p batch of 2026-09-24: depth 23 over 16
 * bucket bits, 128 of 128 chunks in its fullest bucket, two days and three
 * hours left. Diluting it one step is the remedy for a full immutable batch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DILUTE_COSTS, diluteSentNotice, diluteView, firstDiluteDepth } from './diluteView';
import type { BeeStamp } from './stampApi';

const hostBatch: BeeStamp = {
  batchID: '1a2b3c4d'.repeat(8),
  utilization: 128,
  usable: true,
  depth: 23,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: 2 * 86_400 + 3 * 3_600,
};

const view = (depth: string) => diluteView({ stamp: hostBatch, depth });

describe('the dilute dialog, before the operator confirms', () => {
  it('starts one step deeper than the batch', () => {
    assert.equal(firstDiluteDepth(hostBatch), 24);
  });

  it('takes the host’s full batch to half full at depth 24, with half its life', () => {
    const oneStep = view('24');

    assert.equal(oneStep.holdsAfter, '16,777,216 chunks, 256 in each bucket');
    assert.equal(oneStep.fullAfter, '50%, 128 of 256 chunks in its fullest bucket');
    assert.equal(oneStep.lifeAfter, '1d 1h');
    assert.equal(oneStep.shortLife, null);
    assert.equal(oneStep.confirmLabel, 'Dilute to depth 24');
    assert.equal(oneStep.canConfirm, true);
  });

  it('warns when the life after would be under a day and suggests a top-up first, without blocking', () => {
    const twoSteps = view('25');

    assert.equal(twoSteps.lifeAfter, '12h 45m');
    assert.equal(
      twoSteps.shortLife,
      'That leaves 12h 45m, under a day, and the postage contract refuses a dilution that leaves less than a day. Top it up first.',
    );
    assert.equal(twoSteps.canConfirm, true);
  });

  it('offers only a whole depth from one step deeper to 40', () => {
    assert.equal(view('24').depthHint, 'From 24 to 40. Every step doubles what the batch holds and halves its life.');
    for (const depth of ['23', '22', '41', '24.5', '', 'deeper']) {
      const refused = view(depth);
      assert.equal(refused.depthValid, false, depth);
      assert.equal(refused.canConfirm, false, depth);
      assert.equal(refused.depthHint, 'A whole depth from 24 to 40.', depth);
      assert.equal(refused.confirmLabel, 'Dilute', depth);
    }
  });

  it('says it costs no BZZ, only the transaction fee', () => {
    assert.equal(DILUTE_COSTS, 'No BZZ, only the transaction fee in xDAI.');
  });

  it('writes no dash or semicolon', () => {
    for (const shown of [view('24'), view('25'), view('41')]) {
      for (const text of [shown.depthHint, shown.shortLife ?? '', shown.confirmLabel, shown.fullAfter, shown.holdsAfter]) {
        assert.doesNotMatch(text, /[—;]/);
      }
    }
    assert.doesNotMatch(DILUTE_COSTS, /[—;]/);
  });
});

describe('what the card says once bee has answered a dilute', () => {
  it('names the batch, the depth and the transaction, and says when the new depth shows', () => {
    const notice = diluteSentNotice(hostBatch, 24, { batchID: hostBatch.batchID, txHash: `0x${'cd'.repeat(32)}` });

    assert.equal(
      notice,
      'Bee sent the dilution of batch 1a2b3c4d…2b3c4d to depth 24 in transaction 0xcdcdcd…cdcdcd, which is mined. The new depth and life show here once the node has read it back from the chain, usually within a minute.',
    );
    assert.doesNotMatch(notice, /[—;]/);
  });
});
