export class BeeConnectionError extends Error {
  constructor() {
    super('The pinned Bee connection could not be used. Check the saved transfer before taking another action.');
    this.name = 'BeeConnectionError';
  }
}
