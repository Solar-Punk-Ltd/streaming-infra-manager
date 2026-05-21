export class GroupExistsError extends Error {
  constructor(public readonly name: string) {
    super(`Deployment group already exists: ${name}`);
    this.name = 'GroupExistsError';
  }
}
