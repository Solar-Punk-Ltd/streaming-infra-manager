export class StackVersionExistsError extends Error {
  constructor(public readonly versionName: string) {
    super(`A stack version named ${versionName} already exists.`);
    this.name = 'StackVersionExistsError';
  }
}
