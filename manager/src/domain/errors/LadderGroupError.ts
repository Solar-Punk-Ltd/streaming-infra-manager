/**
 * A group-level operation that would corrupt an ABR node pool.
 *
 * A ladder's members are not interchangeable: each publishes one rung and pays
 * with its own postage batch, sized for that rung's bitrate. Operations written
 * for plain fan-out groups — bulk-applying one stamp to every member, appending
 * a `<group>-profile-N` member — quietly break that, so they are refused rather
 * than allowed to half-succeed.
 */
export class LadderGroupError extends Error {
  constructor(
    public readonly groupName: string,
    public readonly reason: string,
  ) {
    super(`${groupName} is an ABR node pool: ${reason}`);
    this.name = 'LadderGroupError';
  }
}
