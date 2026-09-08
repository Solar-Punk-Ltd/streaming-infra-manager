/** No slot up to the cap is free of a deployment record and of ports another deployment holds. */
export class AllSlotsUsedError extends Error {
  constructor(public readonly slotCap: number) {
    super(
      `Every port slot from 1 to ${slotCap} is taken, by a deployment record or by ports another deployment holds on this daemon. Remove a deployment to free one.`,
    );
    this.name = 'AllSlotsUsedError';
  }
}
