import type { Pool, PoolClient } from 'pg';
import { chequebookAssertionConfirmation, type ChequebookAssertion, type ChequebookAssertionInput, type ChequebookRecoveryObservation, type ChequebookSubmissionResponseEvidence, type ChequebookAdmissionResult, type ChequebookOperation, type ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import type { ChequebookOperationRepository, NewChequebookOperation, SubmissionOutcome } from './ChequebookOperationRepository.js';
import { isTransactionHash, normalizeTransferContext, normalizeTransferIntent, operationId, sameTransferIntent } from './operationIdentity.js';
import type { ChainTransaction } from './chainEvidence.js';
import { matchesChequebookTransfer } from './transactionIdentity.js';
import { normalizeRecoveryObservation } from './recoveryObservation.js';
import { normalizeReceiptObservation } from './receiptObservation.js';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';

type OperationRow = {
  id: string; request_id: string; profile_name: string; requested_by: string;
  direction: ChequebookOperation['direction']; amount_plur: string; chain_id: string;
  node_address: string; chequebook_address: string; token_address: string;
  start_block_number: string; start_block_hash: string; nonce_lower_bound: string; nonce_query_tag: string;
  state: ChequebookOperation['state']; transaction_hash: string | null;
  failure_reason: ChequebookOperation['failureReason']; dispatch_started_at: Date | null; created_at: Date; updated_at: Date;
  recovery_observation: ChequebookRecoveryObservation | null; recovery_checked_at: Date | null; assertion: ChequebookAssertion | null;
  revision: string; receipt_observation: ChequebookReceiptObservation | null; receipt_checked_at: Date | null;
};

function operationFrom(row: OperationRow): ChequebookOperation {
  return Object.freeze({
    id: row.id, requestId: row.request_id, profileName: row.profile_name, requestedBy: row.requested_by,
    direction: row.direction, amountPlur: row.amount_plur, chainId: Number(row.chain_id),
    nodeAddress: row.node_address, chequebookAddress: row.chequebook_address, tokenAddress: row.token_address,
    startBlockNumber: row.start_block_number, startBlockHash: row.start_block_hash,
    nonceLowerBound: row.nonce_lower_bound, nonceQueryTag: row.nonce_query_tag,
    state: row.state, transactionHash: row.transaction_hash, failureReason: row.failure_reason,
    dispatchStartedAt: row.dispatch_started_at?.toISOString() ?? null,
    revision: row.revision, receiptObservation: row.receipt_observation ? normalizeReceiptObservation(row.receipt_observation) : null,
    receiptCheckedAt: row.receipt_checked_at?.toISOString() ?? null,
    recoveryObservation: row.recovery_observation ? normalizeRecoveryObservation(row.recovery_observation) : null,
    recoveryCheckedAt: row.recovery_checked_at?.toISOString() ?? null, assertion: row.assertion,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresChequebookOperationRepository implements ChequebookOperationRepository {
  constructor(private readonly pool: Pool) {}

  async findByRequestId(requestId: string): Promise<ChequebookOperation | null> {
    const result = await this.pool.query<OperationRow>('SELECT * FROM chequebook_operations WHERE request_id = $1', [operationId(requestId)]);
    return result.rows[0] ? operationFrom(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ChequebookOperation | null> {
    const result = await this.pool.query<OperationRow>('SELECT * FROM chequebook_operations WHERE id = $1', [operationId(id)]);
    return result.rows[0] ? operationFrom(result.rows[0]) : null;
  }

  async admit(input: NewChequebookOperation): Promise<ChequebookAdmissionResult> {
    const candidate = { id: operationId(input.id), ...normalizeTransferIntent(input), ...normalizeTransferContext(input) };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Separate namespaces keep request and node hash collisions from inverting lock order.
      await client.query('SELECT pg_advisory_xact_lock(29001, hashtext($1))', [candidate.requestId]);
      const original = await client.query<OperationRow>('SELECT * FROM chequebook_operations WHERE request_id = $1', [candidate.requestId]);
      if (original.rows[0]) {
        const operation = operationFrom(original.rows[0]);
        await client.query('COMMIT');
        return { kind: sameTransferIntent(operation, candidate) ? 'replayed' : 'conflict', operation };
      }
      await client.query('SELECT pg_advisory_xact_lock(29002, hashtext($1))', [`${candidate.chainId}:${candidate.nodeAddress}`]);
      const open = await client.query<OperationRow>("SELECT * FROM chequebook_operations WHERE chain_id = $1 AND node_address = $2 AND state IN ('submitting', 'submitted', 'unknown')", [candidate.chainId, candidate.nodeAddress]);
      if (open.rows[0]) {
        await client.query('COMMIT');
        return { kind: 'busy', operation: operationFrom(open.rows[0]) };
      }
      const inserted = await client.query<OperationRow>(`INSERT INTO chequebook_operations
        (id, request_id, profile_name, requested_by, direction, amount_plur, chain_id, node_address,
         chequebook_address, token_address, start_block_number, start_block_hash, nonce_lower_bound, nonce_query_tag)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [candidate.id, candidate.requestId, candidate.profileName, candidate.requestedBy, candidate.direction,
        candidate.amountPlur, candidate.chainId, candidate.nodeAddress, candidate.chequebookAddress, candidate.tokenAddress,
        candidate.startBlockNumber, candidate.startBlockHash, candidate.nonceLowerBound, candidate.nonceQueryTag]);
      await client.query('COMMIT');
      return { kind: 'admitted', operation: operationFrom(inserted.rows[0]!) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDispatch(id: string): Promise<{ claimed: boolean; operation: ChequebookOperation }> {
    const updated = await this.pool.query<OperationRow>(`UPDATE chequebook_operations
      SET dispatch_started_at = NOW(), updated_at = NOW(), revision = revision + 1
      WHERE id = $1 AND state = 'submitting' AND dispatch_started_at IS NULL RETURNING *`, [operationId(id)]);
    if (updated.rows[0]) return { claimed: true, operation: operationFrom(updated.rows[0]) };
    const current = await this.findById(id);
    if (!current) throw new Error('The chequebook operation no longer exists.');
    return { claimed: false, operation: current };
  }

  async recordSubmission(id: string, outcome: SubmissionOutcome): Promise<ChequebookOperation> {
    if (outcome.state !== 'submitted') {
      const updated = await this.pool.query<OperationRow>(`UPDATE chequebook_operations
        SET state = $2, failure_reason = $3, updated_at = NOW(), revision = revision + 1
        WHERE id = $1 AND state = 'submitting' AND failure_reason IS DISTINCT FROM 'hash_conflict' RETURNING *`, [operationId(id), outcome.state, outcome.failureReason]);
      return updated.rows[0] ? operationFrom(updated.rows[0]) : this.required(id);
    }
    if (!isTransactionHash(outcome.transactionHash)) throw new ChequebookOperationInputError('response hash');
    const hash = outcome.transactionHash.toLowerCase();
    return this.withOperation(id, async (client, operation) => {
      await this.lockHash(client, operation.chainId, hash);
      const owner = await this.hashOwner(client, operation.chainId, hash);
      const owned = (!owner || owner === operation.id) && (!operation.transactionHash || operation.transactionHash === hash);
      await client.query(`INSERT INTO chequebook_submission_responses (operation_id, transaction_hash, ownership)
        VALUES ($1,$2,$3) ON CONFLICT (operation_id, transaction_hash) DO NOTHING`, [operation.id, hash, owned ? 'owned' : 'conflict']);
      if (!owned || operation.failureReason === 'hash_conflict') {
        const hashes = [...new Set([...(operation.recoveryObservation?.candidateHashes ?? []), ...(operation.transactionHash ? [operation.transactionHash] : []), hash])];
        const receiptObservation = { kind: 'could_not_check', reason: 'attribution_conflict' };
        const recoveryObservation = { ...receiptObservation, candidateHashes: hashes };
        const conflicted = await client.query<OperationRow>(`UPDATE chequebook_operations
          SET failure_reason='hash_conflict', receipt_observation=$2::jsonb, receipt_checked_at=NOW(),
              recovery_observation=$3::jsonb, recovery_checked_at=NOW(), revision=revision+1, updated_at=NOW()
          WHERE id=$1 RETURNING *`, [operation.id, JSON.stringify(receiptObservation), JSON.stringify(recoveryObservation)]);
        return operationFrom(conflicted.rows[0]!);
      }
      if (operation.state === 'rejected') return operation;
      const state = operation.state === 'asserted' || operation.state === 'settled' || operation.state === 'reverted'
        ? operation.state : owned ? 'submitted' : 'unknown';
      const updated = await client.query<OperationRow>(`UPDATE chequebook_operations
        SET state=$2, transaction_hash=$3, failure_reason=$4, revision=revision+1, updated_at=NOW()
        WHERE id=$1 RETURNING *`, [operation.id, state, owned ? hash : operation.transactionHash, owned ? null : 'hash_conflict']);
      return operationFrom(updated.rows[0]!);
    });
  }

  async listSubmissionResponses(id: string): Promise<readonly ChequebookSubmissionResponseEvidence[]> {
    const result = await this.pool.query<{ transaction_hash: string; received_at: Date; ownership: 'owned' | 'conflict' }>(
      'SELECT transaction_hash, received_at, ownership FROM chequebook_submission_responses WHERE operation_id=$1 ORDER BY received_at, transaction_hash', [operationId(id)]);
    return result.rows.map(row => Object.freeze({ transactionHash: row.transaction_hash, receivedAt: row.received_at.toISOString(), ownership: row.ownership }));
  }

  async recordRecovery(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookRecoveryObservation, candidates: readonly ChainTransaction[]): Promise<ChequebookOperation> {
    const observation = normalizeRecoveryObservation(input);
    return this.withOperation(expected.id, async (client, operation) => {
      if (operation.revision !== expected.revision || !['submitting', 'unknown'].includes(operation.state) || operation.failureReason === 'hash_conflict') return operation;
      if (observation.scan && (BigInt(observation.scan.nextBlockNumber) < BigInt(operation.startBlockNumber) ||
          (observation.scan.complete && (observation.scan.nextBlockNumber !== operation.startBlockNumber || observation.scan.nextBlockHash !== operation.startBlockHash)))) {
        throw new ChequebookOperationInputError('recovery anchor');
      }
      let recorded = observation;
      let hash: string | null = null;
      if (observation.kind === 'candidate') {
        const candidate = candidates.find(candidate => candidate.hash === observation.candidateHashes[0]);
        if (!candidate || !matchesChequebookTransfer(operation, candidate)) {
          recorded = { kind: 'could_not_check', reason: 'identity_mismatch', candidateHashes: observation.candidateHashes, ...(observation.scan ? { scan: observation.scan } : {}) };
        } else {
          await this.lockHash(client, operation.chainId, candidate.hash);
          const owner = await this.hashOwner(client, operation.chainId, candidate.hash);
          const competitors = await client.query<OperationRow>(`SELECT * FROM chequebook_operations
            WHERE chain_id=$1 AND node_address=$2 AND id<>$3 AND dispatch_started_at IS NOT NULL
              AND (transaction_hash IS NULL OR transaction_hash=$4)`, [operation.chainId, operation.nodeAddress, operation.id, candidate.hash]);
          if ((owner && owner !== operation.id) || competitors.rows.some(row => matchesChequebookTransfer(operationFrom(row), candidate))) {
            recorded = { ...observation, kind: 'ambiguous' };
          } else {
            hash = candidate.hash;
          }
        }
      }
      if (observation.kind === 'no_match' && candidates.some(candidate => matchesChequebookTransfer(operation, candidate))) throw new ChequebookOperationInputError('recovery candidates');
      const updated = await client.query<OperationRow>(`UPDATE chequebook_operations
        SET state=$2, transaction_hash=$3, recovery_observation=$4::jsonb, recovery_checked_at=NOW(), revision=revision+1, updated_at=NOW()
        WHERE id=$1 RETURNING *`, [operation.id, hash ? 'submitted' : operation.state, hash, JSON.stringify(recorded)]);
      return operationFrom(updated.rows[0]!);
    });
  }

  async resolveCandidate(expected: Pick<ChequebookOperation, 'id' | 'revision'>, candidate: ChainTransaction): Promise<ChequebookOperation> {
    return this.recordRecovery(expected, { kind: 'candidate', candidateHashes: [candidate.hash] }, [candidate]);
  }

  async assertNoSubmission(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookAssertionInput): Promise<ChequebookOperation> {
    return this.withOperation(expected.id, async (client, operation) => {
      if (input.amountPlur !== operation.amountPlur || input.confirmation !== chequebookAssertionConfirmation(operation.amountPlur) ||
          typeof input.actor !== 'string' || !input.actor.trim() || input.actor.length > 200) throw new ChequebookOperationInputError('assertion');
      if (operation.revision !== expected.revision || !['submitting', 'unknown'].includes(operation.state) || operation.failureReason === 'hash_conflict') return operation;
      if (operation.recoveryObservation?.kind !== 'no_match') throw new Error('A complete search without a matching transaction is required.');
      const assertion = { actor: input.actor, amountPlur: operation.amountPlur, confirmation: input.confirmation };
      const updated = await client.query<OperationRow>(`UPDATE chequebook_operations
        SET state='asserted', assertion=$2::jsonb || jsonb_build_object('assertedAt', NOW()), revision=revision+1, updated_at=NOW()
        WHERE id=$1 RETURNING *`, [operation.id, JSON.stringify(assertion)]);
      return operationFrom(updated.rows[0]!);
    });
  }

  private async required(id: string): Promise<ChequebookOperation> {
    const current = await this.findById(id);
    if (!current) throw new Error('The chequebook operation no longer exists.');
    return current;
  }

  private async lockHash(client: PoolClient, chainId: number, hash: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(29003, hashtext($1))', [`${chainId}:${hash}`]);
  }

  private async hashOwner(client: PoolClient, chainId: number, hash: string): Promise<string | null> {
    const result = await client.query<{ id: string }>('SELECT id FROM chequebook_operations WHERE chain_id=$1 AND transaction_hash=$2', [chainId, hash]);
    return result.rows[0]?.id ?? null;
  }

  private async withOperation(id: string, action: (client: PoolClient, operation: ChequebookOperation) => Promise<ChequebookOperation>): Promise<ChequebookOperation> {
    const identity = await this.required(operationId(id));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(29002, hashtext($1))', [`${identity.chainId}:${identity.nodeAddress}`]);
      const result = await client.query<OperationRow>('SELECT * FROM chequebook_operations WHERE id=$1 FOR UPDATE', [identity.id]);
      if (!result.rows[0]) throw new Error('The chequebook operation no longer exists.');
      const operation = await action(client, operationFrom(result.rows[0]));
      await client.query('COMMIT');
      return operation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordReceipt(expected: Pick<ChequebookOperation, 'id' | 'revision' | 'transactionHash'>, input: ChequebookReceiptObservation): Promise<ChequebookOperation> {
    const id = operationId(expected.id);
    if (!isTransactionHash(expected.transactionHash) || !/^(0|[1-9][0-9]{0,18})$/.test(expected.revision) || BigInt(expected.revision) > 9223372036854775807n) {
      throw new ChequebookOperationInputError('receipt revision');
    }
    const observation = normalizeReceiptObservation(input);
    const nextState = observation.kind === 'settled' || observation.kind === 'reverted' ? observation.kind : 'submitted';
    const updated = await this.pool.query<OperationRow>(`UPDATE chequebook_operations
      SET state = $4, receipt_observation = $5::jsonb, receipt_checked_at = NOW(), updated_at = NOW(), revision = revision + 1
      WHERE id = $1 AND revision = $2 AND transaction_hash = $3 AND state = 'submitted' AND failure_reason IS DISTINCT FROM 'hash_conflict' RETURNING *`,
    [id, expected.revision, expected.transactionHash.toLowerCase(), nextState, JSON.stringify(observation)]);
    if (updated.rows[0]) return operationFrom(updated.rows[0]);
    const current = await this.findById(id);
    if (!current) throw new Error('The chequebook operation no longer exists.');
    return current;
  }
}
