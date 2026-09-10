import { ChequebookOperationChangedError } from '../../src/domain/errors/ChequebookOperationChangedError.js';
import { historyCursor, normalizeHistoryQuery } from '../../src/domain/chequebook/chequebookHistory.js';
import type { ChainTransaction } from '../../src/domain/chequebook/chainEvidence.js';
import { matchesChequebookTransfer } from '../../src/domain/chequebook/transactionIdentity.js';
import { normalizeRecoveryObservation, preserveRecoveryEvidence } from '../../src/domain/chequebook/recoveryObservation.js';
import { normalizeReceiptObservation } from '../../src/domain/chequebook/receiptObservation.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chequebookAssertionConfirmation, RECEIPT_POLL_BUDGET_MS, type ChequebookHistoryQuery, type ChequebookAssertionInput, type ChequebookRecoveryObservation, type ChequebookSubmissionResponseEvidence, type ChequebookOperation, type ChequebookReceiptObservation, type ChequebookTransferContext, type ChequebookTransferIntent } from '@streaming-infra-manager/common';
import type { ChequebookOperationRepository, NewChequebookOperation, SubmissionOutcome } from '../../src/domain/chequebook/ChequebookOperationRepository.js';

export const profileInstanceId = '11111111-1111-4111-8111-111111111111';
const generations = new Map<string, string>([['test-deployment', profileInstanceId]]);
export function instanceForProfile(name: string): string {
  let generation = generations.get(name);
  if (!generation) { generation = randomUUID(); generations.set(name, generation); }
  return generation;
}
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
  return { requestId: randomUUID(), profileInstanceId: instanceForProfile(overrides.profileName ?? 'test-deployment'), profileName: 'test-deployment', requestedBy: 'test-operator', direction: 'deposit', amountPlur: '5000000000000000', ...overrides };
}

export function operationCandidate(overrides: Partial<NewChequebookOperation> = {}): NewChequebookOperation {
  return { id: randomUUID(), ...transferIntent(overrides), ...transferContext, ...overrides };
}

export class InMemoryChequebookOperations implements ChequebookOperationRepository {
  readonly rows = new Map<string, ChequebookOperation>();
  private readonly pollBudgetMs: number;

  constructor(options: { receiptPollBudgetMs?: number } = {}) {
    this.pollBudgetMs = options.receiptPollBudgetMs ?? RECEIPT_POLL_BUDGET_MS;
  }

  /** Mirrors the SQL rule: opened on the first entry into submitted, never renewed. */
  private pollUntil(row: ChequebookOperation, nextState: ChequebookOperation['state']): string | null {
    if (nextState !== 'submitted') return row.receiptPollUntil;
    return row.receiptPollUntil ?? new Date(Date.now() + this.pollBudgetMs).toISOString();
  }

  async listHistory(input: ChequebookHistoryQuery) {
    const query = normalizeHistoryQuery(input);
    const preciseTime = (value: string) => value.replace(/Z$/, '000Z');
    const rows = [...this.rows.values()].filter(row => !query.profileName || row.profileName === query.profileName)
      .filter(row => !query.after || preciseTime(row.createdAt) < query.after.createdAt || (preciseTime(row.createdAt) === query.after.createdAt && row.id < query.after.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { operations: structuredClone(page), nextCursor: rows.length > query.limit && last ? historyCursor(preciseTime(last.createdAt), last.id) : null };
  }

  async findWithResponses(id: string) {
    const operation = await this.findById(id);
    return operation ? { operation, responseEvidence: await this.listSubmissionResponses(id) } : null;
  }

  async findByRequestId(requestId: string): Promise<ChequebookOperation | null> {
    return structuredClone([...this.rows.values()].find(row => row.requestId === requestId) ?? null);
  }

  async findById(id: string): Promise<ChequebookOperation | null> {
    return structuredClone(this.rows.get(id) ?? null);
  }

  async admit(candidate: NewChequebookOperation) {
    const original = [...this.rows.values()].find(row => row.requestId === candidate.requestId);
    if (original) {
      const same = original.profileName === candidate.profileName && original.profileInstanceId === candidate.profileInstanceId && original.requestedBy === candidate.requestedBy && original.amountPlur === candidate.amountPlur && original.direction === candidate.direction;
      return { kind: same ? 'replayed' as const : 'conflict' as const, operation: structuredClone(original) };
    }
    const open = [...this.rows.values()].find(row => row.chainId === candidate.chainId && row.nodeAddress.toLowerCase() === candidate.nodeAddress.toLowerCase() &&
      (['submitting', 'submitted', 'unknown'].includes(row.state) || row.failureReason === 'hash_conflict'));
    if (open) return { kind: 'busy' as const, operation: structuredClone(open) };
    const now = new Date().toISOString();
    const journalFields = { ...candidate };
    delete journalFields.submissionTarget;
    const row: ChequebookOperation = { ...journalFields, state: 'submitting', transactionHash: null, failureReason: null, dispatchStartedAt: null, revision: '0', receiptObservation: null, receiptCheckedAt: null, receiptPollUntil: null, recoveryObservation: null, recoveryCheckedAt: null, assertion: null, createdAt: now, updatedAt: now };
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
    if (row.state === 'submitting') this.rows.set(id, { ...row, ...outcome, receiptPollUntil: this.pollUntil(row, outcome.state), revision: String(BigInt(row.revision) + 1n) });
    return structuredClone(this.rows.get(id)!);
  }

  async recordReceipt(expected: Pick<ChequebookOperation, 'id' | 'revision' | 'transactionHash'>, observation: ChequebookReceiptObservation): Promise<ChequebookOperation> {
    const row = this.rows.get(expected.id);
    if (!row) throw new Error('Missing operation');
    if (row.failureReason === 'hash_conflict' || row.state !== 'submitted' || row.revision !== expected.revision || row.transactionHash !== expected.transactionHash) return structuredClone(row);
    const now = new Date().toISOString();
    // Postgres stores and compares the observation as normalized jsonb, so the fake decides on that same value.
    const observed = normalizeReceiptObservation(observation);
    const unchanged = isDeepStrictEqual(row.receiptObservation, observed);
    const operation: ChequebookOperation = {
      ...row, state: observed.kind === 'settled' || observed.kind === 'reverted' ? observed.kind : row.state,
      revision: unchanged ? row.revision : String(BigInt(row.revision) + 1n), receiptObservation: structuredClone(observed),
      receiptCheckedAt: now, updatedAt: unchanged ? row.updatedAt : now,
    };
    this.rows.set(row.id, operation);
    return structuredClone(operation);
  }
  async listSubmissionResponses(_id: string): Promise<readonly ChequebookSubmissionResponseEvidence[]> {
    return [];
  }

  async listAwaitingReceipt(input: { intervalMs: number; limit: number }): Promise<readonly ChequebookOperation[]> {
    const now = Date.now();
    return [...this.rows.values()]
      .filter(row => row.state === 'submitted' && row.transactionHash !== null && row.failureReason !== 'hash_conflict' &&
        row.receiptPollUntil !== null && Date.parse(row.receiptPollUntil) > now &&
        (row.receiptCheckedAt === null || Date.parse(row.receiptCheckedAt) <= now - input.intervalMs))
      .sort((a, b) => (Date.parse(a.receiptCheckedAt ?? '') || 0) - (Date.parse(b.receiptCheckedAt ?? '') || 0) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, input.limit)
      .map(row => structuredClone(row));
  }

  async recordRecovery(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookRecoveryObservation, candidates: readonly ChainTransaction[]): Promise<ChequebookOperation> {
    const row = this.rows.get(expected.id)!;
    if (row.revision !== expected.revision || !['unknown', 'submitting'].includes(row.state)) return structuredClone(row);
    let observation = preserveRecoveryEvidence(row, normalizeRecoveryObservation(input), candidates);
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
      receiptPollUntil: this.pollUntil(row, transactionHash ? 'submitted' : row.state),
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
    if (row.revision !== expected.revision) throw new ChequebookOperationChangedError();
    if (!['unknown', 'submitting'].includes(row.state) || row.failureReason === 'hash_conflict') return structuredClone(row);
    if (row.recoveryObservation?.kind !== 'no_match') throw new Error('A complete search is required');
    const result: ChequebookOperation = { ...row, state: 'asserted', assertion: { ...input, assertedAt: new Date().toISOString() }, revision: String(BigInt(row.revision) + 1n) };
    this.rows.set(row.id, result);
    return structuredClone(result);
  }

}
