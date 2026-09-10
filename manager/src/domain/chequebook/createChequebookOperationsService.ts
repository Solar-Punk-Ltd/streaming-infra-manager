import type { Pool } from 'pg';
import { ChequebookChainRegistry, type ChequebookChainReader } from './ChequebookChainRegistry.js';
import { ChequebookTransferPreparation, type CaptureTransferTarget, type OwnedTransferPreparationOptions } from './ChequebookTransferPreparation.js';
import { ChequebookPendingHashes } from './ChequebookPendingHashes.js';
import { ChequebookReceiptInspector } from './ChequebookReceiptInspector.js';
import { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';
import { ChequebookRecoveryInspector } from './ChequebookRecoveryInspector.js';
import { ChequebookRecovery } from './ChequebookRecovery.js';
import { ChequebookSubmission } from './ChequebookSubmission.js';
import { ChequebookOperationsService } from './ChequebookOperationsService.js';
import { ChequebookReceiptPoller, type ReceiptPollerOptions } from './ChequebookReceiptPoller.js';
import { PostgresChequebookOperationRepository } from './PostgresChequebookOperationRepository.js';
import { PostgresChequebookTargetOwnership } from './PostgresChequebookTargetOwnership.js';
import type { ChequebookOperationRepository } from './ChequebookOperationRepository.js';
import type { BeeBridgeQualificationRecord } from './beeBridgeQualification.js';
import { ChequebookDockerTransports } from './ChequebookDockerTransports.js';
import { OwnedChequebookTransports, type ChequebookTransportDependencies } from './OwnedChequebookTransports.js';

export interface ChequebookServiceDependencies extends ChequebookTransportDependencies {
  readonly repository?: ChequebookOperationRepository;
  readonly captureTarget?: CaptureTransferTarget;
  readonly createChainReader?: (endpoint: string) => ChequebookChainReader;
  readonly qualificationCatalog?: readonly BeeBridgeQualificationRecord[];
  readonly preparation?: OwnedTransferPreparationOptions;
  readonly receiptPolling?: ReceiptPollerOptions;
}

/** Runtime strings route already qualified transports. Test dependencies are trusted code, never API or profile fields. */
export function createChequebookOperationsService(pool: Pool,
  runtime: { rpcEndpoints: string | undefined; dockerTransports: string | undefined }, dependencies: ChequebookServiceDependencies = {}): ChequebookOperationsService {
  const rpcEndpoints = runtime.rpcEndpoints;
  let chainRegistry: ChequebookChainRegistry | undefined;
  const chains = { forChain(chainId: number, signal?: AbortSignal) {
    chainRegistry ??= new ChequebookChainRegistry(rpcEndpoints, dependencies.createChainReader);
    return chainRegistry.forChain(chainId, signal);
  } };
  const ownership = new PostgresChequebookTargetOwnership(pool);
  const captureTarget = dependencies.captureTarget ?? ownership.capture.bind(ownership);
  const transports = new OwnedChequebookTransports(new ChequebookDockerTransports(runtime.dockerTransports, dependencies.qualificationCatalog), dependencies);
  const acquire = transports.acquire.bind(transports);
  const preparation = ChequebookTransferPreparation.fromOwnedTarget(captureTarget, acquire, chains, dependencies.preparation);
  const pending = ChequebookPendingHashes.fromOwnedTarget(captureTarget, acquire, dependencies.preparation);
  const repository = dependencies.repository ?? new PostgresChequebookOperationRepository(pool);
  const receiptInspector = new ChequebookReceiptInspector((operation, signal) => chains.forChain(operation.chainId, signal));
  const receipts = new ChequebookReceiptCheck(repository, receiptInspector.inspect.bind(receiptInspector));
  const recoveryInspector = new ChequebookRecoveryInspector((operation, signal) => chains.forChain(operation.chainId, signal), pending.read.bind(pending));
  const poller = new ChequebookReceiptPoller(repository, receipts, dependencies.receiptPolling);
  return new ChequebookOperationsService(repository, new ChequebookSubmission(repository, preparation.prepare.bind(preparation)),
    receipts, new ChequebookRecovery(repository, recoveryInspector, receipts), transports.shutdown.bind(transports), poller);
}
