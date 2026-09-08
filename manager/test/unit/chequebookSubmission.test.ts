import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { ChequebookSubmission, type PreparedChequebookTransfer } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { InMemoryChequebookOperations, operationCandidate, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

function harness() {
  const repository = new InMemoryChequebookOperations();
  let submissions = 0;
  const prepared: PreparedChequebookTransfer = {
    context: { ...transferContext },
    preflight: async () => {},
    send: async operation => {
      submissions++;
      const persisted = await repository.findById(operation.id);
      assert.equal(persisted?.state, 'submitting');
      assert.ok(persisted?.dispatchStartedAt);
      assert.deepEqual(persisted, operation);
      return { transactionHash };
    },
  };
  const service = () => new ChequebookSubmission(repository, async () => prepared);
  return { repository, prepared, service, submissions: () => submissions };
}

describe('durable chequebook submission', () => {
  it('persists all frozen identity fields before the single Bee POST', async () => {
    const h = harness();
    const intent = transferIntent();
    const result = await h.service().submit(intent);
    assert.equal(result.kind, 'admitted');
    assert.equal(result.operation.state, 'submitted');
    assert.equal(result.operation.transactionHash, transactionHash);
    for (const [key, value] of Object.entries({ ...intent, ...transferContext })) {
      assert.equal(result.operation[key as keyof typeof result.operation], value);
    }
    assert.equal(h.submissions(), 1);
  });

  it('normalizes the node and contract addresses before admission', async () => {
    const h = harness();
    h.prepared.context = { ...transferContext, nodeAddress: `0x${'AB'.repeat(20)}`, chequebookAddress: `0x${'CD'.repeat(20)}` };
    const result = await h.service().submit(transferIntent());
    assert.equal(result.operation.nodeAddress, transferContext.nodeAddress);
    assert.equal(result.operation.chequebookAddress, `0x${'cd'.repeat(20)}`);
  });

  it('does not call Bee if the journal cannot persist admission', async () => {
    const h = harness();
    h.repository.admit = async () => { throw new Error('database unavailable'); };
    await assert.rejects(h.service().submit(transferIntent()), /journal/i);
    assert.equal(h.submissions(), 0);
  });

  it('does not expose raw preparation failures or admit an incomplete observation', async () => {
    const h = harness();
    const service = new ChequebookSubmission(h.repository, async () => { throw new Error('synthetic sensitive upstream diagnostic'); });
    await assert.rejects(service.submit(transferIntent()), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'ChequebookPreparationError');
      assert.equal(error.message, 'The node and chain could not be checked. Refresh the saved transfers before continuing.');
      assert.ok(!JSON.stringify(error).includes('sensitive'));
      return true;
    });
    assert.equal(h.repository.rows.size, 0);
    assert.equal(h.submissions(), 0);
  });

  it('keeps a lost response unresolved across a new service instance and repeated requests', async () => {
    const h = harness();
    const intent = transferIntent();
    let received = 0;
    h.prepared.send = async () => { received++; throw new Error('response lost'); };
    const first = await h.service().submit(intent);
    assert.equal(first.operation.state, 'unknown');
    const retry = await h.service().submit(intent);
    assert.equal(retry.kind, 'replayed');
    assert.equal(retry.operation.id, first.operation.id);
    const secondIntent = await h.service().submit(transferIntent({ profileName: 'node-alias', direction: 'withdraw' }));
    assert.equal(secondIntent.kind, 'busy');
    assert.equal(received, 1);
  });

  it('never sends a submitting record left by a crash before the POST', async () => {
    const h = harness();
    const candidate = operationCandidate();
    await h.repository.admit(candidate);
    const result = await h.service().submit(candidate);
    assert.equal(result.kind, 'replayed');
    assert.equal(result.operation.state, 'submitting');
    assert.equal(h.submissions(), 0);
    assert.equal((await h.service().submit(transferIntent())).kind, 'busy');
  });

  it('retains the durable guard when Bee returns a hash but saving it fails', async () => {
    const h = harness();
    const intent = transferIntent();
    h.repository.recordSubmission = async () => { throw new Error('connection lost'); };
    await assert.rejects(h.service().submit(intent), /journal/i);
    assert.equal(h.submissions(), 1);
    const retry = await h.service().submit(intent);
    assert.equal(retry.operation.state, 'submitting');
    assert.equal(h.submissions(), 1);
    assert.equal((await h.service().submit(transferIntent())).kind, 'busy');
  });

  it('replays an original terminal request even if its profile can no longer be read', async () => {
    const h = harness();
    const intent = transferIntent();
    const first = await h.service().submit(intent);
    h.repository.rows.set(first.operation.id, { ...first.operation, state: 'settled' });
    const restarted = new ChequebookSubmission(h.repository, async () => { throw new Error('profile removed'); });
    assert.equal((await restarted.submit(intent)).operation.state, 'settled');
    for (const changed of [{ amountPlur: '1' }, { direction: 'withdraw' as const }, { profileName: 'different' }, { requestedBy: 'another-operator' }]) {
      assert.equal((await restarted.submit({ ...intent, ...changed })).kind, 'conflict');
    }
    assert.equal(h.submissions(), 1);
  });

  it('reserves the node before checking funds and holds it until the outcome is known', async () => {
    const h = harness();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.prepared.preflight = async () => { entered(); await gate; };
    const first = h.service().submit(transferIntent());
    await started;
    assert.equal((await h.service().submit(transferIntent({ direction: 'withdraw', profileName: 'alias' }))).kind, 'busy');
    finish();
    assert.equal((await first).operation.state, 'submitted');
    assert.equal(h.submissions(), 1);
  });

  it('closes only a proven pre-POST failure as rejected without copying raw errors', async () => {
    const h = harness();
    const intent = transferIntent();
    h.prepared.preflight = async () => { throw new Error('sensitive upstream details'); };
    const result = await h.service().submit(intent);
    assert.equal(result.operation.state, 'rejected');
    assert.equal(result.operation.failureReason, 'preflight_failed');
    assert.ok(!JSON.stringify(result).includes('sensitive'));
    assert.equal(h.submissions(), 0);
    h.prepared.preflight = async () => {};
    assert.equal((await h.service().submit(intent)).operation.state, 'rejected');
    assert.equal((await h.service().submit(transferIntent())).operation.state, 'submitted');
    assert.equal(h.submissions(), 1);
  });

  it('treats a malformed successful Bee response as unknown', async () => {
    const h = harness();
    h.prepared.send = async () => ({ transactionHash: 'not-a-hash' });
    const result = await h.service().submit(transferIntent());
    assert.equal(result.operation.state, 'unknown');
    assert.equal(result.operation.transactionHash, null);
    assert.equal((await h.service().submit(transferIntent())).kind, 'busy');
  });

  it('does not downgrade an operation resolved while the POST response was delayed', async () => {
    const h = harness();
    h.prepared.send = async operation => {
      h.repository.rows.set(operation.id, { ...operation, state: 'settled', transactionHash });
      throw new Error('late response failure');
    };
    assert.equal((await h.service().submit(transferIntent())).operation.state, 'settled');
  });

  it('does not dispatch after closure while preflight was paused', async () => {
    const h = harness();
    let oldId = '';
    h.prepared.preflight = async operation => {
      oldId = operation.id;
      h.repository.rows.set(operation.id, { ...operation, state: 'asserted' });
      const replacement = await h.repository.admit(operationCandidate());
      assert.equal(replacement.kind, 'admitted');
    };
    const result = await h.service().submit(transferIntent());
    assert.equal(result.operation.id, oldId);
    assert.equal(result.operation.state, 'asserted');
    assert.equal(h.submissions(), 0);
  });

  it('never sends when dispatch was claimed but the claim response was lost', async () => {
    const h = harness();
    const intent = transferIntent();
    const claim = h.repository.claimDispatch.bind(h.repository);
    h.repository.claimDispatch = async id => { await claim(id); throw new Error('lost dispatch acknowledgement'); };
    await assert.rejects(h.service().submit(intent), /journal/i);
    const retry = await h.service().submit(intent);
    assert.equal(retry.operation.state, 'submitting');
    assert.ok(retry.operation.dispatchStartedAt);
    assert.equal(h.submissions(), 0);
  });

  it('rejects invalid request identities and amounts before prepare or admission', async () => {
    const h = harness();
    let prepared = 0;
    const service = new ChequebookSubmission(h.repository, async () => { prepared++; return h.prepared; });
    for (const changed of [{ requestId: 'missing' }, { amountPlur: '0' }, { amountPlur: '-1' }, { amountPlur: '1e3' }, { amountPlur: '1'.repeat(31) }, { profileName: '' }, { requestedBy: '' }]) {
      await assert.rejects(service.submit(transferIntent(changed)), /invalid/i);
    }
    assert.equal(prepared, 0);
    assert.equal(h.repository.rows.size, 0);
  });

  it('refuses incomplete chain identity and bounds before reserving or sending', async () => {
    const h = harness();
    for (const changed of [{ chainId: 0 }, { nodeAddress: '' }, { chequebookAddress: '0x12' }, { tokenAddress: '' }, { startBlockNumber: '-1' }, { startBlockHash: '' }, { nonceLowerBound: '0x8' }, { nonceQueryTag: '' }]) {
      h.prepared.context = { ...transferContext, ...changed };
      await assert.rejects(h.service().submit(transferIntent()), /invalid/i);
    }
    assert.equal(h.repository.rows.size, 0);
    assert.equal(h.submissions(), 0);
  });

  it('does not let caller mutation change the transfer after admission', async () => {
    const h = harness();
    const intent = transferIntent();
    h.prepared.preflight = async () => {
      Object.assign(intent, { amountPlur: '1', requestId: randomUUID() });
      Object.assign(h.prepared.context, { nodeAddress: `0x${'ff'.repeat(20)}` });
    };
    const result = await h.service().submit(intent);
    assert.equal(result.operation.amountPlur, '5000000000000000');
    assert.equal(result.operation.nodeAddress, transferContext.nodeAddress);
    assert.equal(h.submissions(), 1);
  });
});
