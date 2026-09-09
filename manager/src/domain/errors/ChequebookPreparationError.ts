export class ChequebookPreparationError extends Error {
  constructor() {
    super('The node and chain could not be checked. Refresh the saved transfers before continuing.');
    this.name = 'ChequebookPreparationError';
  }
}
