/**
 * Why a reading taken from a bee node is missing.
 *
 * A readiness route that could not read something answers 200 with a null in
 * it, and a page with no reason to show renders that null as "not checked",
 * which reads as nobody having asked. A node answering its probes in under a
 * millisecond was drawn that way for days.
 *
 * So the reason travels with the reading: the manager works it out where the
 * call failed and the page turns it into a sentence. Shared, because a reason
 * the page cannot spell is a reason nobody sees.
 */

export type ReadFailureReason =
  /** The node had not answered when the budget ran out. */
  | 'timeout'
  /** Nothing answered at the address at all. */
  | 'unreachable'
  /** The node answered, and would not serve the call. */
  | 'refused'
  /** The node answered with something the manager could not read. */
  | 'malformed';

export interface ReadFailure {
  reason: ReadFailureReason;
  /** How long the call had run when it failed. */
  elapsedMs: number;
}
