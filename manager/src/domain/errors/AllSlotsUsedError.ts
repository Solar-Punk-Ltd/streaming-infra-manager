export class AllSlotsUsedError extends Error {
  constructor(public readonly maxSlot: number) {
    super(
      `All port slots 1-${maxSlot} are already allocated. Delete a profile to free one.`,
    );
    this.name = 'AllSlotsUsedError';
  }
}
