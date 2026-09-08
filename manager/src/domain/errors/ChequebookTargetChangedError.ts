export class ChequebookTargetChangedError extends Error {
  constructor() {
    super('The Bee target ownership could not be verified. Refresh the deployment before trying again.');
    this.name = 'ChequebookTargetChangedError';
  }
}
