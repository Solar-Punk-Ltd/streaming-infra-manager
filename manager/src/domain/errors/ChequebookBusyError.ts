/**
 * A second deposit or withdrawal for a node that already has one outstanding.
 *
 * Every move reads a balance and then submits against it, and bee answers a
 * submit as soon as the transaction is on its way rather than once it is mined.
 * Two requests overlapping there both read the same balance and both pass the
 * check, so a wallet holding one BZZ can have two deposits of one BZZ accepted
 * and the second reverts on chain, after gas has been spent on it.
 */
export class ChequebookBusyError extends Error {
  constructor(public readonly profileName: string) {
    super(
      'A transfer for this node is already in flight. Wait for it to confirm, then try again.',
    );
    this.name = 'ChequebookBusyError';
  }
}
