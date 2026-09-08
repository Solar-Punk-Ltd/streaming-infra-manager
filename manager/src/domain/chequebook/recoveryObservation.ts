import type { ChainTransaction } from './chainEvidence.js';
import { matchesChequebookTransfer } from './transactionIdentity.js';
import type { ChequebookOperation, ChequebookRecoveryObservation, ChequebookRecoveryScan } from '@streaming-infra-manager/common';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';
import { isTransactionHash } from './operationIdentity.js';

export const MAX_RECOVERY_CANDIDATES = 256;

export function recoveryHashes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.some(value => !isTransactionHash(value))) throw new ChequebookOperationInputError('recovery hashes');
  const hashes = [...new Set(values.map(value => value.toLowerCase()))];
  if (hashes.length > MAX_RECOVERY_CANDIDATES) throw new ChequebookOperationInputError('recovery hashes');
  return Object.freeze(hashes);
}

function blockNumber(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) throw new ChequebookOperationInputError('recovery block');
  return value;
}

export function normalizeRecoveryScan(input: ChequebookRecoveryScan): ChequebookRecoveryScan {
  const result = { headBlockNumber: blockNumber(input.headBlockNumber), headBlockHash: recoveryHashes([input.headBlockHash])[0]!,
    nextBlockNumber: blockNumber(input.nextBlockNumber), nextBlockHash: recoveryHashes([input.nextBlockHash])[0]!,
    complete: input.complete, candidateHashes: recoveryHashes(input.candidateHashes) };
  if (typeof result.complete !== 'boolean' || BigInt(result.nextBlockNumber) > BigInt(result.headBlockNumber) ||
      (result.headBlockNumber === result.nextBlockNumber && result.headBlockHash !== result.nextBlockHash)) throw new ChequebookOperationInputError('recovery bounds');
  return Object.freeze(result);
}

export function normalizeRecoveryObservation(input: ChequebookRecoveryObservation): ChequebookRecoveryObservation {
  const candidateHashes = recoveryHashes(input.candidateHashes);
  const scan = input.scan ? normalizeRecoveryScan(input.scan) : undefined;
  const evidence = { candidateHashes, ...(scan ? { scan } : {}) };
  if (scan?.candidateHashes.some(hash => !candidateHashes.includes(hash))) throw new ChequebookOperationInputError('recovery evidence');
  if (input.kind === 'searching' && scan && !scan.complete) return Object.freeze({ ...evidence, kind: input.kind, scan });
  if (input.kind === 'no_match' && scan?.complete && candidateHashes.length === 0) return Object.freeze({ ...evidence, kind: input.kind, scan });
  if (input.kind === 'candidate' && candidateHashes.length === 1) return Object.freeze({ ...evidence, kind: input.kind });
  if (input.kind === 'ambiguous' && candidateHashes.length > 0) return Object.freeze({ ...evidence, kind: input.kind });
  if (input.kind === 'could_not_check' && ['rpc_unavailable', 'chain_changed', 'identity_mismatch', 'evidence_limit', 'attribution_conflict'].includes(input.reason)) {
    if (input.reason === 'chain_changed' && scan) throw new ChequebookOperationInputError('recovery history conflict');
    return Object.freeze({ ...evidence, kind: input.kind, reason: input.reason });
  }
  throw new ChequebookOperationInputError('recovery observation');
}

/** A new observation cannot erase a previously observed matching transaction. */
export function preserveRecoveryEvidence(operation: ChequebookOperation, input: ChequebookRecoveryObservation, candidates: readonly ChainTransaction[]): ChequebookRecoveryObservation {
  const previous = operation.recoveryObservation;
  if (input.kind === 'candidate') {
    const candidate = candidates.find(candidate => candidate.hash === input.candidateHashes[0]);
    if (!candidate || !matchesChequebookTransfer(operation, candidate)) {
      return normalizeRecoveryObservation({ kind: 'could_not_check', reason: 'identity_mismatch',
        candidateHashes: previous?.candidateHashes ?? [], ...(previous?.scan ? { scan: previous.scan } : {}) });
    }
  }
  const candidateHashes = recoveryHashes([...(previous?.candidateHashes ?? []), ...input.candidateHashes]);
  const savedScan = input.kind === 'could_not_check' && input.reason === 'chain_changed' ? undefined : input.scan ?? previous?.scan;
  const scan = savedScan ? { ...savedScan, candidateHashes } : undefined;
  const evidence = { candidateHashes, ...(scan ? { scan } : {}) };
  if (input.kind === 'no_match' && candidateHashes.length > 0) return normalizeRecoveryObservation({ kind: 'could_not_check', reason: 'rpc_unavailable', ...evidence });
  if (input.kind === 'candidate' && candidateHashes.length > 1) return normalizeRecoveryObservation({ kind: 'ambiguous', ...evidence });
  return normalizeRecoveryObservation({ ...input, ...evidence });
}
