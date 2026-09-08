import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookOperation } from '@streaming-infra-manager/common';
import { ChequebookRecoveryInspector, type RecoveryChainReader } from '../../src/domain/chequebook/ChequebookRecoveryInspector.js';
import type { ChainBlock } from '../../src/domain/chequebook/ChainRpc.js';
import type { ChainTransaction } from '../../src/domain/chequebook/chainEvidence.js';
import { InMemoryChequebookOperations, operationCandidate, transactionHash, transferContext } from '../support/chequebookOperations.js';

const tokenAddress = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
function transaction(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  return { hash: transactionHash, chainId: 100, from: transferContext.nodeAddress, to: tokenAddress,
    data: `0xa9059cbb${transferContext.chequebookAddress.slice(2).padStart(64, '0')}${BigInt('5000000000000000').toString(16).padStart(64, '0')}`,
    nonce: '9', value: '0', blockNumber: null, blockHash: null, ...overrides };
}
async function fixture(end = 503) {
  const repository = new InMemoryChequebookOperations();
  const admitted = await repository.admit(operationCandidate({ tokenAddress, startBlockHash: hash(500) }));
  await repository.claimDispatch(admitted.operation.id);
  const operation = await repository.recordSubmission(admitted.operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
  const blocks = new Map<string, ChainBlock>();
  for (let n = 500; n <= end; n++) blocks.set(String(n), { number: String(n), hash: hash(n), parentHash: hash(n - 1), transactions: [] });
  const transactions = new Map<string, ChainTransaction>();
  const scanned: string[] = [];
  const headers: string[] = [];
  const reader: RecoveryChainReader = {
    async chainId() { return 100; },
    async transaction(hash) { return transactions.get(hash) ?? null; },
    async blockHeader(number) { headers.push(String(number)); return blocks.get(String(number === 'latest' ? end : number)) ?? null; },
    async blockTransactions(number) { scanned.push(String(number)); return blocks.get(String(number)) ?? null; },
  };
  return { repository, operation, blocks, transactions, scanned, headers, reader };
}
function resumed(operation: ChequebookOperation, observation: ChequebookOperation['recoveryObservation']): ChequebookOperation {
  return { ...operation, recoveryObservation: observation };
}

describe('bounded lost-response chain scanning', () => {
  it('finds a mined n+1 transfer despite unrelated pending work at the sampled nonce', async () => {
    const f = await fixture();
    const unrelated = transaction({ hash: hash(90), nonce: '8', data: '0x' });
    const intended = transaction({ blockNumber: '501', blockHash: hash(501) });
    f.transactions.set(unrelated.hash, unrelated);
    f.transactions.set(intended.hash, intended);
    f.blocks.set('501', { ...f.blocks.get('501')!, transactions: [unrelated, intended] });
    const inspector = new ChequebookRecoveryInspector(async () => f.reader, async () => [unrelated.hash]);
    const result = await inspector.inspect(f.operation);
    assert.equal(result.observation.kind, 'candidate');
    assert.deepEqual(result.candidates.map(item => item.hash), [intended.hash]);
    assert.deepEqual(f.scanned, ['503', '502', '501', '500']);
  });

  it('checks pending hashes first and can force the scan when attribution is ambiguous', async () => {
    const f = await fixture();
    const pending = transaction();
    f.transactions.set(pending.hash, pending);
    const inspector = new ChequebookRecoveryInspector(async () => f.reader, async () => [pending.hash]);
    const first = await inspector.inspect(f.operation);
    assert.equal(first.observation.kind, 'candidate');
    assert.deepEqual(f.scanned, []);
    const forced = await inspector.inspect(resumed(f.operation, first.observation), { forceScan: true });
    assert.equal(forced.observation.kind, 'candidate');
    assert.equal(forced.observation.scan?.complete, true);
    assert.equal(f.scanned.length, 4);
  });

  it('persists an exact cursor across restart without chasing a growing tip', async () => {
    const f = await fixture(505);
    const first = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { maxBlocks: 2 }).inspect(f.operation);
    assert.equal(first.observation.kind, 'searching');
    assert.equal(first.observation.scan?.nextBlockNumber, '503');
    assert.deepEqual(f.scanned, ['505', '504']);
    const next = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { maxBlocks: 2 }).inspect(resumed(f.operation, first.observation));
    assert.equal(next.observation.scan?.nextBlockNumber, '501');
    const completed = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { maxBlocks: 2 }).inspect(resumed(f.operation, next.observation));
    assert.equal(completed.observation.kind, 'no_match');
    assert.deepEqual(f.scanned, ['505', '504', '503', '502', '501', '500']);
    assert.equal(f.headers.filter(item => item === 'latest').length, 1);
  });

  it('retains checked progress through null block observations and endpoint failures', async () => {
    const f = await fixture(505);
    const first = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { maxBlocks: 2 }).inspect(f.operation);
    const original = f.reader.blockTransactions;
    f.reader.blockTransactions = async () => null;
    const interrupted = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, first.observation));
    assert.equal(interrupted.observation.kind, 'could_not_check');
    assert.deepEqual(interrupted.observation.scan, first.observation.scan);
    f.reader.blockTransactions = async () => { throw new Error('synthetic-private-path'); };
    const failed = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, interrupted.observation));
    assert.deepEqual(failed.observation.scan, first.observation.scan);
    assert.ok(!JSON.stringify(failed).includes('synthetic-private-path'));
    f.reader.blockTransactions = original;
    assert.equal((await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, failed.observation))).observation.kind, 'no_match');
  });

  it('refuses changed anchors, pinned heads, cursors and mixed parent histories', async () => {
    for (const changedNumber of [500, 505, 503]) {
      const f = await fixture(505);
      const first = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { maxBlocks: 2 }).inspect(f.operation);
      f.blocks.set(String(changedNumber), { ...f.blocks.get(String(changedNumber))!, hash: hash(999) });
      const result = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, first.observation));
      assert.equal(result.observation.kind, 'could_not_check');
      if (result.observation.kind === 'could_not_check') assert.equal(result.observation.reason, 'chain_changed');
      assert.equal(result.observation.scan, undefined);
    }
    const f = await fixture();
    f.blocks.set('502', { ...f.blocks.get('502')!, parentHash: hash(999) });
    const result = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(f.operation);
    assert.equal(result.observation.kind, 'could_not_check');
    if (result.observation.kind === 'could_not_check') assert.equal(result.observation.reason, 'chain_changed');
  });

  it('never turns ambiguous candidates or an incomplete pending read into a no-match pass', async () => {
    const f = await fixture();
    const first = transaction();
    const second = transaction({ hash: hash(92), nonce: '10' });
    f.transactions.set(first.hash, first);
    f.transactions.set(second.hash, second);
    const ambiguous = await new ChequebookRecoveryInspector(async () => f.reader, async () => [first.hash, second.hash]).inspect(f.operation);
    assert.equal(ambiguous.observation.kind, 'ambiguous');
    assert.equal(ambiguous.observation.scan?.complete, true);
    const disappeared = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, ambiguous.observation));
    assert.equal(disappeared.observation.kind, 'ambiguous');
    f.transactions.clear();
    const unresolved = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, ambiguous.observation));
    assert.equal(unresolved.observation.kind, 'could_not_check');
    assert.deepEqual(unresolved.observation.candidateHashes, [first.hash, second.hash]);
    const unavailable = await new ChequebookRecoveryInspector(async () => f.reader, async () => { throw new Error('private'); }).inspect(f.operation);
    assert.equal(unavailable.observation.kind, 'could_not_check');
  });

  it('bounds the complete observation even when the reader factory ignores cancellation', async () => {
    const f = await fixture();
    const started = Date.now();
    const inspector = new ChequebookRecoveryInspector(async () => new Promise(() => {}), async () => [], { timeoutMs: 15 });
    const result = await inspector.inspect(f.operation);
    assert.equal(result.observation.kind, 'could_not_check');
    assert.ok(Date.now() - started < 500);
  });

  it('does not advance past a timed-out block and preserves a discovered candidate across chunks', async () => {
    const f = await fixture(505);
    const intended = transaction({ blockNumber: '505', blockHash: hash(505) });
    f.transactions.set(intended.hash, intended);
    f.blocks.set('505', { ...f.blocks.get('505')!, transactions: [intended] });
    const original = f.reader.blockTransactions;
    f.reader.blockTransactions = async number => number === 504n ? new Promise(() => {}) : original(number, f.operation.nodeAddress);
    const first = await new ChequebookRecoveryInspector(async () => f.reader, async () => [], { timeoutMs: 15 }).inspect(f.operation, { forceScan: true });
    assert.equal(first.observation.kind, 'could_not_check');
    assert.equal(first.observation.scan?.nextBlockNumber, '504');
    assert.deepEqual(first.observation.candidateHashes, [intended.hash]);
    f.reader.blockTransactions = original;
    const next = await new ChequebookRecoveryInspector(async () => f.reader, async () => []).inspect(resumed(f.operation, first.observation), { forceScan: true });
    assert.equal(next.observation.kind, 'candidate');
    assert.deepEqual(next.observation.candidateHashes, [intended.hash]);
    assert.equal(next.observation.scan?.complete, true);
  });
});
