export class ChequebookOperationNotFoundError extends Error {
  constructor() {
    super('The saved transfer was not found.');
    this.name = 'ChequebookOperationNotFoundError';
  }
}
