import type { ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';
import { isTransactionHash } from './operationIdentity.js';

function blockNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) {
    throw new ChequebookOperationInputError('receipt block');
  }
  return value;
}

function blockHash(value: unknown): string {
  if (!isTransactionHash(value)) throw new ChequebookOperationInputError('receipt block hash');
  return value.toLowerCase();
}

/** Only evidence fields, never endpoint diagnostics, enter the durable journal. */
export function normalizeReceiptObservation(observation: ChequebookReceiptObservation): ChequebookReceiptObservation {
  if (observation.kind === 'pending' && ['awaiting_transaction', 'awaiting_receipt', 'awaiting_finality'].includes(observation.reason)) {
    return Object.freeze({ kind: observation.kind, reason: observation.reason });
  }
  if (observation.kind === 'could_not_check' && ['rpc_unavailable', 'identity_mismatch', 'chain_changed', 'history_incomplete'].includes(observation.reason)) {
    return Object.freeze({ kind: observation.kind, reason: observation.reason });
  }
  if (observation.kind !== 'settled' && observation.kind !== 'reverted') throw new ChequebookOperationInputError('receipt observation');
  const result = {
    kind: observation.kind, receiptBlockNumber: blockNumber(observation.receiptBlockNumber), receiptBlockHash: blockHash(observation.receiptBlockHash),
    finalizedBlockNumber: blockNumber(observation.finalizedBlockNumber), finalizedBlockHash: blockHash(observation.finalizedBlockHash),
  };
  if (BigInt(result.finalizedBlockNumber) < BigInt(result.receiptBlockNumber) ||
      (result.finalizedBlockNumber === result.receiptBlockNumber && result.finalizedBlockHash !== result.receiptBlockHash)) {
    throw new ChequebookOperationInputError('receipt finality');
  }
  return Object.freeze(result);
}
