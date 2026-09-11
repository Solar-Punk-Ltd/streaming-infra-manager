import { chequebookAssertionConfirmation, type ChequebookAdmissionDetail, type ChequebookAssertionInput, type ChequebookHistoryPage,
  type ChequebookHistoryQuery, type ChequebookOperationDetail, type ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../errors/ChequebookJournalError.js';
import { ChequebookOperationNotFoundError } from '../errors/ChequebookOperationNotFoundError.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { ChequebookSubmission } from './ChequebookSubmission.js';
import type { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';
import type { ChequebookReceiptPoller } from './ChequebookReceiptPoller.js';
import type { ChequebookRecovery } from './ChequebookRecovery.js';
import { normalizeHistoryQuery } from './chequebookHistory.js';
import { operationId } from './operationIdentity.js';
import type { ChequebookTransportCleanup } from './OwnedChequebookTransports.js';

/** Global saved-operation reads are independent of current profile existence and configuration. */
export class ChequebookOperationsService {
  constructor(private readonly repository: ChequebookOperationRepository, private readonly submission: ChequebookSubmission,
    private readonly receipts: ChequebookReceiptCheck, private readonly recovery: ChequebookRecovery,
    private readonly closeTransports: () => Promise<readonly ChequebookTransportCleanup[]> = async () => [],
    private readonly poller?: Pick<ChequebookReceiptPoller, 'start' | 'stop'>) {}

  /** Begins bounded receipt polling for every submitted transfer whose budget has not passed. */
  start(): void { this.poller?.start(); }

  async shutdown(): Promise<readonly ChequebookTransportCleanup[]> {
    await this.poller?.stop();
    return this.closeTransports();
  }

  async submit(intent: ChequebookTransferIntent): Promise<ChequebookAdmissionDetail> {
    const result = await this.submission.submit(intent);
    return { kind: result.kind, ...await this.detail(result.operation.id) };
  }

  async detail(inputId: string): Promise<ChequebookOperationDetail> {
    const id = operationId(inputId);
    const result = await this.journal(() => this.repository.findWithResponses(id));
    if (!result) throw new ChequebookOperationNotFoundError();
    return { ...result, assertionConfirmation: chequebookAssertionConfirmation(result.operation.amountPlur) };
  }

  async byRequestId(input: string): Promise<ChequebookOperationDetail> {
    const requestId = operationId(input);
    const operation = await this.journal(() => this.repository.findByRequestId(requestId));
    if (!operation) throw new ChequebookOperationNotFoundError();
    return this.detail(operation.id);
  }

  async history(query: ChequebookHistoryQuery): Promise<ChequebookHistoryPage> {
    normalizeHistoryQuery(query);
    return this.journal(() => this.repository.listHistory(query));
  }

  async check(id: string): Promise<ChequebookOperationDetail> {
    const { operation } = await this.detail(id);
    if (operation.state === 'submitted') await this.receipts.check(operation.id);
    else if (operation.state === 'submitting' || operation.state === 'unknown') await this.recovery.recover(operation.id);
    return this.detail(operation.id);
  }

  async resolve(id: string, hash: string): Promise<ChequebookOperationDetail> {
    const { operation } = await this.detail(id);
    await this.recovery.resolve(operation.id, hash);
    return this.detail(operation.id);
  }

  async assertNoSubmission(id: string, input: ChequebookAssertionInput, expectedRevision: string): Promise<ChequebookOperationDetail> {
    const { operation } = await this.detail(id);
    await this.recovery.assertNoSubmission(operation.id, input, expectedRevision);
    return this.detail(operation.id);
  }

  private async journal<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch { throw new ChequebookJournalError(); }
  }
}
