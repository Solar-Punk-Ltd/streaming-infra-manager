export class BeeNodeError extends Error {
  constructor(
    public readonly profileName: string,
    message: string,
  ) {
    super(message);
    this.name = 'BeeNodeError';
  }
}
