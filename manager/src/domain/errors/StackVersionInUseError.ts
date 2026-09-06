export class StackVersionInUseError extends Error {
  constructor(
    public readonly versionName: string,
    public readonly deployments: string[],
  ) {
    super(
      `${versionName} still runs ${deployments.length} deployment${deployments.length === 1 ? '' : 's'}: ${deployments.join(', ')}. Move or remove them first.`,
    );
    this.name = 'StackVersionInUseError';
  }
}
