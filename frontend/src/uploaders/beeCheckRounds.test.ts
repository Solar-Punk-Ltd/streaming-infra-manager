import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeeCheckRounds, shouldRunTick } from './beeCheckRounds';

describe('the node checks a slow node must still get through', () => {
  it('skips a tick while a round is still asking, and while nobody is looking', () => {
    assert.equal(shouldRunTick(false, false), true);
    assert.equal(shouldRunTick(true, false), false);
    assert.equal(shouldRunTick(false, true), false);
    assert.equal(shouldRunTick(true, true), false);
  });

  it('lets a round that outlives three ticks write its answers', () => {
    // The shape of the bug: six routes give the node ten seconds each and the
    // cadence is ten seconds, so every round used to be superseded before it
    // returned and none of them ever wrote.
    const rounds = new BeeCheckRounds();
    const slow = rounds.begin();

    for (let tick = 0; tick < 3; tick += 1) {
      assert.equal(shouldRunTick(rounds.inFlight, false), false);
    }

    assert.equal(slow.signal.aborted, false);
    assert.equal(rounds.isNewest(slow.id), true);
    rounds.end(slow.id);
    assert.equal(shouldRunTick(rounds.inFlight, false), true);
  });

  it('drops the round a manual reload replaced and ends its requests', () => {
    const rounds = new BeeCheckRounds();
    const superseded = rounds.begin();
    const newest = rounds.begin();

    assert.equal(superseded.signal.aborted, true);
    assert.equal(rounds.isNewest(superseded.id), false);
    assert.equal(rounds.isNewest(newest.id), true);

    rounds.end(superseded.id);
    assert.equal(rounds.inFlight, true);
    rounds.end(newest.id);
    assert.equal(rounds.inFlight, false);
  });

  it('ends a round the card abandoned, and refuses its answers', () => {
    const rounds = new BeeCheckRounds();
    const round = rounds.begin();

    rounds.abandon();

    assert.equal(round.signal.aborted, true);
    assert.equal(rounds.isNewest(round.id), false);
    assert.equal(rounds.inFlight, false);
  });
});
