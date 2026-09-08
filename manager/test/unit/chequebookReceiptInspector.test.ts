import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookReceiptInspector, type ReceiptChainReader, type ReceiptOperation } from '../../src/domain/chequebook/ChequebookReceiptInspector.js';
import type { ChainTransaction, ChainReceipt } from '../../src/domain/chequebook/chainEvidence.js';
import { operationCandidate, transactionHash } from '../support/chequebookOperations.js';
import { InMemoryChequebookOperations } from '../support/chequebookOperations.js';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';

const minedHash = `0x${'77'.repeat(32)}`;
const finalizedHash = `0x${'88'.repeat(32)}`;
const otherHash = `0x${'99'.repeat(32)}`;
const candidate = operationCandidate({ tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' });
const operation: ReceiptOperation = { ...candidate, transactionHash };
const transaction: ChainTransaction = {
  hash: transactionHash, chainId: 100, from: operation.nodeAddress, to: operation.tokenAddress,
  data: `0xa9059cbb${operation.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(operation.amountPlur).toString(16).padStart(64, '0')}`,
  nonce: '9', value: '0', blockNumber: '501', blockHash: minedHash,
};
const receipt: ChainReceipt = {
  transactionHash, from: transaction.from, to: transaction.to, blockNumber: '501', blockHash: minedHash, status: 'success',
};

function hashAt(number: bigint): string {
  return number === 500n ? operation.startBlockHash : number === 501n ? minedHash : number === 510n ? finalizedHash : `0x${number.toString(16).padStart(64, '0')}`;
}

function reader(overrides: Partial<ReceiptChainReader> = {}): ReceiptChainReader {
  return {
    chainId: async () => 100,
    transaction: async () => transaction,
    receipt: async () => receipt,
    blockHeader: async block => {
      const number = block === 'finalized' ? '510' : String(block);
      return { number, hash: hashAt(BigInt(number)), parentHash: hashAt(BigInt(number) - 1n) };
    },
    ...overrides,
  };
}

const inspect = (overrides: Partial<ReceiptChainReader> = {}, input = operation) =>
  new ChequebookReceiptInspector(async () => reader(overrides)).inspect(input);

describe('chequebook receipt confirmation', () => {
  it('confirms success and revert only with matching finalized receipt evidence', async () => {
    for (const status of ['success', 'reverted'] as const) {
      assert.deepEqual(await inspect({ receipt: async () => ({ ...receipt, status }) }), {
        kind: status === 'success' ? 'settled' : 'reverted',
        receiptBlockNumber: '501', receiptBlockHash: minedHash,
        finalizedBlockNumber: '510', finalizedBlockHash: finalizedHash,
      });
    }
  });

  it('keeps absent transactions and absent receipts pending without treating absence as failure', async () => {
    assert.deepEqual(await inspect({ transaction: async () => null, receipt: async () => null }), { kind: 'pending', reason: 'awaiting_transaction' });
    assert.deepEqual(await inspect({ receipt: async () => null }), { kind: 'pending', reason: 'awaiting_receipt' });
    assert.deepEqual(await inspect({ transaction: async () => ({ ...transaction, blockNumber: null, blockHash: null }), receipt: async () => null }), { kind: 'pending', reason: 'awaiting_receipt' });
  });

  it('keeps a mined transfer pending until finality reaches its canonical block', async () => {
    let finalized = '500';
    const rpc = reader();
    const inspector = new ChequebookReceiptInspector(async () => reader({
      blockHeader: async (block, signal) => rpc.blockHeader(block === 'finalized' ? BigInt(finalized) : block, signal),
    }));
    assert.deepEqual(await inspector.inspect(operation), { kind: 'pending', reason: 'awaiting_finality' });
    finalized = '501';
    assert.equal((await inspector.inspect(operation)).kind, 'settled');
  });

  it('refuses unavailable finality rather than substituting the latest block', async () => {
    const rpc = reader();
    const requested: Array<bigint | 'finalized'> = [];
    assert.deepEqual(await inspect({ blockHeader: async (block, signal) => {
      requested.push(block);
      return block === 'finalized' ? null : rpc.blockHeader(block, signal);
    } }), { kind: 'could_not_check', reason: 'rpc_unavailable' });
    assert.ok(requested.includes('finalized'));
  });

  it('refuses wrong chain or any transaction identity mismatch', async () => {
    assert.deepEqual(await inspect({ chainId: async () => 1 }), { kind: 'could_not_check', reason: 'identity_mismatch' });
    for (const change of [
      { hash: otherHash }, { chainId: 1 }, { from: operation.chequebookAddress }, { to: operation.chequebookAddress },
      { data: `${transaction.data.slice(0, -1)}1` }, { value: '1' }, { nonce: '7' },
    ]) {
      assert.deepEqual(await inspect({ transaction: async () => ({ ...transaction, ...change }) }), { kind: 'could_not_check', reason: 'identity_mismatch' });
    }
    assert.equal((await inspect({}, { ...operation, chainId: 9999 })).kind, 'could_not_check');
  });

  it('refuses a receipt detached from its exact transaction and block', async () => {
    for (const change of [
      { transactionHash: otherHash }, { from: operation.chequebookAddress }, { to: operation.chequebookAddress },
      { blockNumber: '502' }, { blockHash: otherHash },
    ]) {
      assert.deepEqual(await inspect({ receipt: async () => ({ ...receipt, ...change }) }), { kind: 'could_not_check', reason: 'identity_mismatch' });
    }
    assert.equal((await inspect({ transaction: async () => null })).kind, 'could_not_check');
    assert.equal((await inspect({ transaction: async () => ({ ...transaction, blockNumber: null, blockHash: null }) })).kind, 'could_not_check');
  });

  it('refuses a reorganized start block, receipt block or finalized tag', async () => {
    for (const changed of [500n, 501n, 510n]) {
      const rpc = reader();
      assert.deepEqual(await inspect({ blockHeader: async (block, signal) => {
        const header = await rpc.blockHeader(block, signal);
        return block === changed && header ? { ...header, hash: otherHash } : header;
      } }), { kind: 'could_not_check', reason: 'chain_changed' });
    }
  });

  it('rechecks the frozen anchor after reading receipt and finality evidence', async () => {
    let anchorReads = 0;
    const rpc = reader();
    assert.deepEqual(await inspect({ blockHeader: async (block, signal) => {
      const header = await rpc.blockHeader(block, signal);
      if (block === 500n && ++anchorReads > 1 && header) return { ...header, hash: otherHash };
      return header;
    } }), { kind: 'could_not_check', reason: 'chain_changed' });
    assert.equal(anchorReads, 2);
  });

  it('refuses finalized evidence from a different receipt history even when the saved anchor agrees', async () => {
    const rpc = reader();
    assert.deepEqual(await inspect({ blockHeader: async (block, signal) => {
      if (block === 'finalized' || block === 502n) return { number: '502', hash: hashAt(502n), parentHash: otherHash };
      return rpc.blockHeader(block, signal);
    } }), { kind: 'could_not_check', reason: 'chain_changed' });
  });

  it('refuses a finalized receipt that does not descend from the saved starting block', async () => {
    const rpc = reader();
    assert.deepEqual(await inspect({ blockHeader: async (block, signal) => {
      const header = await rpc.blockHeader(block, signal);
      return block === 501n && header ? { ...header, parentHash: otherHash } : header;
    } }), { kind: 'could_not_check', reason: 'chain_changed' });
  });

  it('refuses to confirm when its ancestry budget cannot prove the full history', async () => {
    const inspector = new ChequebookReceiptInspector(async () => reader(), { maxAncestryBlocks: 2 });
    const result = await inspector.inspect(operation);
    assert.equal(result.kind, 'could_not_check');
    assert.ok(result.kind === 'could_not_check');
    assert.equal(result.reason, 'history_incomplete');
  });

  it('resumes a persisted history after restart without chasing an advancing finalized tip', async () => {
    const repository = new InMemoryChequebookOperations();
    const { operation: admitted } = await repository.admit(candidate);
    await repository.recordSubmission(admitted.id, { state: 'submitted', transactionHash, failureReason: null });
    let tip = 510n;
    const requested: Array<bigint | 'finalized'> = [];
    const rpc = reader();
    const check = () => new ChequebookReceiptCheck(repository, input => new ChequebookReceiptInspector(async () => reader({
      blockHeader: async (block, signal) => {
        requested.push(block);
        return rpc.blockHeader(block === 'finalized' ? tip : block, signal);
      },
    }), { maxAncestryBlocks: 2 }).inspect(input));
    const first = await check().check(admitted.id);
    assert.equal(first.state, 'submitted');
    assert.ok(first.receiptObservation?.kind === 'could_not_check');
    assert.equal(first.receiptObservation.history?.cursorBlockNumber, '508');
    tip = 1000n;
    requested.length = 0;
    let result = first;
    for (let round = 0; round < 4; round++) result = await check().check(admitted.id);
    assert.equal(result.state, 'settled');
    assert.equal(requested.includes('finalized'), false);
    assert.equal(requested.includes(1000n), false);
    assert.equal(result.revision, '6');
  });

  it('retains only fully checked progress when a whole-check timeout interrupts the next parent read', async () => {
    const rpc = reader();
    let resolveLate!: (value: Awaited<ReturnType<ReceiptChainReader['blockHeader']>>) => void;
    const inspector = new ChequebookReceiptInspector(async () => reader({
      blockHeader: async (block, signal) => block === 508n ? new Promise(resolve => { resolveLate = resolve; }) : rpc.blockHeader(block, signal),
    }), { timeoutMs: 30 });
    const result = await inspector.inspect(operation);
    assert.ok(result.kind === 'could_not_check');
    assert.equal(result.reason, 'rpc_unavailable');
    assert.equal(result.history?.cursorBlockNumber, '509');
    const saved = structuredClone(result);
    resolveLate(await rpc.blockHeader(508n));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(result, saved);
    const resumed = await new ChequebookReceiptInspector(async () => reader()).inspect({ ...operation, receiptObservation: result });
    assert.equal(resumed.kind, 'settled');
  });

  it('retains a checkpoint through an RPC outage but discards it when the receipt or chain changes', async () => {
    const first = await new ChequebookReceiptInspector(async () => reader(), { maxAncestryBlocks: 2 }).inspect(operation);
    assert.ok(first.kind === 'could_not_check' && first.history);
    const input = { ...operation, receiptObservation: first };
    const outage = await new ChequebookReceiptInspector(async () => { throw new Error('synthetic-private-path'); }).inspect(input);
    assert.ok(outage.kind === 'could_not_check');
    assert.equal(outage.reason, 'rpc_unavailable');
    assert.deepEqual(outage.history, first.history);
    const rpc = reader();
    for (const blockNumber of [510n, 508n]) {
      const result = await inspect({ blockHeader: async (block, signal) => {
        const header = await rpc.blockHeader(block, signal);
        return block === blockNumber && header ? { ...header, hash: otherHash } : header;
      } }, input);
      assert.deepEqual(result, { kind: 'could_not_check', reason: 'chain_changed' });
    }
    assert.deepEqual(await inspect({ receipt: async () => ({ ...receipt, status: 'reverted' }) }, input), { kind: 'could_not_check', reason: 'chain_changed' });
  });

  it('retains verified progress through a lagging observer returning null evidence', async () => {
    const first = await new ChequebookReceiptInspector(async () => reader(), { maxAncestryBlocks: 2 }).inspect(operation);
    assert.ok(first.kind === 'could_not_check' && first.history);
    for (const method of ['transaction', 'receipt', 'blockHeader'] as const) {
      const interrupted = await inspect({ [method]: async () => null }, { ...operation, receiptObservation: first });
      assert.ok(interrupted.kind === 'could_not_check');
      assert.deepEqual(interrupted.history, first.history);
      const next = await new ChequebookReceiptInspector(async () => reader(), { maxAncestryBlocks: 2 }).inspect({ ...operation, receiptObservation: interrupted });
      assert.ok(next.kind === 'could_not_check');
      assert.equal(next.history?.cursorBlockNumber, '506');
    }
  });

  it('checks the receipt hash before persisting a chunk boundary at that block', async () => {
    const rpc = reader();
    let receiptReads = 0;
    const inspector = new ChequebookReceiptInspector(async () => reader({ blockHeader: async (block, signal) => {
      const header = await rpc.blockHeader(block, signal);
      if (block === 502n && header) return { ...header, parentHash: otherHash };
      if (block === 501n && ++receiptReads > 1 && header) return { ...header, hash: otherHash };
      return header;
    } }), { maxAncestryBlocks: 9 });
    assert.deepEqual(await inspector.inspect(operation), { kind: 'could_not_check', reason: 'chain_changed' });
  });

  it('bounds the whole inspection even if a reader ignores cancellation', async () => {
    let observedSignal: AbortSignal | undefined;
    const never = new Promise<never>(() => {});
    const inspector = new ChequebookReceiptInspector(async (_operation, signal) => {
      observedSignal = signal;
      return never;
    }, { timeoutMs: 25 });
    const started = performance.now();
    assert.deepEqual(await inspector.inspect(operation), { kind: 'could_not_check', reason: 'rpc_unavailable' });
    assert.ok(performance.now() - started < 1500);
    assert.equal(observedSignal?.aborted, true);
  });

  it('sanitizes factory and observation errors without retaining upstream diagnostics', async () => {
    const fail = async (): Promise<never> => { throw new Error('synthetic-private-rpc-path'); };
    const inspectors = [
      new ChequebookReceiptInspector(fail),
      ...(['chainId', 'transaction', 'receipt', 'blockHeader'] as const).map(method => new ChequebookReceiptInspector(async () => reader({ [method]: fail }))),
    ];
    for (const inspector of inspectors) {
      assert.deepEqual(await inspector.inspect(operation), { kind: 'could_not_check', reason: 'rpc_unavailable' });
    }
  });

  it('captures the operation before asynchronous preparation can change its identity', async () => {
    const mutable = { ...operation };
    const inspector = new ChequebookReceiptInspector(async snapshot => {
      mutable.amountPlur = '1';
      assert.ok(Object.isFrozen(snapshot));
      return reader();
    });
    assert.equal((await inspector.inspect(mutable)).kind, 'settled');
  });
});
