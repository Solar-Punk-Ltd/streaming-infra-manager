/**
 * The registry of open event streams, on its own.
 *
 * Its whole job is knowing which streams a revocation takes with it and which
 * it must leave running, and the close it performs is a callback, so nothing
 * here needs a socket.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';

const ANN = 1;
const BOB = 2;

interface FakeStream {
  hasClosed(): boolean;
  closeCount(): number;
  unregister(): void;
}

function open(
  streams: OpenStreams,
  tokenHash: string,
  userId: number,
): FakeStream {
  let closes = 0;
  const unregister = streams.open(tokenHash, userId, () => {
    closes += 1;
  });

  return {
    hasClosed: () => closes > 0,
    closeCount: () => closes,
    unregister,
  };
}

describe('the open streams registry', () => {
  it('closes the streams of one session and leaves every other alone', () => {
    const streams = new OpenStreams();
    const phone = open(streams, 'ann-phone', ANN);
    const secondTab = open(streams, 'ann-phone', ANN);
    const laptop = open(streams, 'ann-laptop', ANN);
    const bob = open(streams, 'bob-laptop', BOB);

    assert.equal(streams.closeSession('ann-phone'), 2);

    assert.equal(phone.hasClosed(), true);
    assert.equal(secondTab.hasClosed(), true, 'both tabs share the session');
    assert.equal(laptop.hasClosed(), false);
    assert.equal(bob.hasClosed(), false);
  });

  it('closes every stream a user holds', () => {
    const streams = new OpenStreams();
    const phone = open(streams, 'ann-phone', ANN);
    const laptop = open(streams, 'ann-laptop', ANN);
    const bob = open(streams, 'bob-laptop', BOB);

    assert.equal(streams.closeUser(ANN), 2);

    assert.equal(phone.hasClosed(), true);
    assert.equal(laptop.hasClosed(), true);
    assert.equal(bob.hasClosed(), false);
  });

  it('spares the session named to keep, which a password change is', () => {
    const streams = new OpenStreams();
    const changing = open(streams, 'ann-laptop', ANN);
    const elsewhere = open(streams, 'ann-phone', ANN);

    assert.equal(streams.closeUser(ANN, 'ann-laptop'), 1);

    assert.equal(changing.hasClosed(), false);
    assert.equal(elsewhere.hasClosed(), true);
  });

  it('closes a stream once, however many revocations reach it', () => {
    const streams = new OpenStreams();
    const phone = open(streams, 'ann-phone', ANN);

    streams.closeSession('ann-phone');
    streams.closeSession('ann-phone');
    streams.closeUser(ANN);
    streams.closeAll();

    assert.equal(phone.closeCount(), 1);
  });

  it('forgets a stream the client has already dropped', () => {
    const streams = new OpenStreams();
    const gone = open(streams, 'ann-phone', ANN);

    gone.unregister();

    assert.equal(streams.closeUser(ANN), 0);
    assert.equal(gone.hasClosed(), false);
    assert.deepEqual(streams.openTokenHashes(), []);
  });

  it('names each session with a stream open once, for the expiry check', () => {
    const streams = new OpenStreams();
    open(streams, 'ann-phone', ANN);
    open(streams, 'ann-phone', ANN);
    open(streams, 'bob-laptop', BOB);

    assert.deepEqual(streams.openTokenHashes().sort(), [
      'ann-phone',
      'bob-laptop',
    ]);

    assert.equal(streams.closeAll(), 3);
    assert.deepEqual(streams.openTokenHashes(), []);
  });
});
