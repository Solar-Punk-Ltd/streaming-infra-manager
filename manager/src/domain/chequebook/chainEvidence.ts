import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';

export interface ChainTransaction {
  readonly hash: string;
  readonly chainId: number;
  readonly from: string;
  readonly to: string | null;
  readonly data: string;
  readonly nonce: string;
  readonly value: string;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
}

export interface ChainReceipt {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly from: string;
  readonly to: string | null;
  readonly status: 'success' | 'reverted';
}

export function chainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChainEvidenceError();
  return value as Record<string, unknown>;
}

export function chainQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new ChainEvidenceError();
  return BigInt(value);
}

function hexData(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ChainEvidenceError();
  return value.toLowerCase();
}

export function chainHash(value: unknown): string {
  return hexData(value, /^0x[0-9a-f]{64}$/i);
}

export function chainAddress(value: unknown): string {
  return hexData(value, /^0x[0-9a-f]{40}$/i);
}

export function chainIdFromQuantity(value: unknown): number {
  const parsed = chainQuantity(value);
  if (parsed < 1n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainEvidenceError();
  return Number(parsed);
}

function transactionChainId(transaction: Record<string, unknown>): number {
  const type = transaction.type === undefined ? 0n : chainQuantity(transaction.type);
  if (type > 4n) throw new ChainEvidenceError();
  if (type !== 0n) return chainIdFromQuantity(transaction.chainId);
  const v = chainQuantity(transaction.v);
  if (v < 35n) throw new ChainEvidenceError();
  const derived = (v - 35n) / 2n;
  const chainId = chainIdFromQuantity(`0x${derived.toString(16)}`);
  if (transaction.chainId !== undefined && chainIdFromQuantity(transaction.chainId) !== chainId) throw new ChainEvidenceError();
  return chainId;
}

export function parseChainTransaction(value: unknown): ChainTransaction {
  const transaction = chainObject(value);
  const pending = transaction.blockNumber === null && transaction.blockHash === null;
  return Object.freeze({
    hash: chainHash(transaction.hash),
    chainId: transactionChainId(transaction),
    from: chainAddress(transaction.from),
    to: transaction.to === null ? null : chainAddress(transaction.to),
    data: hexData(transaction.input, /^0x(?:[0-9a-f]{2})*$/i),
    nonce: chainQuantity(transaction.nonce).toString(),
    value: chainQuantity(transaction.value).toString(),
    blockNumber: pending ? null : chainQuantity(transaction.blockNumber).toString(),
    blockHash: pending ? null : chainHash(transaction.blockHash),
  });
}

export function parseChainReceipt(value: unknown): ChainReceipt | null {
  if (value === null) return null;
  const receipt = chainObject(value);
  const status = chainQuantity(receipt.status);
  if (status !== 0n && status !== 1n) throw new ChainEvidenceError();
  return Object.freeze({
    transactionHash: chainHash(receipt.transactionHash),
    blockHash: chainHash(receipt.blockHash),
    blockNumber: chainQuantity(receipt.blockNumber).toString(),
    from: chainAddress(receipt.from),
    to: receipt.to === null ? null : chainAddress(receipt.to),
    status: status === 1n ? 'success' : 'reverted',
  });
}
