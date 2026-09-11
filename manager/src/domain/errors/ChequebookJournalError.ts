export class ChequebookJournalError extends Error {
  constructor() {
    super('The transfer journal could not be checked or updated. Refresh the operation before taking another action.');
    this.name = 'ChequebookJournalError';
  }
}
