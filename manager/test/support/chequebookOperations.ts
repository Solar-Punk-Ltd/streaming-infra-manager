import type { ChainTransaction } from '../../src/domain/chequebook/chainEvidence.js';
import { matchesChequebookTransfer } from '../../src/domain/chequebook/transactionIdentity.js';
import { normalizeRecoveryObservation } from '../../src/domain/chequebook/recoveryObservation.js';
import { randomUUID } from 'node:crypto';
import { chequebookAssertionConfirmation, type ChequebookAssertionInput, type ChequebookRecoveryObservation, type ChequebookSubmissionResponseEvidence, type ChequebookOperation, type ChequebookReceiptObservation, type ChequebookTransferContext, type ChequebookTransferIntent } from '@streaming-infra-manager/common';
import type { ChequebookOperationRepository, NewChequebookOperation, SubmissionOutcome } from '../../src/domain/chequebook/ChequebookOperationRepository.js';

export const nodeAddress = `0x${'ab'.repeat(20)}`;
export const transactionHash = `0x${'cd'.repeat(32)}`;
export const transferContext: ChequebookTransferContext = {
  chainId: 100,
  nodeAddress,
  chequebookAddress: `0x${'12'.repeat(20)}`,
  tokenAddress: `0x${'34'.repeat(20)}`,
  startBlockNumber: '500',
  startBlockHash: `0x${'56'.repeat(32)}`,
  nonceLowerBound: '8',
  nonceQueryTag: '0x1f4',
};

export function transferIntent(overrides: Partial<ChequebookTransferIntent> = {}): ChequebookTransferIntent {
  return { requestId: randomUUID(), profileName: 'test-deployment', requestedBy: 'test-operator', direction: 'deposit', amountPlur: '5000000000000000', ...overrides };
}

export function operationCandidate(overrides: Partial<NewChequebookOperation> = {}): NewChequebookOperation {
  return { id: randomUUID(), ...transferIntent(), ...transferContext, ...overrides };
}

export class InMemoryChequebookOperations implements ChequebookOperationRepository {
  readonly rows = new Map<string, ChequebookOperation>();

  async findByRequestId(requestId: string): Promise<ChequebookOperation | null> {
    return structuredClone([...this.rows.values()].find(row => row.requestId === requestId) ?? null);
  }

  async findById(id: string): Promise<ChequebookOperation | null> {
    return structuredClone(this.rows.get(id) ?? null);
  }

  async admit(candidate: NewChequebookOperation) {
    const original = [...this.rows.values()].find(row => row.requestId === candidate.requestId);
    if (original) {
      const same = original.profileName === candidate.profileName && original.requestedBy === candidate.requestedBy && original.amountPlur === candidate.amountPlur && original.direction === candidate.direction;
      return { kind: same ? 'replayed' as const : 'conflict' as const, operation: structuredClone(original) };
    }
    const open = [...this.rows.values()].find(row => row.chainId === candidate.chainId && row.nodeAddress.toLowerCase() === candidate.nodeAddress.toLowerCase() && ['submitting', 'submitted', 'unknown'].includes(row.state));
    if (open) return { kind: 'busy' as const, operation: structuredClone(open) };
    const now = new Date().toISOString();
    const row: ChequebookOperation = { ...candidate, state: 'submitting', transactionHash: null, failureReason: null, dispatchStartedAt: null, revision: '0', receiptObservation: null, receiptCheckedAt: null, recoveryObservation: null, recoveryCheckedAt: null, assertion: null, createdAt: now, updatedAt: now };
    this.rows.set(row.id, structuredClone(row));
    return { kind: 'admitted' as const, operation: structuredClone(row) };
  }

  async claimDispatch(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new Error('Missing operation');
    if (row.state !== 'submitting' || row.dispatchStartedAt !== null) return { claimed: false, operation: structuredClone(row) };
    const operation = { ...row, dispatchStartedAt: new Date().toISOString(), revision: String(BigInt(row.revision) + 1n) };
    this.rows.set(id, operation);
    return { claimed: true, operation: structuredClone(operation) };
  }

  async recordSubmission(id: string, outcome: SubmissionOutcome): Promise<ChequebookOperation> {
    const row = this.rows.get(id);
    if (!row) throw new Error('Missing operation');
    if (row.state === 'submitting') this.rows.set(id, { ...row, ...outcome, revision: String(BigInt(row.revision) + 1n) });
    return structuredClone(this.rows.get(id)!);
  }

  async recordReceipt(expected: Pick<ChequebookOperation, 'id' | 'revision' | 'transactionHash'>, observation: ChequebookReceiptObservation): Promise<ChequebookOperation> {
    const row = this.rows.get(expected.id);
    if (!row) throw new Error('Missing operation');
    if (row.state !== 'submitted' || row.revision !== expected.revision || row.transactionHash !== expected.transactionHash) return structuredClone(row);
    const now = new Date().toISOString();
    const operation: ChequebookOperation = {
      ...row, state: observation.kind === 'settled' || observation.kind === 'reverted' ? observation.kind : row.state,
      revision: String(BigInt(row.revision) + 1n), receiptObservation: structuredClone(observation), receiptCheckedAt: now, updatedAt: now,
    };
    this.rows.set(row.id, operation);
    return structuredClone(operation);
  }
  async listSubmissionResponses(_id: string): Promise<readonly ChequebookSubmissionResponseEvidence[]> {
    return [];
  }

  async recordRecovery(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookRecoveryObservation, candidates: readonly ChainTransaction[]): Promise<ChequebookOperation> {
    const row = this.rows.get(expected.id)!;
    if (row.revision !== expected.revision || !['unknown', 'submitting'].includes(row.state)) return structuredClone(row);
    let observation = normalizeRecoveryObservation(input);
    let transactionHash = null;
    if (observation.kind === 'candidate') {
      const candidate = candidates.find(candidate => candidate.hash === observation.candidateHashes[0]);
      if (!candidate || !matchesChequebookTransfer(row, candidate)) observation = { kind: 'could_not_check', reason: 'identity_mismatch', candidateHashes: observation.candidateHashes };
      else if ([...this.rows.values()].some(other => other.id !== row.id &&
          ((other.chainId === row.chainId && other.transactionHash === candidate.hash) ||
           (other.dispatchStartedAt && !other.transactionHash && matchesChequebookTransfer(other, candidate))))) observation = { ...observation, kind: 'ambiguous' };
      else transactionHash = candidate.hash;
    }
    const now = new Date().toISOString();
    const result: ChequebookOperation = { ...row, transactionHash, state: transactionHash ? 'submitted' : row.state,
      recoveryObservation: observation, recoveryCheckedAt: now, updatedAt: now, revision: String(BigInt(row.revision) + 1n) };
    this.rows.set(row.id, result);
    return structuredClone(result);
  }

  async resolveCandidate(expected: Pick<ChequebookOperation, 'id' | 'revision'>, candidate: ChainTransaction): Promise<ChequebookOperation> {
    return this.recordRecovery(expected, { kind: 'candidate', candidateHashes: [candidate.hash] }, [candidate]);
  }

  async assertNoSubmission(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookAssertionInput): Promise<ChequebookOperation> {
    const row = this.rows.get(expected.id)!;
    if (input.amountPlur !== row.amountPlur || input.confirmation !== chequebookAssertionConfirmation(row.amountPlur)) throw new Error('Invalid assertion');
    if (row.revision !== expected.revision || !['unknown', 'submitting'].includes(row.state)) return structuredClone(row);
    if (row.recoveryObservation?.kind !== 'no_match') throw new Error('A complete search is required');
    const result: ChequebookOperation = { ...row, state: 'asserted', assertion: { ...input, assertedAt: new Date().toISOString() }, revision: String(BigInt(row.revision) + 1n) };
    this.rows.set(row.id, result);
    return structuredClone(result);
  }

}
