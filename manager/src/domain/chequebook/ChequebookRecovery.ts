import { chequebookAssertionConfirmation, type ChequebookAssertionInput, type ChequebookOperation } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../errors/ChequebookJournalError.js';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';
import { ChequebookRecoveryRequiredError } from '../errors/ChequebookRecoveryRequiredError.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';
import type { ChequebookRecoveryInspector } from './ChequebookRecoveryInspector.js';
import { isTransactionHash, operationId } from './operationIdentity.js';

/** Recovery observes and journals only. It has no submission adapter. */
export class ChequebookRecovery {
  constructor(private readonly repository: ChequebookOperationRepository,
    private readonly inspector: ChequebookRecoveryInspector, private readonly receipts: ChequebookReceiptCheck) {}

  async recover(id: string): Promise<ChequebookOperation> {
    let operation = await this.load(id);
    if (!this.canRecover(operation)) return operation;
    let inspected = await this.inspector.inspect(operation);
    operation = await this.journal(() => this.repository.recordRecovery(operation, inspected.observation, inspected.candidates));
    if (this.canRecover(operation) && inspected.observation.kind === 'candidate' && operation.recoveryObservation?.kind === 'ambiguous' && !inspected.observation.scan) {
      inspected = await this.inspector.inspect(operation, { forceScan: true });
      operation = await this.journal(() => this.repository.recordRecovery(operation, inspected.observation, inspected.candidates));
    }
    return operation.state === 'submitted' ? this.receipts.check(operation.id) : operation;
  }

  async resolve(id: string, hash: string): Promise<ChequebookOperation> {
    if (!isTransactionHash(hash)) throw new ChequebookOperationInputError('transaction hash');
    const operation = await this.load(id);
    if (!this.canRecover(operation)) {
      return operation.state === 'submitted' && operation.transactionHash === hash.toLowerCase() ? this.receipts.check(operation.id) : operation;
    }
    const inspected = await this.inspector.inspectHash(operation, hash.toLowerCase());
    const resolved = await this.journal(() => this.repository.recordRecovery(operation, inspected.observation, inspected.candidates));
    return resolved.state === 'submitted' ? this.receipts.check(resolved.id) : resolved;
  }

  async assertNoSubmission(id: string, input: ChequebookAssertionInput): Promise<ChequebookOperation> {
    const operation = await this.load(id);
    if (input.amountPlur !== operation.amountPlur || input.confirmation !== chequebookAssertionConfirmation(operation.amountPlur) ||
        typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 200) throw new ChequebookOperationInputError('assertion');
    if (!this.canRecover(operation)) return operation;
    if (operation.recoveryObservation?.kind !== 'no_match') throw new ChequebookRecoveryRequiredError();
    return this.journal(() => this.repository.assertNoSubmission(operation, input));
  }

  private canRecover(operation: ChequebookOperation): boolean {
    return ['submitting', 'unknown'].includes(operation.state) && operation.failureReason !== 'hash_conflict';
  }

  private async load(id: string): Promise<ChequebookOperation> {
    const normalized = operationId(id);
    const operation = await this.journal(() => this.repository.findById(normalized));
    if (!operation) throw new ChequebookJournalError();
    return Object.freeze(operation);
  }

  private async journal<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new ChequebookJournalError();
    }
  }
}
