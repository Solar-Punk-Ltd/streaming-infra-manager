/**
 * A service this operation does not offer.
 *
 * Restarting is limited to the containers an operator has a reason to bounce on
 * their own: the media server, the uploader and the Bee node. The web player
 * and the gateway are restarted by redeploying the whole thing, and there is no
 * fifth container.
 */
export class UnknownServiceError extends Error {
  constructor(
    public readonly service: string,
    public readonly allowed: readonly string[],
  ) {
    super(
      `${service} cannot be restarted on its own. ` +
        `Pick one of ${allowed.join(', ')}, or stop and start the whole deployment.`,
    );
    this.name = 'UnknownServiceError';
  }
}
