export class StampNotUsableError extends Error {
  constructor(
    public readonly profileName: string,
    reason: string,
  ) {
    super(`${reason} — top up / buy a stamp on the Uploaders tab, then retry`);
    this.name = 'StampNotUsableError';
  }
}
