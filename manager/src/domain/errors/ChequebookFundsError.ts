/**
 * A move of BZZ this node cannot make: more than its wallet holds, more than
 * its chequebook has available, or no xDAI to pay the gas with.
 *
 * Refused before the call reaches bee, so the operator reads a sentence about
 * their own node rather than a chain revert.
 *
 * Mapped to 400 in the same shape as a schema rejection, because from the
 * caller's side that is what it is: an amount this request cannot carry.
 */
export class ChequebookFundsError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ChequebookFundsError';
  }
}
