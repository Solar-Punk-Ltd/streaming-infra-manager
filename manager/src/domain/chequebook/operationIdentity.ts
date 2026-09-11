import type { ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChequebookOperationInputError } from '../errors/ChequebookOperationInputError.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const NONCE_TAG = /^(latest|pending|safe|finalized|0x(?:0|[1-9a-f][0-9a-f]*))$/;
const UINT256_MAX = (1n << 256n) - 1n;

function text(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || (pattern && !pattern.test(value))) {
    throw new ChequebookOperationInputError(field);
  }
  return value;
}

function unsignedInteger(value: unknown, field: string): string {
  const result = text(value, field, /^(0|[1-9][0-9]{0,77})$/);
  if (BigInt(result) > UINT256_MAX) throw new ChequebookOperationInputError(field);
  return result;
}

export function operationId(value: unknown): string {
  return text(value, 'id', UUID).toLowerCase();
}

export function normalizeTransferIntent(intent: ChequebookTransferIntent): ChequebookTransferIntent {
  if (intent.direction !== 'deposit' && intent.direction !== 'withdraw') throw new ChequebookOperationInputError('direction');
  return Object.freeze({
    requestId: text(intent.requestId, 'request id', UUID).toLowerCase(),
    profileName: text(intent.profileName, 'deployment'),
    profileInstanceId: text(intent.profileInstanceId, 'profile generation', UUID).toLowerCase(),
    requestedBy: text(intent.requestedBy, 'operator'),
    direction: intent.direction,
    amountPlur: text(intent.amountPlur, 'amount', /^[1-9][0-9]{0,29}$/),
  });
}

export function normalizeTransferContext(context: ChequebookTransferContext): ChequebookTransferContext {
  if (!Number.isSafeInteger(context.chainId) || context.chainId < 1) throw new ChequebookOperationInputError('chain id');
  return Object.freeze({
    chainId: context.chainId,
    nodeAddress: text(context.nodeAddress, 'node address', ADDRESS).toLowerCase(),
    chequebookAddress: text(context.chequebookAddress, 'chequebook address', ADDRESS).toLowerCase(),
    tokenAddress: text(context.tokenAddress, 'token address', ADDRESS).toLowerCase(),
    startBlockNumber: unsignedInteger(context.startBlockNumber, 'start block'),
    startBlockHash: text(context.startBlockHash, 'start block hash', HASH).toLowerCase(),
    nonceLowerBound: unsignedInteger(context.nonceLowerBound, 'nonce bound'),
    nonceQueryTag: text(context.nonceQueryTag, 'nonce query tag', NONCE_TAG),
  });
}

type SavedIntentIdentity = Omit<ChequebookTransferIntent, 'profileInstanceId'> & { readonly profileInstanceId: string | null };

export function sameTransferIntent(a: SavedIntentIdentity, b: SavedIntentIdentity): boolean {
  return a.requestId === b.requestId && a.profileName === b.profileName && a.profileInstanceId === b.profileInstanceId && a.requestedBy === b.requestedBy && a.direction === b.direction && a.amountPlur === b.amountPlur;
}

export function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}
