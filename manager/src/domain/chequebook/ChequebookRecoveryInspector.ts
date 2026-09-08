import type { ChequebookOperation, ChequebookRecoveryObservation, ChequebookRecoveryScan } from '@streaming-infra-manager/common';
import { ChainReadError } from '../errors/ChainReadError.js';
import type { ChainBlock, ChainBlockHeader } from './ChainRpc.js';
import type { ChainTransaction } from './chainEvidence.js';
import { normalizeTransferContext } from './operationIdentity.js';
import { MAX_RECOVERY_CANDIDATES, normalizeRecoveryObservation, normalizeRecoveryScan, recoveryHashes } from './recoveryObservation.js';
import { matchesChequebookTransfer, tokenAddressForChain } from './transactionIdentity.js';

export interface RecoveryChainReader {
  chainId(signal?: AbortSignal): Promise<number>;
  transaction(hash: string, signal?: AbortSignal): Promise<ChainTransaction | null>;
  blockHeader(block: bigint | 'latest', signal?: AbortSignal): Promise<ChainBlockHeader | null>;
  /** The adapter verifies complete transaction indices, hashes and the block-hash-bound count. */
  blockTransactions(block: bigint, nodeAddress: string, signal?: AbortSignal): Promise<ChainBlock | null>;
}

export interface ChequebookRecoveryInspection {
  readonly observation: ChequebookRecoveryObservation;
  readonly candidates: readonly ChainTransaction[];
}

type CreateReader = (operation: ChequebookOperation, signal: AbortSignal) => Promise<RecoveryChainReader>;
type ReadPendingHashes = (operation: ChequebookOperation, signal: AbortSignal) => Promise<readonly string[]>;
type FailureReason = Extract<ChequebookRecoveryObservation, { kind: 'could_not_check' }>['reason'];

/** Read-only recovery. A finished pass is a dated observation, never proof of permanent absence. */
export class ChequebookRecoveryInspector {
  private readonly timeoutMs: number;
  private readonly maxBlocks: number;

  constructor(private readonly createReader: CreateReader, private readonly pendingHashes: ReadPendingHashes,
    options: { timeoutMs?: number; maxBlocks?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBlocks = options.maxBlocks ?? 64;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000 ||
        !Number.isInteger(this.maxBlocks) || this.maxBlocks < 1 || this.maxBlocks > 2048) throw new ChainReadError();
  }

  async inspect(input: ChequebookOperation, options: { forceScan?: boolean } = {}): Promise<ChequebookRecoveryInspection> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scan: ChequebookRecoveryScan | undefined;
    const hashes = new Set<string>();
    const candidates = new Map<string, ChainTransaction>();
    const evidence = () => ({ candidateHashes: [...hashes], ...(scan ? { scan: { ...scan, candidateHashes: [...hashes] } } : {}) });
    const result = (observation: ChequebookRecoveryObservation): ChequebookRecoveryInspection => Object.freeze({
      observation: normalizeRecoveryObservation(observation), candidates: Object.freeze([...candidates.values()]),
    });
    const failed = (reason: FailureReason = 'rpc_unavailable') => result({ kind: 'could_not_check', reason, ...evidence() });
    const changed = () => { scan = undefined; return failed('chain_changed'); };
    const checked = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await promise;
      controller.signal.throwIfAborted();
      return value;
    };
    try {
      const operation = Object.freeze({ ...input, ...normalizeTransferContext(input) });
      const previous = operation.recoveryObservation ? normalizeRecoveryObservation(operation.recoveryObservation) : null;
      for (const hash of previous?.candidateHashes ?? []) hashes.add(hash);
      if (previous?.scan && !previous.scan.complete) scan = normalizeRecoveryScan(previous.scan);
      if (!tokenAddressForChain(operation.chainId) || tokenAddressForChain(operation.chainId) !== operation.tokenAddress) return failed('identity_mismatch');
      const deadline = new Promise<ChequebookRecoveryInspection>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(failed()); }, this.timeoutMs);
      });
      const observe = async (): Promise<ChequebookRecoveryInspection> => {
        const signal = controller.signal;
        const reader = await checked(this.createReader(operation, signal));
        if (await checked(reader.chainId(signal)) !== operation.chainId) return failed('identity_mismatch');
        const start = BigInt(operation.startBlockNumber);
        const anchor = await checked(reader.blockHeader(start, signal));
        if (!anchor) return failed();
        if (anchor.number !== operation.startBlockNumber || anchor.hash !== operation.startBlockHash) return changed();

        let pendingComplete = true;
        let observedHashes: readonly string[] = [];
        try {
          observedHashes = recoveryHashes(await checked(this.pendingHashes(operation, signal)));
        } catch {
          signal.throwIfAborted();
          pendingComplete = false;
        }
        let missingEvidence = false;
        for (const hash of new Set([...hashes, ...observedHashes])) {
          const transaction = await checked(reader.transaction(hash, signal));
          if (!transaction) {
            if (hashes.has(hash)) missingEvidence = true;
            pendingComplete = false;
            continue;
          }
          if (transaction.hash !== hash) return failed('identity_mismatch');
          if (matchesChequebookTransfer(operation, transaction)) {
            if (!hashes.has(hash) && hashes.size >= MAX_RECOVERY_CANDIDATES) return failed('evidence_limit');
            hashes.add(hash);
            candidates.set(hash, transaction);
          } else if (hashes.has(hash)) {
            return failed('identity_mismatch');
          }
        }
        if (!options.forceScan && !missingEvidence && pendingComplete && hashes.size === 1) return result({ kind: 'candidate', ...evidence() });

        const head = await checked(reader.blockHeader(scan ? BigInt(scan.headBlockNumber) : 'latest', signal));
        if (!head) return failed();
        if (BigInt(head.number) < start || (scan && (head.number !== scan.headBlockNumber || head.hash !== scan.headBlockHash))) return changed();
        if (!scan) scan = { headBlockNumber: head.number, headBlockHash: head.hash, nextBlockNumber: head.number, nextBlockHash: head.hash, complete: false, candidateHashes: [...hashes] };
        const cursor = await checked(reader.blockHeader(BigInt(scan.nextBlockNumber), signal));
        if (!cursor) return failed();
        if (cursor.number !== scan.nextBlockNumber || cursor.hash !== scan.nextBlockHash || BigInt(cursor.number) < start) return changed();
        for (let count = 0; count < this.maxBlocks; count++) {
          const block: ChainBlock | null = await checked(reader.blockTransactions(BigInt(scan.nextBlockNumber), operation.nodeAddress, signal));
          if (!block) return failed();
          if (block.number !== scan.nextBlockNumber || block.hash !== scan.nextBlockHash) return changed();
          if (BigInt(block.number) === start && block.hash !== operation.startBlockHash) return changed();
          for (const transaction of block.transactions) {
            if (!matchesChequebookTransfer(operation, transaction)) continue;
            if (!hashes.has(transaction.hash) && hashes.size >= MAX_RECOVERY_CANDIDATES) return failed('evidence_limit');
            hashes.add(transaction.hash);
            candidates.set(transaction.hash, transaction);
          }
          if (BigInt(block.number) === start) {
            scan = { ...scan, complete: true, candidateHashes: [...hashes] };
            break;
          }
          scan = { ...scan, nextBlockNumber: String(BigInt(block.number) - 1n), nextBlockHash: block.parentHash, candidateHashes: [...hashes] };
        }
        const currentHead = await checked(reader.blockHeader(BigInt(scan.headBlockNumber), signal));
        const currentAnchor = await checked(reader.blockHeader(start, signal));
        if (!currentHead || !currentAnchor) return failed();
        if (currentHead.number !== scan.headBlockNumber || currentHead.hash !== scan.headBlockHash ||
            currentAnchor.number !== operation.startBlockNumber || currentAnchor.hash !== operation.startBlockHash) return changed();
        if (missingEvidence) return failed();
        if (hashes.size > 1) return result({ kind: 'ambiguous', ...evidence() });
        if (hashes.size === 1) return result({ kind: 'candidate', ...evidence() });
        if (!pendingComplete) return failed();
        return result(scan.complete ? { kind: 'no_match', ...evidence(), scan } : { kind: 'searching', ...evidence(), scan });
      };
      return await Promise.race([observe(), deadline]);
    } catch {
      return failed();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
