import type { Pool } from 'pg';
import type { ChequebookAdmissionResult, ChequebookOperation } from '@streaming-infra-manager/common';
import type { ChequebookOperationRepository, NewChequebookOperation, SubmissionOutcome } from './ChequebookOperationRepository.js';
import { normalizeTransferContext, normalizeTransferIntent, operationId, sameTransferIntent } from './operationIdentity.js';

type OperationRow = {
  id: string; request_id: string; profile_name: string; requested_by: string;
  direction: ChequebookOperation['direction']; amount_plur: string; chain_id: string;
  node_address: string; chequebook_address: string; token_address: string;
  start_block_number: string; start_block_hash: string; nonce_lower_bound: string; nonce_query_tag: string;
  state: ChequebookOperation['state']; transaction_hash: string | null;
  failure_reason: ChequebookOperation['failureReason']; dispatch_started_at: Date | null; created_at: Date; updated_at: Date;
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
      SET dispatch_started_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND state = 'submitting' AND dispatch_started_at IS NULL RETURNING *`, [operationId(id)]);
    if (updated.rows[0]) return { claimed: true, operation: operationFrom(updated.rows[0]) };
    const current = await this.findById(id);
    if (!current) throw new Error('The chequebook operation no longer exists.');
    return { claimed: false, operation: current };
  }

  async recordSubmission(id: string, outcome: SubmissionOutcome): Promise<ChequebookOperation> {
    const updated = await this.pool.query<OperationRow>(`UPDATE chequebook_operations
      SET state = $2, transaction_hash = $3, failure_reason = $4, updated_at = NOW()
      WHERE id = $1 AND state = 'submitting' RETURNING *`, [operationId(id), outcome.state, outcome.transactionHash, outcome.failureReason]);
    if (updated.rows[0]) return operationFrom(updated.rows[0]);
    const current = await this.findById(id);
    if (!current) throw new Error('The chequebook operation no longer exists.');
    return current;
  }
}
