export class WeakPasswordError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WeakPasswordError';
  }
}
