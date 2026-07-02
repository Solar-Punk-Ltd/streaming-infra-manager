export class GroupNotFoundError extends Error {
  constructor(public readonly groupId: number) {
    super(`Deployment group not found: ${groupId}`);
    this.name = 'GroupNotFoundError';
  }
}
