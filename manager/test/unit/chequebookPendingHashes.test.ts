import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookPendingHashes } from '../../src/domain/chequebook/ChequebookPendingHashes.js';
import { operationCandidate, transactionHash } from '../support/chequebookOperations.js';

function harness() {
  const operation = operationCandidate({ tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' });
  let disposed = 0;
  let pendingReads = 0;
  let result: unknown = { pendingTransactions: [{ transactionHash }] };
  let node = operation.nodeAddress;
  const reader = new ChequebookPendingHashes(async () => ({ url: 'http://bee.example.invalid:1633', topology: 'operator_asserted_direct', revision: '1' }), () => ({
    async getAddresses() { return { ethereum: node }; },
    async getWallet() { return { walletAddress: node, chainID: 100, chequebookContractAddress: operation.chequebookAddress }; },
    async getChequebookAddress() { return { chequebookAddress: operation.chequebookAddress }; },
    async getPendingTransactions() { pendingReads++; return result; },
    dispose() { disposed++; },
  }));
  return { reader, operation, setResult(value: unknown) { result = value; }, setNode(value: string) { node = value; }, counts: () => ({ disposed, pendingReads }) };
}

describe('identity-bound pending Bee hashes', () => {
  it('uses only hashes from the matching current Bee identity and closes every session', async () => {
    const h = harness();
    assert.deepEqual(await h.reader.read(h.operation, new AbortController().signal), [transactionHash]);
    assert.deepEqual(h.counts(), { disposed: 1, pendingReads: 1 });
  });

  it('refuses a replacement node and never mistakes unavailable or malformed evidence for an empty list', async () => {
    const replaced = harness(); replaced.setNode(`0x${'88'.repeat(20)}`);
    await assert.rejects(replaced.reader.read(replaced.operation, new AbortController().signal));
    assert.deepEqual(replaced.counts(), { disposed: 1, pendingReads: 0 });
    for (const value of [null, {}, { pendingTransactions: null }, { pendingTransactions: [{}] }, { pendingTransactions: [{ transactionHash: 'bad' }] }]) {
      const h = harness(); h.setResult(value);
      await assert.rejects(h.reader.read(h.operation, new AbortController().signal));
      assert.equal(h.counts().disposed, 1);
    }
    const missing = new ChequebookPendingHashes(async () => { throw new Error('synthetic-private-path'); }, () => { assert.fail('No session on missing profile'); });
    await assert.rejects(missing.read(replaced.operation, new AbortController().signal), error => error instanceof Error && !error.message.includes('private-path'));
  });

  it('closes a stalled read when its owning recovery check is cancelled', async () => {
    const controller = new AbortController();
    let disposed = 0;
    const reader = new ChequebookPendingHashes(async () => ({ url: 'http://bee.example.invalid:1633', topology: 'operator_asserted_direct', revision: '1' }), () => ({
      getAddresses: async () => new Promise(() => {}), getWallet: async () => ({}), getChequebookAddress: async () => ({ chequebookAddress: '' }),
      getPendingTransactions: async () => ({}), dispose() { disposed++; },
    }));
    const promise = reader.read(operationCandidate(), controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(promise);
    assert.equal(disposed, 1);
  });
});
