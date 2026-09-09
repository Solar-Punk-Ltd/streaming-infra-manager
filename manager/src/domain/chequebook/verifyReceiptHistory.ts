import type { ChequebookReceiptHistory } from '@streaming-infra-manager/common';
import type { ChainBlockHeader } from './ChainRpc.js';
import type { ChainReceipt } from './chainEvidence.js';
import type { ReceiptChainReader, ReceiptOperation } from './ChequebookReceiptInspector.js';

interface HistoryWalk {
  readonly reader: ReceiptChainReader;
  readonly operation: ReceiptOperation;
  readonly receipt: ChainReceipt;
  readonly finalized: ChainBlockHeader;
  readonly cursor: ChainBlockHeader;
  readonly maxBlocks: number;
  readonly signal: AbortSignal;
  readonly onProgress: (history: ChequebookReceiptHistory) => void;
}

export async function verifyReceiptHistory(walk: HistoryWalk): Promise<'complete' | 'chain_changed' | 'rpc_unavailable' | 'history_incomplete'> {
  const { reader, operation, receipt, finalized, maxBlocks, signal, onProgress } = walk;
  let current = walk.cursor;
  let readBlocks = 0;
  for (;;) {
    signal.throwIfAborted();
    if (current.number === receipt.blockNumber && current.hash !== receipt.blockHash) return 'chain_changed';
    if (current.number === operation.startBlockNumber) return current.hash === operation.startBlockHash ? 'complete' : 'chain_changed';
    if (BigInt(current.number) < BigInt(operation.startBlockNumber)) return 'chain_changed';
    onProgress(Object.freeze({
      transactionHash: operation.transactionHash, receiptBlockNumber: receipt.blockNumber, receiptBlockHash: receipt.blockHash, receiptStatus: receipt.status,
      finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash, cursorBlockNumber: current.number, cursorBlockHash: current.hash,
    }));
    if (readBlocks++ >= maxBlocks) return 'history_incomplete';
    const parentNumber = BigInt(current.number) - 1n;
    const parent = await reader.blockHeader(parentNumber, signal);
    signal.throwIfAborted();
    if (!parent) return 'rpc_unavailable';
    if (parent.number !== parentNumber.toString() || parent.hash !== current.parentHash) return 'chain_changed';
    current = parent;
  }
}
