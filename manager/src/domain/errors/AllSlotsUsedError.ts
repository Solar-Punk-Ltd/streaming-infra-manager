export class AllSlotsUsedError extends Error {
  constructor() {
    super(
      'All port slots 1-999 are already allocated. Delete a profile to free one.',
    );
    this.name = 'AllSlotsUsedError';
  }
}
