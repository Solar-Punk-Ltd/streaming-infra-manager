export class ChequebookOperationInputError extends Error {
  constructor(field: string) {
    super(`Invalid chequebook operation ${field}.`);
    this.name = 'ChequebookOperationInputError';
  }
}
