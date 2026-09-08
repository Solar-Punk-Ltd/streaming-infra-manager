import { ChequebookProfileChangedError } from '../errors/ChequebookProfileChangedError.js';
import { randomUUID } from 'node:crypto';
import type { BeeTransaction, ChequebookAdmissionResult, ChequebookOperation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../errors/ChequebookJournalError.js';
import { ChequebookPreparationError } from '../errors/ChequebookPreparationError.js';
import type { ChequebookOperationRepository, SubmissionOutcome } from './ChequebookOperationRepository.js';
import { isTransactionHash, normalizeTransferContext, normalizeTransferIntent, sameTransferIntent } from './operationIdentity.js';

export interface PreparedChequebookTransfer {
  /** Close the private Bee session. Must be idempotent and must not throw. */
  dispose(): void;
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

    let prepared: PreparedChequebookTransfer;
    try {
      prepared = await this.prepare(intent);
    } catch (error) {
      if (error instanceof ChequebookProfileChangedError) throw error;
      throw new ChequebookPreparationError();
    }
    try {
      return await this.submitPrepared(prepared, intent);
    } finally {
      prepared.dispose();
    }
  }

  private async submitPrepared(prepared: PreparedChequebookTransfer, intent: ChequebookTransferIntent): Promise<ChequebookAdmissionResult> {
    const context = normalizeTransferContext(prepared.context);
    const admitted = await this.journal(() => this.operations.admit({ id: randomUUID(), ...intent, ...context }));
    if (admitted.kind !== 'admitted') return admitted;
    const operation = Object.freeze({ ...admitted.operation });

    try {
      await prepared.preflight(operation);
    } catch {
      return this.finish(operation, { state: 'rejected', transactionHash: null, failureReason: 'preflight_failed' });
    }

    const dispatch = await this.journal(() => this.operations.claimDispatch(operation.id));
    if (!dispatch.claimed) return { kind: 'admitted', operation: dispatch.operation };

    let result: BeeTransaction;
    try {
      result = await prepared.send(Object.freeze({ ...dispatch.operation }));
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
    } catch (error) {
      if (error instanceof ChequebookProfileChangedError) throw error;
      // Driver messages may include connection details. The durable row is left intact.
      throw new ChequebookJournalError();
    }
  }
}
