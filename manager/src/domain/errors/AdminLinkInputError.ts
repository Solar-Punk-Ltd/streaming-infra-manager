/**
 * A save of the manager's web2 admin link the uploader would refuse, one
 * sentence per problem. No sentence repeats the address or the token.
 */
export class AdminLinkInputError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(' '));
    this.name = 'AdminLinkInputError';
  }
}
