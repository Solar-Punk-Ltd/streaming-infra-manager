/**
 * A version name, a branch or a state that the request cannot proceed with.
 * Answered as a rejected body, because the reason is the only useful text.
 */
export class InvalidStackVersionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'InvalidStackVersionError';
  }
}
