export class ChequebookRecoveryRequiredError extends Error {
  constructor() {
    super('A complete search without a matching transaction is required before an assertion.');
    this.name = 'ChequebookRecoveryRequiredError';
  }
}
