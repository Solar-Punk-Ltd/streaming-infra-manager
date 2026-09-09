export class ChainReadError extends Error {
  constructor() {
    super('The chain could not be read. The transfer outcome remains unverified.');
    this.name = 'ChainReadError';
  }
}
