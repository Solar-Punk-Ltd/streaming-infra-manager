import type { Pool } from 'pg';
import { ChequebookChainRegistry, type ChequebookChainReader } from './ChequebookChainRegistry.js';
import type { ChequebookOperation } from '@streaming-infra-manager/common';
import { ChequebookTransferPreparation, ownedAcquisitionBudgets, type CaptureTransferTarget, type OwnedTransferPreparationOptions } from './ChequebookTransferPreparation.js';
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
import { ChequebookDockerTransports, localDockerSocketPath } from './ChequebookDockerTransports.js';
import { OwnedChequebookTransports, type ChequebookTransportDependencies } from './OwnedChequebookTransports.js';
import { Logger } from '../Logger.js';

export interface ChequebookServiceDependencies extends ChequebookTransportDependencies {
  readonly repository?: ChequebookOperationRepository;
  readonly captureTarget?: CaptureTransferTarget;
  readonly createChainReader?: (endpoint: string) => ChequebookChainReader;
  readonly qualificationCatalog?: readonly BeeBridgeQualificationRecord[];
  readonly preparation?: OwnedTransferPreparationOptions;
  readonly receiptPolling?: ReceiptPollerOptions;
}

/** Runtime strings route already qualified transports. Test dependencies are trusted code, never API or profile fields. */
/** A saved transfer's node, which the chain registry reads again when it does not know that node's endpoint. */
type SavedChainNode = Pick<ChequebookOperation, 'chainId' | 'nodeAddress'> & { readonly profileName?: string; readonly profileInstanceId?: string | null };

/** The manager's own process settings a transfer reads. None of them comes from a request or a profile. */
export interface ChequebookRuntime {
  readonly rpcEndpoints: string | undefined;
  readonly dockerTransports: string | undefined;
  /** The manager's DOCKER_HOST, which decides the local socket a transfer on localhost uses. */
  readonly dockerHost?: string | undefined;
}

export function createChequebookOperationsService(pool: Pool, runtime: ChequebookRuntime,
  dependencies: ChequebookServiceDependencies = {}): ChequebookOperationsService {
  let chainRegistry: ChequebookChainRegistry | undefined;
  const registry = () => chainRegistry ??= new ChequebookChainRegistry(runtime.rpcEndpoints, dependencies.createChainReader);
  const ownership = new PostgresChequebookTargetOwnership(pool);
  const captureTarget = dependencies.captureTarget ?? ownership.capture.bind(ownership);
  const routes = new ChequebookDockerTransports(runtime.dockerTransports, dependencies.qualificationCatalog,
    { localSocketPath: localDockerSocketPath(runtime.dockerHost) });
  const transports = new OwnedChequebookTransports(routes, dependencies);
  const acquire = transports.acquire.bind(transports);
  const budgets = ownedAcquisitionBudgets(structuredClone(dependencies.preparation ?? {}));
  /** Opens the node's owned connection only to read the endpoint its container runs with. The bridge it opens is closed unused. */
  const readNodeEndpoint = (node: SavedChainNode) => async (signal?: AbortSignal) => {
    if (!node.profileName || !node.profileInstanceId) return null;
    const acquired = await acquire(await captureTarget(node.profileName, node.profileInstanceId), budgets, signal ?? new AbortController().signal);
    acquired.stream.destroy();
    return acquired.chainEndpoint;
  };
  const chains = {
    forPreparedNode: (chainId: number, nodeAddress: string, nodeEndpoint: string | null, signal?: AbortSignal) =>
      registry().forPreparedNode(chainId, nodeAddress, nodeEndpoint, signal),
    forSavedNode: (node: SavedChainNode, signal?: AbortSignal) => registry().forSavedNode(node.chainId, node.nodeAddress, readNodeEndpoint(node), signal),
  };
  const preparation = ChequebookTransferPreparation.fromOwnedTarget(captureTarget, acquire, chains, dependencies.preparation);
  const pending = ChequebookPendingHashes.fromOwnedTarget(captureTarget, acquire, dependencies.preparation);
  const repository = dependencies.repository ?? new PostgresChequebookOperationRepository(pool);
  const receiptInspector = new ChequebookReceiptInspector((operation, signal) => chains.forSavedNode(operation, signal));
  const receipts = new ChequebookReceiptCheck(repository, receiptInspector.inspect.bind(receiptInspector));
  const recoveryInspector = new ChequebookRecoveryInspector((operation, signal) => chains.forSavedNode(operation, signal), pending.read.bind(pending));
  const poller = new ChequebookReceiptPoller(
    { listAwaitingReceipt: repository.listAwaitingReceipt.bind(repository) },
    { check: receipts.check.bind(receipts) },
    { log: Logger.getInstance(), ...dependencies.receiptPolling });
  return new ChequebookOperationsService(repository, new ChequebookSubmission(repository, preparation.prepare.bind(preparation)),
    receipts, new ChequebookRecovery(repository, recoveryInspector, receipts), transports.shutdown.bind(transports), poller);
}
