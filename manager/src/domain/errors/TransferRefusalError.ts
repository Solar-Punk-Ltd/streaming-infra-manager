import { chequebookRefusal, type BeeBridgeCheck, type ChequebookRefusal, type ChequebookRefusalCause } from '@streaming-infra-manager/common';

/**
 * A chequebook failure that knows why a transfer was refused. The cause is set
 * where the refusal is decided, from the shared closed list, and is carried
 * through every rewrap on the way to the answer. An upstream error never
 * becomes one, so no upstream text can reach a cause.
 */
export abstract class TransferRefusalError extends Error {
  readonly refusal: ChequebookRefusal;

  protected constructor(message: string, cause: ChequebookRefusalCause, check: BeeBridgeCheck | null) {
    super(message);
    this.refusal = chequebookRefusal(cause, check);
  }

  /** The refusal one of the manager's own chequebook errors carries, and null for anything else. */
  static carried(error: unknown): ChequebookRefusal | null {
    return error instanceof TransferRefusalError ? error.refusal : null;
  }
}
