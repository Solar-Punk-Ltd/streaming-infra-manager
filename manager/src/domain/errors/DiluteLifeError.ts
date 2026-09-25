/**
 * A dilute that would leave a batch under a day of life.
 *
 * The postage contract refuses that dilution on chain: `increaseDepth` reverts
 * when the balance left for each chunk would pay for fewer than
 * `minimumValidityBlocks`, a day at today's price (storage-incentives,
 * PostageStamp.sol). Refused before bee is asked, so the node never sends a
 * transaction the chain will refuse. The life after is bee's own `batchTTL`
 * halved for every step, the figure the Dilute dialog shows.
 *
 * Mapped to 400 in the same shape as a schema rejection, because from the
 * caller's side that is what it is: a depth this batch cannot go to until it
 * is topped up.
 */
export class DiluteLifeError extends Error {
  public readonly reason: string;

  constructor(
    public readonly profileName: string,
    public readonly batchId: string,
    public readonly requestedDepth: number,
    public readonly ttlAfterSeconds: number,
  ) {
    const reason = `Diluting batch ${batchId} to depth ${requestedDepth} would leave it with ${hoursAndMinutes(ttlAfterSeconds)} of life, under a day, and the postage contract refuses a dilution that leaves less than a day. Top it up first.`;
    super(reason);
    this.reason = reason;
    this.name = 'DiluteLifeError';
  }
}

/** Under a day the way the page writes it, "12h 45m" or "45m". */
function hoursAndMinutes(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
