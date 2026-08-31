/**
 * What a *recorded* postage batch is actually worth right now.
 *
 * `profiles.stamp_id` only records which batch an uploader was pointed at. A
 * batch is a paid, finite lease: it runs out on its own, and once it does bee
 * stops accepting uploads against it and eventually drops it from `/stamps`
 * altogether. Nothing writes that back to the column, so a profile with a
 * `stamp_id` set is not the same thing as a profile that can upload — and
 * treating the two as one is what let a fully expired ladder render as
 * "4/4 rungs stamped" while every upload failed.
 *
 * The classification lives here, shared, because three places need the same
 * answer: the ladder's readiness (manager), each uploader card's chip
 * (frontend), and the deploy gate.
 */

/** The fields of bee's `/stamps` entry that decide whether a batch can still pay. */
export interface StampLike {
  batchID: string;
  usable: boolean;
  /**
   * Seconds of life left. `0` means spent; bee reports a negative value when it
   * cannot work the TTL out, which is not the same as expired.
   */
  batchTTL: number;
  exists?: boolean;
}

export type StampState =
  /** No batch recorded on the profile at all. */
  | 'none'
  /** Recorded, but its node has not been asked yet or could not answer. */
  | 'unknown'
  /** Recorded, on the node, usable: uploads will be paid for. */
  | 'active'
  /** Recorded, on the node, bought too recently to be usable yet. */
  | 'pending'
  /** Recorded, on the node, out of time. */
  | 'expired'
  /** Recorded, but the node no longer knows this batch — expired and dropped. */
  | 'gone';

export interface StampHealth {
  state: StampState;
  /** An upload paid with this batch would succeed. */
  ok: boolean;
  /** Beyond saving: no amount of waiting brings this batch back. Buy another. */
  dead: boolean;
  /** Seconds left, when the node said. */
  ttl: number | null;
}

const DEAD_STATES: readonly StampState[] = ['expired', 'gone'];

/**
 * How much life left in a batch is worth warning about.
 *
 * The point of a warning is that four rungs can still be topped up while they are
 * alive; once one is spent that rung's uploads have already been failing. Two days
 * is chosen against how the ladder is sized: the rungs' depths are deliberately
 * staggered (17/18/19/20) so the four expiries land hours apart rather than
 * together, and this needs to be wide enough to catch the first one and still be
 * showing when the last goes.
 */
export const STAMP_EXPIRY_WARNING_SECONDS = 48 * 60 * 60;

/**
 * A batch that is still paying but will not be for long.
 *
 * A negative TTL is bee saying it cannot work the remaining time out, not that
 * the time is short — it must not raise this.
 */
export function isStampExpiringSoon(
  ttl: number | null | undefined,
  within: number = STAMP_EXPIRY_WARNING_SECONDS,
): boolean {
  return ttl != null && ttl > 0 && ttl <= within;
}

/**
 * A batch in this state is beyond saving: waiting will not revive it and there is
 * no top-up to apply, so the only way out is buying another one.
 */
export function isDeadStampState(
  state: StampState | null | undefined,
): boolean {
  return state != null && DEAD_STATES.includes(state);
}

/** True once a batch has spent its last second. Purely about the clock. */
export function isStampExpired(stamp: StampLike): boolean {
  return stamp.batchTTL === 0;
}

export function sameBatchId(a: string, b: string): boolean {
  return a.replace(/^0x/, '') === b.replace(/^0x/, '');
}

/**
 * Classify the batch recorded on a profile against what its bee node reports.
 *
 * `stamps` is the node's list, or `null` for "not asked / node did not answer" —
 * the distinction matters: an empty list means the batch is gone, whereas no list
 * at all means we do not know, and a node being down must never be reported as an
 * expired batch.
 */
export function stampHealthFrom(
  stampId: string | null | undefined,
  stamps: readonly StampLike[] | null,
): StampHealth {
  if (!stampId || !stampId.trim()) return health('none', null);
  if (stamps === null) return health('unknown', null);

  const found = stamps.find((stamp) => sameBatchId(stamp.batchID, stampId));
  // A node that disowns the batch is telling us the same thing as one that has
  // dropped it from the list: it is not there any more.
  if (!found || found.exists === false) return health('gone', null);
  if (isStampExpired(found)) return health('expired', found.batchTTL);
  if (!found.usable) return health('pending', found.batchTTL);
  return health('active', found.batchTTL);
}

function health(state: StampState, ttl: number | null): StampHealth {
  return {
    state,
    ok: state === 'active',
    dead: DEAD_STATES.includes(state),
    ttl,
  };
}

/**
 * Why a batch in this state cannot be published with, phrased for an operator
 * reading a list of rungs. Shared so the ladder's readiness and each card's
 * warning cannot drift apart.
 */
export function stampStateReason(state: StampState): string | null {
  switch (state) {
    case 'none':
      return 'no postage batch set on this rung yet';
    case 'expired':
      return 'the postage batch on this rung has expired — buy a new one';
    case 'gone':
      return 'this rung’s bee node no longer holds the batch recorded for it — buy a new one';
    case 'pending':
      return 'the postage batch on this rung is not usable yet — bee is still settling it';
    case 'active':
    case 'unknown':
      return null;
  }
}
