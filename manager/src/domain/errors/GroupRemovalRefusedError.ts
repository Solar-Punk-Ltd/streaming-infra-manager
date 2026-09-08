export class GroupRemovalRefusedError extends Error {
  constructor(readonly groupId: number, readonly reason: 'changed' | 'not_empty') {
    super(reason === 'changed' ? 'This group changed. Refresh before removing it.' : 'This group still contains deployments.');
    this.name = 'GroupRemovalRefusedError';
  }
}
