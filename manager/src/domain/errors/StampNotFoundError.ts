/**
 * A batch a deployment's own Bee node does not hold, asked to be changed.
 *
 * Its node lists no such batch among its own: it was never bought there, or it
 * expired and was dropped. Refused before anything is sent to be paid for,
 * because bee itself answers a change to such a batch with a bare 500.
 */
export class StampNotFoundError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly batchId: string,
  ) {
    super(
      `The Bee node of ${profileName} does not hold batch ${batchId}. It was never bought there, or it expired and was dropped.`,
    );
    this.name = 'StampNotFoundError';
  }
}
