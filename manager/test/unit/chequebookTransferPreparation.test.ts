import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookTransferPreparation } from '../../src/domain/chequebook/ChequebookTransferPreparation.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { ChequebookChainRegistry } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { InMemoryChequebookOperations, profileInstanceId, transferContext, transferIntent } from '../support/chequebookOperations.js';

function harness() {
  let disposed = 0;
  let posts = 0;
  let sessions = 0;
  let wallet = { chainID: 100, walletAddress: transferContext.nodeAddress, chequebookContractAddress: transferContext.chequebookAddress,
    bzzBalance: '10000000000000000', nativeTokenBalance: '1' };
  let available = '10000000000000000';
  let address = transferContext.nodeAddress;
  let anchorHash = transferContext.startBlockHash;
  let target = { url: 'http://bee.example.invalid:1633', topology: 'operator_asserted_direct' as const, revision: 'revision-1', profileInstanceId };
  const calls: string[] = [];
  const session = {
    async getAddresses() { calls.push('addresses'); return { ethereum: address }; },
    async getWallet() { calls.push('wallet'); return { ...wallet }; },
    async getChequebookAddress() { calls.push('chequebook'); return { chequebookAddress: transferContext.chequebookAddress }; },
    async getChequebookBalance() { calls.push('balance'); return { totalBalance: available, availableBalance: available }; },
    async depositChequebook() { posts++; return { transactionHash: `0x${'cd'.repeat(32)}` }; },
    async withdrawChequebook() { posts++; return { transactionHash: `0x${'cd'.repeat(32)}` }; },
    assertUsable() {}, dispose() { disposed++; },
  };
  const reader = {
    async chainId() { return 100; }, async transactionCount(node: string, block: bigint) { assert.equal(node, transferContext.nodeAddress); assert.equal(block, 500n); return '8'; },
    async transaction() { return null; }, async receipt() { return null; }, async blockTransactions() { return null; },
    async blockHeader() { return { number: '500', hash: anchorHash, parentHash: `0x${'55'.repeat(32)}` }; },
  };
  const registry = new ChequebookChainRegistry('{"100":"https://rpc.example.invalid"}', () => reader);
  const preparation = new ChequebookTransferPreparation(async () => ({ ...target }), registry, () => { sessions++; return session; });
  return { preparation, session, reader, calls, counts: () => ({ disposed, posts, sessions }),
    changeWallet(value: Partial<typeof wallet>) { wallet = { ...wallet, ...value }; }, setAvailable(value: string) { available = value; },
    changeTarget(value: Partial<typeof target>) { target = { ...target, ...value }; },
    setAddress(value: string) { address = value; }, setAnchor(value: string) { anchorHash = value; } };
}

describe('fresh pinned transfer preparation', () => {
  it('refuses a replacement generation before opening a Bee session', async () => {
    const h = harness();
    h.changeTarget({ profileInstanceId: '22222222-2222-4222-8222-222222222222' });
    const submission = new ChequebookSubmission(new InMemoryChequebookOperations(), intent => h.preparation.prepare(intent));
    await assert.rejects(submission.submit(transferIntent()), /replaced/i);
    assert.deepEqual(h.counts(), { disposed: 0, posts: 0, sessions: 0 });
  });

  it('refuses changed generation during preflight even when the locator and revision text are identical', async () => {
    const h = harness();
    const submission = new ChequebookSubmission(new InMemoryChequebookOperations(), async intent => {
      const prepared = await h.preparation.prepare(intent);
      h.changeTarget({ profileInstanceId: '22222222-2222-4222-8222-222222222222' });
      return prepared;
    });
    const result = await submission.submit(transferIntent());
    assert.equal(result.operation.state, 'rejected');
    assert.equal(result.operation.dispatchStartedAt, null);
    assert.deepEqual(h.counts(), { disposed: 1, posts: 0, sessions: 1 });
  });

  it('freezes all chain and Bee identity fields then rechecks identity and funds under admission', async () => {
    const h = harness();
    const repository = new InMemoryChequebookOperations();
    const submission = new ChequebookSubmission(repository, intent => h.preparation.prepare(intent));
    const result = await submission.submit(transferIntent());
    assert.equal(result.operation.profileInstanceId, profileInstanceId);
    assert.equal(result.operation.chainId, 100);
    assert.equal(result.operation.nodeAddress, transferContext.nodeAddress);
    assert.equal(result.operation.chequebookAddress, transferContext.chequebookAddress);
    assert.equal(result.operation.tokenAddress, '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da');
    assert.equal(result.operation.nonceLowerBound, '8');
    assert.equal(result.operation.nonceQueryTag, '0x1f4');
    assert.equal(result.operation.state, 'submitted');
    assert.ok(h.calls.filter(call => call === 'addresses').length >= 2);
    assert.deepEqual(h.counts(), { disposed: 1, posts: 1, sessions: 1 });
  });

  it('disposes before returning an invalid, unknown or contradictory identity', async () => {
    for (const changed of [{ chainID: 31337 }, { walletAddress: '' }, { chequebookContractAddress: '' }, { walletAddress: `0x${'77'.repeat(20)}` }]) {
      const h = harness(); h.changeWallet(changed);
      await assert.rejects(h.preparation.prepare(transferIntent()), error => error instanceof Error && error.name === 'ChequebookPreparationError');
      assert.deepEqual(h.counts(), { disposed: 1, posts: 0, sessions: 1 });
    }
  });

  it('refuses a chain anchor that changes while the numbered nonce is read', async () => {
    const h = harness();
    h.reader.transactionCount = async () => { h.setAnchor(`0x${'99'.repeat(32)}`); return '8'; };
    await assert.rejects(h.preparation.prepare(transferIntent()), /checked/i);
    assert.equal(h.counts().disposed, 1);
    assert.equal(h.counts().posts, 0);
  });

  it('does not POST if identity or funds change after preparation and before preflight', async () => {
    for (const change of ['identity', 'deposit', 'withdraw', 'gas', 'malformed'] as const) {
      const h = harness();
      const repository = new InMemoryChequebookOperations();
      const submission = new ChequebookSubmission(repository, async intent => {
        const prepared = await h.preparation.prepare(intent);
        if (change === 'identity') h.setAddress(`0x${'98'.repeat(20)}`);
        if (change === 'deposit') h.changeWallet({ bzzBalance: '0' });
        if (change === 'withdraw') h.setAvailable('0');
        if (change === 'gas') h.changeWallet({ nativeTokenBalance: '0' });
        if (change === 'malformed') h.changeWallet({ bzzBalance: 'NaN' });
        return prepared;
      });
      const result = await submission.submit(transferIntent({ direction: change === 'withdraw' ? 'withdraw' : 'deposit' }));
      assert.equal(result.operation.state, 'rejected', change);
      assert.equal(result.operation.dispatchStartedAt, null);
      assert.equal(h.counts().posts, 0);
      assert.equal(h.counts().disposed, 1);
    }
  });

  it('rejects a changed profile revision, host or port before dispatch', async () => {
    for (const target of [{ revision: 'revision-2' }, { url: 'http://other.example.invalid:1633' }, { url: 'http://bee.example.invalid:1634' }]) {
      const h = harness();
      const submission = new ChequebookSubmission(new InMemoryChequebookOperations(), async intent => {
        const prepared = await h.preparation.prepare(intent);
        h.changeTarget(target);
        return prepared;
      });
      const result = await submission.submit(transferIntent());
      assert.equal(result.operation.state, 'rejected');
      assert.equal(result.operation.dispatchStartedAt, null);
      assert.deepEqual(h.counts(), { disposed: 1, posts: 0, sessions: 1 });
    }
  });

  it('requires an operator-asserted direct target and never looks it up for an existing request', async () => {
    const h = harness();
    const missing = new ChequebookTransferPreparation(async () => { throw new Error('synthetic-private-path'); }, new ChequebookChainRegistry(undefined), () => { assert.fail('No session should be opened'); });
    await assert.rejects(missing.prepare(transferIntent()), error => error instanceof Error && !error.message.includes('private-path'));
    const repository = new InMemoryChequebookOperations();
    const intent = transferIntent();
    await new ChequebookSubmission(repository, value => h.preparation.prepare(value)).submit(intent);
    const replay = await new ChequebookSubmission(repository, value => missing.prepare(value)).submit(intent);
    assert.equal(replay.kind, 'replayed');
  });

  it('bounds a stalled identity adapter and disposes its session', async () => {
    const h = harness();
    h.session.getAddresses = async () => new Promise(() => {});
    const preparation = new ChequebookTransferPreparation(async () => ({ url: 'http://bee.example.invalid:1633', topology: 'operator_asserted_direct', revision: 'revision-1', profileInstanceId }), new ChequebookChainRegistry(undefined), () => h.session, { timeoutMs: 15 });
    await assert.rejects(preparation.prepare(transferIntent()), /checked/i);
    assert.equal(h.counts().disposed, 1);
    assert.equal(h.counts().posts, 0);
  });
});
