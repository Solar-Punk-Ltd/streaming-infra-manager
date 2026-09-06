export class StackVersionNotFoundError extends Error {
  constructor(public readonly versionId: number) {
    super(`Stack version not found: ${versionId}`);
    this.name = 'StackVersionNotFoundError';
  }
}
