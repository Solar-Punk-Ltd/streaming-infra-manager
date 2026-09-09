import type { ChequebookReceiptHistory, ChequebookReceiptObservation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';
import { ChainReadError } from '../errors/ChainReadError.js';
import type { ChainBlockHeader } from './ChainRpc.js';
import type { ChainReceipt, ChainTransaction } from './chainEvidence.js';
import { isTransactionHash, normalizeTransferContext } from './operationIdentity.js';
import { matchesChequebookTransfer, tokenAddressForChain } from './transactionIdentity.js';
import { normalizeReceiptHistory } from './receiptObservation.js';
import { verifyReceiptHistory } from './verifyReceiptHistory.js';

export type ReceiptOperation = ChequebookTransferContext & Pick<ChequebookTransferIntent, 'direction' | 'amountPlur'> & {
  readonly transactionHash: string;
  readonly receiptObservation?: ChequebookReceiptObservation | null;
};

export interface ReceiptChainReader {
  chainId(signal?: AbortSignal): Promise<number>;
  transaction(hash: string, signal?: AbortSignal): Promise<ChainTransaction | null>;
  receipt(hash: string, signal?: AbortSignal): Promise<ChainReceipt | null>;
  blockHeader(block: bigint | 'finalized', signal?: AbortSignal): Promise<ChainBlockHeader | null>;
}

type CreateReceiptReader = (operation: ReceiptOperation, signal: AbortSignal) => Promise<ReceiptChainReader>;
const mismatch = Object.freeze({ kind: 'could_not_check', reason: 'identity_mismatch' } as const);
const changed = Object.freeze({ kind: 'could_not_check', reason: 'chain_changed' } as const);
type IncompleteReason = 'rpc_unavailable' | 'history_incomplete';
type IncompleteObservation = (reason?: IncompleteReason) => ChequebookReceiptObservation;

/** A receipt releases protection only after its exact transaction and canonical finalized block agree. */
export class ChequebookReceiptInspector {
  private readonly timeoutMs: number;
  private readonly maxAncestryBlocks: number;

  constructor(private readonly createReader: CreateReceiptReader, options: { timeoutMs?: number; maxAncestryBlocks?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAncestryBlocks = options.maxAncestryBlocks ?? 512;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new ChainReadError();
    if (!Number.isInteger(this.maxAncestryBlocks) || this.maxAncestryBlocks < 1 || this.maxAncestryBlocks > 2048) throw new ChainReadError();
  }

  async inspect(input: ReceiptOperation): Promise<ChequebookReceiptObservation> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let progress: ChequebookReceiptHistory | undefined;
    const incomplete: IncompleteObservation = (reason = 'rpc_unavailable') => Object.freeze({ kind: 'could_not_check', reason, ...(progress ? { history: progress } : {}) });
    try {
      const operation = Object.freeze({ ...input, ...normalizeTransferContext(input) });
      if (!isTransactionHash(operation.transactionHash) || !tokenAddressForChain(operation.chainId)) return mismatch;
      const saved = operation.receiptObservation?.kind === 'could_not_check' ? operation.receiptObservation.history : undefined;
      if (saved) {
        progress = normalizeReceiptHistory(saved);
        if (progress.transactionHash !== operation.transactionHash || BigInt(progress.cursorBlockNumber) < BigInt(operation.startBlockNumber)) return changed;
      }
      const deadline = new Promise<ChequebookReceiptObservation>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(incomplete()); }, this.timeoutMs);
      });
      return await Promise.race([this.observe(operation, controller.signal, progress, history => { progress = history; }, incomplete), deadline]);
    } catch {
      return incomplete();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async observe(operation: ReceiptOperation, signal: AbortSignal, saved: ChequebookReceiptHistory | undefined,
    onProgress: (history: ChequebookReceiptHistory) => void, incomplete: IncompleteObservation): Promise<ChequebookReceiptObservation> {
    const reader = await this.createReader(operation, signal);
    signal.throwIfAborted();
    if (await reader.chainId(signal) !== operation.chainId) return mismatch;
    const start = BigInt(operation.startBlockNumber);
    const anchor = await reader.blockHeader(start, signal);
    if (!anchor) return incomplete();
    if (anchor.number !== operation.startBlockNumber || anchor.hash !== operation.startBlockHash) return changed;
    const transaction = await reader.transaction(operation.transactionHash, signal);
    const receipt = await reader.receipt(operation.transactionHash, signal);
    if (!transaction) return saved ? incomplete() : receipt ? mismatch : { kind: 'pending', reason: 'awaiting_transaction' };
    if (transaction.hash !== operation.transactionHash || !matchesChequebookTransfer(operation, transaction)) return mismatch;
    if (!receipt) return saved ? incomplete() : { kind: 'pending', reason: 'awaiting_receipt' };
    if (receipt.transactionHash !== transaction.hash || receipt.from !== transaction.from || receipt.to !== transaction.to ||
        receipt.blockNumber !== transaction.blockNumber || receipt.blockHash !== transaction.blockHash) return mismatch;
    if (saved && (saved.receiptBlockNumber !== receipt.blockNumber || saved.receiptBlockHash !== receipt.blockHash || saved.receiptStatus !== receipt.status)) return changed;
    const finalized = await reader.blockHeader(saved ? BigInt(saved.finalizedBlockNumber) : 'finalized', signal);
    if (!finalized) return incomplete();
    if (saved && (finalized.number !== saved.finalizedBlockNumber || finalized.hash !== saved.finalizedBlockHash)) return changed;
    const canonicalReceipt = await reader.blockHeader(BigInt(receipt.blockNumber), signal);
    if (!canonicalReceipt) return incomplete();
    if (canonicalReceipt.number !== receipt.blockNumber || canonicalReceipt.hash !== receipt.blockHash) return changed;
    const canonicalFinalized = await reader.blockHeader(BigInt(finalized.number), signal);
    if (!canonicalFinalized) return incomplete();
    if (canonicalFinalized.number !== finalized.number || canonicalFinalized.hash !== finalized.hash) return changed;
    if (BigInt(finalized.number) < BigInt(receipt.blockNumber)) return { kind: 'pending', reason: 'awaiting_finality' };
    const cursor = saved ? await reader.blockHeader(BigInt(saved.cursorBlockNumber), signal) : canonicalFinalized;
    if (!cursor) return incomplete();
    if (saved && (cursor.number !== saved.cursorBlockNumber || cursor.hash !== saved.cursorBlockHash)) return changed;
    const verified = await verifyReceiptHistory({ reader, operation, receipt, finalized, cursor, maxBlocks: this.maxAncestryBlocks, signal, onProgress });
    if (verified === 'chain_changed') return changed;
    if (verified !== 'complete') return incomplete(verified);
    return Object.freeze({
      kind: receipt.status === 'success' ? 'settled' : 'reverted',
      receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash,
      finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash,
    });
  }
}
