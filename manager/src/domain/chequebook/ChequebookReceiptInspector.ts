import type { ChequebookReceiptObservation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChainReadError } from '../errors/ChainReadError.js';
import type { ChainBlockHeader } from './ChainRpc.js';
import type { ChainReceipt, ChainTransaction } from './chainEvidence.js';
import { isTransactionHash, normalizeTransferContext } from './operationIdentity.js';
import { matchesChequebookTransfer, tokenAddressForChain } from './transactionIdentity.js';

export type ReceiptOperation = ChequebookTransferContext & Pick<ChequebookTransferIntent, 'direction' | 'amountPlur'> & { readonly transactionHash: string };

export interface ReceiptChainReader {
  chainId(signal?: AbortSignal): Promise<number>;
  transaction(hash: string, signal?: AbortSignal): Promise<ChainTransaction | null>;
  receipt(hash: string, signal?: AbortSignal): Promise<ChainReceipt | null>;
  blockHeader(block: bigint | 'finalized', signal?: AbortSignal): Promise<ChainBlockHeader | null>;
}

type CreateReceiptReader = (operation: ReceiptOperation, signal: AbortSignal) => Promise<ReceiptChainReader>;
const unavailable = Object.freeze({ kind: 'could_not_check', reason: 'rpc_unavailable' } as const);
const mismatch = Object.freeze({ kind: 'could_not_check', reason: 'identity_mismatch' } as const);
const changed = Object.freeze({ kind: 'could_not_check', reason: 'chain_changed' } as const);

/** A receipt releases protection only after its exact transaction and canonical finalized block agree. */
export class ChequebookReceiptInspector {
  private readonly timeoutMs: number;

  constructor(private readonly createReader: CreateReceiptReader, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new ChainReadError();
  }

  async inspect(input: ReceiptOperation): Promise<ChequebookReceiptObservation> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = Object.freeze({ ...input, ...normalizeTransferContext(input) });
      if (!isTransactionHash(operation.transactionHash) || !tokenAddressForChain(operation.chainId)) return mismatch;
      const deadline = new Promise<ChequebookReceiptObservation>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(unavailable); }, this.timeoutMs);
      });
      return await Promise.race([this.observe(operation, controller.signal), deadline]);
    } catch {
      return unavailable;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async observe(operation: ReceiptOperation, signal: AbortSignal): Promise<ChequebookReceiptObservation> {
    const reader = await this.createReader(operation, signal);
    signal.throwIfAborted();
    if (await reader.chainId(signal) !== operation.chainId) return mismatch;
    const start = BigInt(operation.startBlockNumber);
    const anchor = await reader.blockHeader(start, signal);
    if (!anchor) return unavailable;
    if (anchor.number !== operation.startBlockNumber || anchor.hash !== operation.startBlockHash) return changed;
    const transaction = await reader.transaction(operation.transactionHash, signal);
    const receipt = await reader.receipt(operation.transactionHash, signal);
    if (!transaction) return receipt ? mismatch : { kind: 'pending', reason: 'awaiting_transaction' };
    if (transaction.hash !== operation.transactionHash || !matchesChequebookTransfer(operation, transaction)) return mismatch;
    if (!receipt) return { kind: 'pending', reason: 'awaiting_receipt' };
    if (receipt.transactionHash !== transaction.hash || receipt.from !== transaction.from || receipt.to !== transaction.to ||
        receipt.blockNumber !== transaction.blockNumber || receipt.blockHash !== transaction.blockHash) return mismatch;
    const finalized = await reader.blockHeader('finalized', signal);
    if (!finalized) return unavailable;
    const canonicalReceipt = await reader.blockHeader(BigInt(receipt.blockNumber), signal);
    if (!canonicalReceipt) return unavailable;
    if (canonicalReceipt.number !== receipt.blockNumber || canonicalReceipt.hash !== receipt.blockHash) return changed;
    const canonicalFinalized = await reader.blockHeader(BigInt(finalized.number), signal);
    if (!canonicalFinalized) return unavailable;
    if (canonicalFinalized.number !== finalized.number || canonicalFinalized.hash !== finalized.hash) return changed;
    const finalAnchor = await reader.blockHeader(start, signal);
    if (!finalAnchor) return unavailable;
    if (finalAnchor.number !== operation.startBlockNumber || finalAnchor.hash !== operation.startBlockHash) return changed;
    signal.throwIfAborted();
    if (BigInt(finalized.number) < BigInt(receipt.blockNumber)) return { kind: 'pending', reason: 'awaiting_finality' };
    if (finalized.number === receipt.blockNumber && finalized.hash !== receipt.blockHash) return changed;
    return Object.freeze({
      kind: receipt.status === 'success' ? 'settled' : 'reverted',
      receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash,
      finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash,
    });
  }
}
