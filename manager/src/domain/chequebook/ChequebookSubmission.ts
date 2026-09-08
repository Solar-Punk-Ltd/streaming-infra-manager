import { randomUUID } from 'node:crypto';
import type { BeeTransaction, ChequebookAdmissionResult, ChequebookOperation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../errors/ChequebookJournalError.js';
import type { ChequebookOperationRepository, SubmissionOutcome } from './ChequebookOperationRepository.js';
import { isTransactionHash, normalizeTransferContext, normalizeTransferIntent, sameTransferIntent } from './operationIdentity.js';

export interface PreparedChequebookTransfer {
  context: ChequebookTransferContext;
  /** Read-only checks, performed under the durable node guard. */
  preflight(operation: ChequebookOperation): Promise<void>;
  /** Exactly one Bee POST. This adapter must not retry a failed request. */
  send(operation: ChequebookOperation): Promise<BeeTransaction>;
}

export type PrepareChequebookTransfer = (intent: ChequebookTransferIntent) => Promise<PreparedChequebookTransfer>;

/** A returned or recovered journal row never authorizes a second POST. */
export class ChequebookSubmission {
  constructor(
    private readonly operations: ChequebookOperationRepository,
    private readonly prepare: PrepareChequebookTransfer,
  ) {}

  async submit(input: ChequebookTransferIntent): Promise<ChequebookAdmissionResult> {
    const intent = normalizeTransferIntent(input);
    const existing = await this.journal(() => this.operations.findByRequestId(intent.requestId));
    if (existing) return { kind: sameTransferIntent(existing, intent) ? 'replayed' : 'conflict', operation: existing };

    const prepared = await this.prepare(intent);
    const context = normalizeTransferContext(prepared.context);
    const admitted = await this.journal(() => this.operations.admit({ id: randomUUID(), ...intent, ...context }));
    if (admitted.kind !== 'admitted') return admitted;
    const operation = Object.freeze({ ...admitted.operation });

    try {
      await prepared.preflight(operation);
    } catch {
      return this.finish(operation, { state: 'rejected', transactionHash: null, failureReason: 'preflight_failed' });
    }

    let result: BeeTransaction;
    try {
      result = await prepared.send(operation);
    } catch {
      return this.finish(operation, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    }
    if (!isTransactionHash(result?.transactionHash)) {
      return this.finish(operation, { state: 'unknown', transactionHash: null, failureReason: 'invalid_response' });
    }
    return this.finish(operation, { state: 'submitted', transactionHash: result.transactionHash.toLowerCase(), failureReason: null });
  }

  private async finish(operation: ChequebookOperation, outcome: SubmissionOutcome): Promise<ChequebookAdmissionResult> {
    const recorded = await this.journal(() => this.operations.recordSubmission(operation.id, outcome));
    return { kind: 'admitted', operation: recorded };
  }

  private async journal<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      // Driver messages may include connection details. The durable row is left intact.
      throw new ChequebookJournalError();
    }
  }
}
