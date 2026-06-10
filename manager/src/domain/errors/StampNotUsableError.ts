/**
 * The profile has a stamp_id, but the bee node reports the batch as expired,
 * not yet propagated, or unknown — deploying the uploader would just produce
 * failed uploads.
 */
export class StampNotUsableError extends Error {
  constructor(
    public readonly profileName: string,
    reason: string,
  ) {
    super(`${reason} — top up / buy a stamp on the Uploaders tab, then retry`);
    this.name = 'StampNotUsableError';
  }
}
