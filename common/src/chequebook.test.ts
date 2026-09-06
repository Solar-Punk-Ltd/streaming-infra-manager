/**
 * The money rules, which nothing downstream re-implements.
 *
 * Two things are being pinned. The parse is the boundary between text an
 * operator typed and an on-chain amount, so anything it lets through is what
 * gets submitted, and 16 fraction digits is exactly what PLUR can carry. And
 * the verdict has to keep "no reading" apart from "zero": a node that could
 * not be asked must never be reported as one whose chequebook has run dry.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bzzToPlur,
  type ChequebookBalance,
  type ChequebookHealth,
  chequebookHealthFrom,
  chequebookHealthFromPayload,
  chequebookHealthPayload,
  chequebookStateReason,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  drainedChequebooks,
  isChequebookShort,
  MAX_PLUR_DIGITS,
  parsePlur,
  PLUR_PER_BZZ,
  plurToBzz,
  plurToBzzExact,
  type TransferExpectation,
  transferOutcome,
} from './chequebook.js';

const FLOOR = 5n * 10n ** 15n;

describe('bzzToPlur', () => {
  it('reads whole and fractional amounts', () => {
    assert.equal(bzzToPlur('1'), PLUR_PER_BZZ);
    assert.equal(bzzToPlur('0.5'), PLUR_PER_BZZ / 2n);
    assert.equal(bzzToPlur('.5'), PLUR_PER_BZZ / 2n);
    assert.equal(bzzToPlur('2.25'), 22_500_000_000_000_000n);
  });

  it('carries all 16 fraction digits, down to the last PLUR', () => {
    assert.equal(bzzToPlur('1.0000000000000001'), PLUR_PER_BZZ + 1n);
    assert.equal(bzzToPlur('0.0000000000000001'), 1n);
  });

  it('refuses a 17th fraction digit rather than dropping it', () => {
    assert.equal(bzzToPlur('1.00000000000000001'), null);
  });

  it('refuses exponents, signs and anything that is not a decimal', () => {
    for (const text of ['1e3', '-1', '+1', '1,5', 'one', '0x10', '', '  ']) {
      assert.equal(bzzToPlur(text), null, `${text} should be refused`);
    }
  });

  it('refuses zero, which is never a transaction worth submitting', () => {
    assert.equal(bzzToPlur('0'), null);
    assert.equal(bzzToPlur('0.0'), null);
    assert.equal(bzzToPlur('.0'), null);
  });

  it('ignores the whitespace around a pasted amount', () => {
    assert.equal(bzzToPlur('  1.5 '), 15_000_000_000_000_000n);
  });
});

describe('plurToBzz', () => {
  it('writes the same four decimals a balance is shown with', () => {
    assert.equal(plurToBzz(PLUR_PER_BZZ), '1.0000');
    assert.equal(plurToBzz(FLOOR), '0.5000');
    assert.equal(plurToBzz(0n), '0.0000');
    assert.equal(plurToBzz(12_400_000_000_000_000n), '1.2400');
  });

  it('truncates rather than rounding up, so it cannot overstate', () => {
    assert.equal(plurToBzz(1_299_900_000_000_000n), '0.1299');
    assert.equal(plurToBzz(999_999_999_999_999_999n), '99.9999');
  });

  it('is a number for a sentence, so a dust balance rounds to nothing', () => {
    // What a node holds below 0.0001 BZZ is not what these messages are about,
    // and `empty` is a separate state, so nothing depends on telling the two
    // apart by this number. `plurToBzzExact` is where every digit survives.
    assert.equal(plurToBzz(1n), '0.0000');
  });
});

describe('plurToBzzExact', () => {
  it('writes every digit that matters and no trailing zeros', () => {
    assert.equal(plurToBzzExact(PLUR_PER_BZZ), '1');
    assert.equal(plurToBzzExact(FLOOR), '0.5');
    assert.equal(plurToBzzExact(1n), '0.0000000000000001');
    assert.equal(plurToBzzExact(0n), '0');
  });

  it('round trips through the parser, so "use all" leaves no dust', () => {
    for (const plur of [1n, FLOOR, PLUR_PER_BZZ, 12_345_678_901_234_567n]) {
      assert.equal(bzzToPlur(plurToBzzExact(plur)), plur);
    }
  });
});

describe('chequebookStateReason', () => {
  const reasonFor = (available: string) =>
    chequebookStateReason(
      chequebookHealthFrom(
        { totalBalance: available, availableBalance: available },
        FLOOR,
      ),
    );

  it('says what an empty chequebook costs', () => {
    assert.equal(
      reasonFor('0'),
      'Chequebook empty. Uploads stall until it is filled.',
    );
  });

  it('quotes both numbers when it is under the floor', () => {
    assert.equal(
      reasonFor('1200000000000000'),
      "Chequebook 0.1200 BZZ available, under the 0.5000 BZZ floor. Peers stop forwarding this node's uploads when it cannot pay.",
    );
  });

  it('has nothing to say about a funded or unasked node', () => {
    assert.equal(reasonFor('5000000000000000'), null);
    assert.equal(chequebookStateReason(chequebookHealthFrom(null, FLOOR)), null);
  });
});

describe('parsePlur', () => {
  it('takes bee integer amounts and refuses everything else', () => {
    assert.equal(parsePlur('0'), 0n);
    assert.equal(parsePlur('12300000000000000'), 12_300_000_000_000_000n);
    for (const raw of [null, undefined, '', '1.5', '-1', '0x10', 'lots']) {
      assert.equal(parsePlur(raw), null, `${raw} should be refused`);
    }
  });

  it('refuses a digit string longer than any real amount', () => {
    // BigInt has no size limit, so an unbounded digit string is a way to make
    // this spend real time turning nonsense into a number nothing can hold.
    assert.equal(parsePlur('9'.repeat(MAX_PLUR_DIGITS))?.toString().length, 30);
    assert.equal(parsePlur('9'.repeat(MAX_PLUR_DIGITS + 1)), null);
    assert.equal(parsePlur('1'.repeat(10_000)), null);
  });
});

describe('chequebookHealthFrom', () => {
  it('reports unknown when the node was not asked', () => {
    const health = chequebookHealthFrom(null, FLOOR);
    assert.equal(health.state, 'unknown');
    assert.equal(health.availablePlur, null);
  });

  it('reports unknown when the node answered with nonsense', () => {
    const health = chequebookHealthFrom(
      { totalBalance: '1', availableBalance: 'not a number' },
      FLOOR,
    );
    assert.equal(health.state, 'unknown');
  });

  it('reports empty at zero', () => {
    const health = chequebookHealthFrom(
      { totalBalance: '0', availableBalance: '0' },
      FLOOR,
    );
    assert.equal(health.state, 'empty');
    assert.equal(health.availablePlur, 0n);
  });

  it('reports low below the floor', () => {
    assert.equal(
      chequebookHealthFrom(
        { totalBalance: '1200000000000000', availableBalance: '1200000000000000' },
        FLOOR,
      ).state,
      'low',
    );
  });

  it('reports ok exactly at the floor', () => {
    assert.equal(
      chequebookHealthFrom(
        { totalBalance: '5000000000000000', availableBalance: '5000000000000000' },
        FLOOR,
      ).state,
      'ok',
    );
  });

  it('reports ok above the floor', () => {
    assert.equal(
      chequebookHealthFrom(
        { totalBalance: '13100000000000000', availableBalance: '12400000000000000' },
        FLOOR,
      ).state,
      'ok',
    );
  });

  it('answers on what is available, not on the total', () => {
    const health = chequebookHealthFrom(
      { totalBalance: '99000000000000000', availableBalance: '0' },
      FLOOR,
    );
    assert.equal(health.state, 'empty');
  });

  it('carries the floor back, so a message quotes the number the gate used', () => {
    assert.equal(chequebookHealthFrom(null, FLOOR).floorPlur, FLOOR);
  });
});

describe('isChequebookShort', () => {
  it('is true only where the operator has to act', () => {
    assert.equal(isChequebookShort('empty'), true);
    assert.equal(isChequebookShort('low'), true);
    assert.equal(isChequebookShort('ok'), false);
    assert.equal(isChequebookShort('unknown'), false);
  });
});

describe('drainedChequebooks', () => {
  const healths = (available: Record<string, string | null>) =>
    new Map<string, ChequebookHealth>(
      Object.entries(available).map(([name, plur]) => [
        name,
        chequebookHealthFrom(
          plur === null
            ? null
            : { totalBalance: plur, availableBalance: plur },
          FLOOR,
        ),
      ]),
    );

  const RUNGS = ['pool-360p', 'pool-480p', 'pool-720p', 'pool-1080p'];

  it('names the rungs that cannot pay at all', () => {
    assert.deepEqual(
      drainedChequebooks(
        healths({
          'pool-360p': '5000000000000000',
          'pool-480p': '0',
          'pool-720p': '5000000000000000',
          'pool-1080p': '0',
        }),
        RUNGS,
      ),
      ['pool-480p', 'pool-1080p'],
    );
  });

  it('leaves a low rung out, because it can still pay', () => {
    // A low rung is a warning under the pool string, never a reason to call the
    // whole pool unready: an uploader publishing to it still lands segments.
    assert.deepEqual(
      drainedChequebooks(healths({ 'pool-360p': '1200000000000000' }), RUNGS),
      [],
    );
  });

  it('says nothing about a rung that did not answer', () => {
    assert.deepEqual(
      drainedChequebooks(healths({ 'pool-360p': null }), RUNGS),
      [],
    );
    assert.deepEqual(drainedChequebooks(new Map(), RUNGS), []);
  });

  it('ignores readings for nodes outside the group', () => {
    assert.deepEqual(
      drainedChequebooks(healths({ 'some-other-node': '0' }), RUNGS),
      [],
    );
  });
});

describe('the health payload', () => {
  it('survives the round trip through JSON', () => {
    const health = chequebookHealthFrom(
      { totalBalance: '1', availableBalance: '1200000000000000' },
      FLOOR,
    );
    const wire = JSON.parse(
      JSON.stringify(chequebookHealthPayload(health)),
    ) as ReturnType<typeof chequebookHealthPayload>;

    assert.deepEqual(chequebookHealthFromPayload(wire), health);
  });

  it('keeps a missing reading missing', () => {
    const health = chequebookHealthFrom(null, FLOOR);
    assert.deepEqual(
      chequebookHealthFromPayload(chequebookHealthPayload(health)),
      health,
    );
  });
});

describe('the default floor', () => {
  it('is a value the parser accepts', () => {
    assert.equal(bzzToPlur(DEFAULT_CHEQUEBOOK_FLOOR_BZZ), FLOOR);
  });
});

describe('transferOutcome', () => {
  const ONE = PLUR_PER_BZZ.toString();
  const TWO = (PLUR_PER_BZZ * 2n).toString();
  const THREE = (PLUR_PER_BZZ * 3n).toString();
  const HALF = (PLUR_PER_BZZ / 2n).toString();

  const DEPOSIT: TransferExpectation = {
    direction: 'deposit',
    amountPlur: PLUR_PER_BZZ,
  };
  const WITHDRAW: TransferExpectation = {
    direction: 'withdraw',
    amountPlur: PLUR_PER_BZZ,
  };

  const total = (totalBalance: string | null) => ({ totalBalance });
  const balance = (
    totalBalance: string,
    availableBalance: string,
  ): ChequebookBalance => ({ totalBalance, availableBalance });

  it('settles a deposit once the total has risen by the amount', () => {
    assert.equal(transferOutcome(total(ONE), total(TWO), DEPOSIT), 'settled');
    assert.equal(transferOutcome(total('0'), total(ONE), DEPOSIT), 'settled');
  });

  it('settles a deposit that landed alongside another movement', () => {
    assert.equal(transferOutcome(total(ONE), total(THREE), DEPOSIT), 'settled');
  });

  it('holds a deposit pending until the whole amount has arrived', () => {
    assert.equal(transferOutcome(total(ONE), total(ONE), DEPOSIT), 'pending');
    assert.equal(transferOutcome(total(ONE), total(HALF), DEPOSIT), 'pending');
  });

  it('settles a withdrawal once the total has fallen by the amount', () => {
    assert.equal(transferOutcome(total(TWO), total(ONE), WITHDRAW), 'settled');
    assert.equal(transferOutcome(total(ONE), total('0'), WITHDRAW), 'settled');
  });

  it('holds a withdrawal pending while the total is unchanged', () => {
    assert.equal(transferOutcome(total(TWO), total(TWO), WITHDRAW), 'pending');
  });

  it('never reads a move as the transfer that went the other way', () => {
    assert.equal(transferOutcome(total(ONE), total(TWO), WITHDRAW), 'pending');
    assert.equal(transferOutcome(total(TWO), total(ONE), DEPOSIT), 'pending');
  });

  it('ignores the available balance, which every cheque moves', () => {
    assert.equal(
      transferOutcome(balance(TWO, TWO), balance(TWO, ONE), DEPOSIT),
      'pending',
    );
    assert.equal(
      transferOutcome(balance(TWO, ONE), balance(TWO, TWO), WITHDRAW),
      'pending',
    );
  });

  it('answers unknown for a reading that never arrived', () => {
    assert.equal(transferOutcome(null, total(TWO), DEPOSIT), 'unknown');
    assert.equal(transferOutcome(total(ONE), null, DEPOSIT), 'unknown');
    assert.equal(transferOutcome(null, null, WITHDRAW), 'unknown');
  });

  it('answers unknown for a number that turned into a failed read', () => {
    assert.equal(transferOutcome(total(null), total(TWO), DEPOSIT), 'unknown');
    assert.equal(transferOutcome(total(ONE), total(null), DEPOSIT), 'unknown');
    assert.equal(transferOutcome(total(null), total(ONE), WITHDRAW), 'unknown');
    assert.equal(transferOutcome(total(TWO), total(null), WITHDRAW), 'unknown');
  });

  it('answers unknown for a total that is not a PLUR amount', () => {
    for (const raw of ['', '   ', '1.5', '-1', '0x10', '1e3', 'lots']) {
      assert.equal(
        transferOutcome(total(ONE), total(raw), DEPOSIT),
        'unknown',
        `${raw} should not be read as a balance`,
      );
    }
  });
});
