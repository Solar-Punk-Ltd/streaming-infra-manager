/**
 * How often a node that stays down is allowed to say so in the manager's log.
 *
 * Every readiness read is shared for three seconds, so an open page asks again
 * every three seconds, and each failed read wrote a warn line of its own. One
 * read against one node that is down is 1,200 lines an hour, and a four rung
 * pool with its six reads is that many times twenty four. The lines are all the
 * same sentence, so the one that matters, the first, is buried by the rest.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NodeReadLog,
  READ_REMINDER_MS,
} from '../../src/domain/nodeReadLog.js';

const WINDOW_MS = 3_000;
const HOUR_MS = 60 * 60_000;

/** A clock a test moves by hand, so an hour costs no time to run. */
function stoppedClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 0;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe('the first failure and the recovery, and little in between', () => {
  it('reports the first failure and says it is the first', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });

    const note = log.failed('main-stage:chequebook');

    assert.equal(note?.first, true);
    assert.equal(note?.failures, 1);
  });

  it('says nothing about a failure inside the reminder window', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });
    log.failed('main-stage:chequebook');

    clock.advance(READ_REMINDER_MS - 1);

    assert.equal(log.failed('main-stage:chequebook'), null);
  });

  it('reminds once the window is over, counting every failure it held back', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });
    log.failed('main-stage:chequebook');
    clock.advance(READ_REMINDER_MS - 1);
    log.failed('main-stage:chequebook');

    clock.advance(1);
    const note = log.failed('main-stage:chequebook');

    assert.equal(note?.first, false);
    assert.equal(note?.failures, 3);
    assert.equal(note?.forMs, READ_REMINDER_MS);
  });

  it('reports a read that works again, with what it cost', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });
    log.failed('main-stage:chequebook');
    clock.advance(WINDOW_MS);
    log.failed('main-stage:chequebook');
    clock.advance(WINDOW_MS);

    const note = log.recovered('main-stage:chequebook');

    assert.equal(note?.failures, 2);
    assert.equal(note?.forMs, 2 * WINDOW_MS);
  });

  it('says nothing about a read that never broke', () => {
    const log = new NodeReadLog({ now: stoppedClock().now });

    assert.equal(log.recovered('main-stage:chequebook'), null);
    assert.equal(log.recovered('main-stage:chequebook'), null);
  });

  it('counts each read of each node on its own', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });

    assert.equal(log.failed('main-stage:chequebook')?.first, true);
    assert.equal(log.failed('main-stage:stamp')?.first, true);
    assert.equal(log.failed('rung-720p:chequebook')?.first, true);
    assert.equal(log.recovered('main-stage:stamp')?.failures, 1);
    assert.equal(log.recovered('rung-720p:chequebook')?.failures, 1);
  });
});

describe('an hour of one read failing every window', () => {
  it('is a start line, at most twelve reminders and a recovery line', () => {
    const clock = stoppedClock();
    const log = new NodeReadLog({ now: clock.now });

    let reads = 0;
    let starts = 0;
    let reminders = 0;
    for (let elapsed = 0; elapsed < HOUR_MS; elapsed += WINDOW_MS) {
      reads += 1;
      const note = log.failed('main-stage:chequebook');
      if (note?.first) starts += 1;
      else if (note) reminders += 1;
      clock.advance(WINDOW_MS);
    }

    const recovery = log.recovered('main-stage:chequebook');

    assert.equal(reads, 1_200, 'the hour is 1,200 reads, which used to be 1,200 lines');
    assert.equal(starts, 1);
    assert.ok(reminders <= 12, `${reminders} reminders is more than twelve`);
    assert.equal(recovery?.failures, 1_200);
    assert.equal(recovery?.forMs, HOUR_MS);
    assert.ok(
      starts + reminders + 1 <= 14,
      `${starts + reminders + 1} lines for 1,200 reads`,
    );
  });
});
