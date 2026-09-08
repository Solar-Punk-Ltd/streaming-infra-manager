export class ChainEvidenceError extends Error {
  constructor() {
    super('The chain evidence could not be verified.');
    this.name = 'ChainEvidenceError';
  }
}
