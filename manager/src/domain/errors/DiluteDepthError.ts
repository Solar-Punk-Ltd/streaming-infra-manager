/**
 * A dilute to a depth no deeper than the batch already has.
 *
 * Diluting only ever raises a batch's depth. Refused before bee is asked,
 * because bee refuses only a shallower depth itself and leaves an equal one to
 * the postage contract, which refuses it on chain as DepthNotIncreasing.
 *
 * Mapped to 400 in the same shape as a schema rejection, because from the
 * caller's side that is what it is: a depth this batch cannot go to.
 */
export class DiluteDepthError extends Error {
  public readonly reason: string;

  constructor(
    public readonly profileName: string,
    public readonly batchId: string,
    public readonly currentDepth: number,
    public readonly requestedDepth: number,
  ) {
    const reason = `Batch ${batchId} is already at depth ${currentDepth}, so it can only be diluted to a depth deeper than ${currentDepth}, not ${requestedDepth}.`;
    super(reason);
    this.reason = reason;
    this.name = 'DiluteDepthError';
  }
}
