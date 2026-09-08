import type { ChequebookOperation, ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../errors/ChequebookJournalError.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { ReceiptOperation } from './ChequebookReceiptInspector.js';
import { operationId } from './operationIdentity.js';

type InspectReceipt = (operation: ReceiptOperation) => Promise<ChequebookReceiptObservation>;

export class ChequebookReceiptCheck {
  constructor(private readonly repository: ChequebookOperationRepository, private readonly inspect: InspectReceipt) {}

  async check(inputId: string): Promise<ChequebookOperation> {
    const id = operationId(inputId);
    let operation: ChequebookOperation | null;
    try {
      operation = await this.repository.findById(id);
    } catch {
      throw new ChequebookJournalError();
    }
    if (!operation) throw new ChequebookJournalError();
    if (operation.state !== 'submitted' || !operation.transactionHash) return operation;
    const snapshot = Object.freeze({ ...operation, transactionHash: operation.transactionHash });
    let observation: ChequebookReceiptObservation;
    try {
      observation = await this.inspect(snapshot);
    } catch {
      observation = { kind: 'could_not_check', reason: 'rpc_unavailable' };
    }
    try {
      return await this.repository.recordReceipt(snapshot, observation);
    } catch {
      throw new ChequebookJournalError();
    }
  }
}
