export class ChequebookConfigurationError extends Error {
  constructor() {
    super('Invalid runtime chequebook configuration.');
    this.name = 'ChequebookConfigurationError';
  }
}
