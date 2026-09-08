import type { Pool } from 'pg';
import type { ProfileRepository } from '../ProfileRepository.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import { ChequebookChainRegistry, chequebookEndpointMode } from './ChequebookChainRegistry.js';
import { ConfiguredBeeTargetResolver } from './ConfiguredBeeTargetResolver.js';
import { ChequebookTransferPreparation } from './ChequebookTransferPreparation.js';
import { ChequebookPendingHashes } from './ChequebookPendingHashes.js';
import { ChequebookReceiptInspector } from './ChequebookReceiptInspector.js';
import { ChequebookReceiptCheck } from './ChequebookReceiptCheck.js';
import { ChequebookRecoveryInspector } from './ChequebookRecoveryInspector.js';
import { ChequebookRecovery } from './ChequebookRecovery.js';
import { ChequebookSubmission } from './ChequebookSubmission.js';
import { ChequebookOperationsService } from './ChequebookOperationsService.js';
import { PostgresChequebookOperationRepository } from './PostgresChequebookOperationRepository.js';

/** These two settings come only from manager runtime configuration, never from an API body or profile. */
export function createChequebookOperationsService(pool: Pool, profiles: ProfileRepository, containers: ContainerRepository,
  runtime: { rpcEndpoints: string | undefined; beeEndpointMode: string | undefined }): ChequebookOperationsService {
  const chains = new ChequebookChainRegistry(runtime.rpcEndpoints);
  const targets = new ConfiguredBeeTargetResolver(profiles, containers, chequebookEndpointMode(runtime.beeEndpointMode));
  const resolveTarget = targets.resolve.bind(targets);
  const preparation = new ChequebookTransferPreparation(resolveTarget, chains);
  const pending = new ChequebookPendingHashes(resolveTarget);
  const repository = new PostgresChequebookOperationRepository(pool);
  const receiptInspector = new ChequebookReceiptInspector((operation, signal) => chains.forChain(operation.chainId, signal));
  const receipts = new ChequebookReceiptCheck(repository, receiptInspector.inspect.bind(receiptInspector));
  const recoveryInspector = new ChequebookRecoveryInspector((operation, signal) => chains.forChain(operation.chainId, signal), pending.read.bind(pending));
  return new ChequebookOperationsService(repository, new ChequebookSubmission(repository, preparation.prepare.bind(preparation)),
    receipts, new ChequebookRecovery(repository, recoveryInspector, receipts));
}
