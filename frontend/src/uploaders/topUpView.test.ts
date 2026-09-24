/**
 * What the top-up dialog shows before the operator pays: the life an amount
 * adds at today's price, the life after, and what it costs, with the confirm
 * naming the cost and refusing an amount the node's wallet cannot pay.
 *
 * The batch is the host's full 1080p batch of 2026-09-24, depth 23 with two
 * days and three hours left, and the price the host's on 2026-09-13, when a day
 * cost 1,571,927,040 PLUR a chunk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_VALUE } from '../format';
import type { BeeStamp } from './stampApi';
import { topUpSentNotice, topUpView } from './topUpView';

const HOUR = 3_600;
const DAY = 24 * HOUR;
const HOST_PRICE = '90968';
const ONE_DAY = '1571927040';
/** ONE_DAY for each of the 2^23 chunks of a depth 23 batch. */
const ONE_DAY_COST_BZZ = '1.318627974316032';

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
  batchTTL: 2 * DAY + 3 * HOUR,
};

const view = (amount: string, walletBzz: string | null = null, currentPrice: string | null = HOST_PRICE) =>
  topUpView({ stamp: hostBatch, amount, currentPrice, walletBzz });

describe('the top-up dialog, before the operator pays', () => {
  it('says what a day more costs a chunk at today’s price, before anything is typed', () => {
    const empty = view('');

    assert.equal(empty.amountHint, `PLUR per chunk. A day more costs ${ONE_DAY} a chunk at today’s price.`);
    assert.equal(empty.canConfirm, false);
    assert.equal(empty.confirmLabel, 'Top up');
    assert.equal(empty.cost, NO_VALUE);
  });

  it('shows the life the amount adds, the life after, and the cost, and names the cost on the confirm', () => {
    const oneDay = view(ONE_DAY);

    assert.equal(oneDay.addsLife, '1d 0h');
    assert.equal(oneDay.lifeAfter, '3d 3h');
    assert.equal(oneDay.cost, `${ONE_DAY_COST_BZZ} BZZ`);
    assert.equal(oneDay.confirmLabel, `Top up for ${ONE_DAY_COST_BZZ} BZZ`);
    assert.equal(oneDay.canConfirm, true);
  });

  it('refuses an amount the node’s wallet cannot pay, and says why', () => {
    const short = view(ONE_DAY, '10000000000000000');

    assert.equal(short.canConfirm, false);
    assert.equal(
      short.shortfall,
      `This node’s wallet holds 1 BZZ, less than the ${ONE_DAY_COST_BZZ} BZZ this top-up costs. Send BZZ to its address first.`,
    );
  });

  it('lets an amount through that the wallet covers, or where the wallet was not read', () => {
    assert.equal(view(ONE_DAY, '20000000000000000').canConfirm, true);
    assert.equal(view(ONE_DAY, '20000000000000000').shortfall, null);
    assert.equal(view(ONE_DAY, null).shortfall, null);
  });

  it('refuses an amount that is not a whole number of PLUR above zero', () => {
    for (const amount of ['0', '1.5', '-1', 'a day', '01']) {
      const typed = view(amount);
      assert.equal(typed.amountValid, false, amount);
      assert.equal(typed.canConfirm, false, amount);
      assert.equal(typed.amountHint, 'A whole number of PLUR above zero.', amount);
    }
  });

  it('still names the cost where the price is not known, and says the life is not known either', () => {
    const unpriced = view(ONE_DAY, null, null);

    assert.equal(unpriced.addsLife, NO_VALUE);
    assert.equal(unpriced.lifeAfter, NO_VALUE);
    assert.equal(unpriced.cost, `${ONE_DAY_COST_BZZ} BZZ`);
    assert.equal(unpriced.amountHint, 'PLUR per chunk. The price is not known yet, so neither is the life it adds.');
  });

  it('writes no dash or semicolon', () => {
    for (const shown of [view(''), view(ONE_DAY, '1'), view('1.5'), view(ONE_DAY, null, null)]) {
      for (const text of [shown.amountHint, shown.shortfall ?? '', shown.confirmLabel]) {
        assert.doesNotMatch(text, /[—;]/);
      }
    }
  });
});

describe('what the card says once bee has answered a top-up', () => {
  it('names the batch and the transaction, and says when the new life shows', () => {
    const notice = topUpSentNotice(hostBatch, { batchID: hostBatch.batchID, txHash: `0x${'ab'.repeat(32)}` });

    assert.equal(
      notice,
      'Bee sent the top-up of batch 1a2b3c4d…2b3c4d in transaction 0xababab…ababab. The new life shows here once the transaction is mined and the node has read it, usually within a minute.',
    );
    assert.doesNotMatch(notice, /[—;]/);
  });
});
