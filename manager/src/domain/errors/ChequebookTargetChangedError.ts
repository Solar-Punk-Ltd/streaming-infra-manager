import { TransferRefusalError } from './TransferRefusalError.js';

export class ChequebookTargetChangedError extends TransferRefusalError {
  constructor() {
    super('The Bee target ownership could not be verified. Refresh the deployment before trying again.', 'target_changed', null);
    this.name = 'ChequebookTargetChangedError';
  }
}
