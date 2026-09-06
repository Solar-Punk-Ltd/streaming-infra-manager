/**
 * One build at a time. The stack still tags its images by name alone, so two
 * checkouts building together would overwrite each other's tags, and each
 * deployment would end up on whichever half finished last.
 */
export class StackBuildBusyError extends Error {
  constructor(public readonly buildingName: string) {
    super(`${buildingName} is building. Wait for it to finish, then try again.`);
    this.name = 'StackBuildBusyError';
  }
}
