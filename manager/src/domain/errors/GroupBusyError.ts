export class GroupBusyError extends Error {
  constructor(
    public readonly groupName: string,
    public readonly busyMembers: string[],
  ) {
    super(
      `Deployment group ${groupName} is busy (members: ${busyMembers.join(', ')})`,
    );
    this.name = 'GroupBusyError';
  }
}
