/**
 * The manager checking its own submitted transfers.
 *
 * A transfer that Bee answered with a hash sits in `submitted` until somebody
 * or something asks the chain whether it landed. This is the something. It
 * gets one budget per row, opened when the row became submitted, and it never
 * renews it, so a transfer that nobody watches still reaches a verdict and a
 * transfer nobody can settle still stops costing RPC calls.
 *
 * No test here waits on real time. The tick timer is injected, so a scheduled
 * tick only happens when a case fires it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECEIPT_POLL_INTERVAL_MS, type ChequebookOperation, type ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import { ChequebookJournalError } from '../../src/domain/errors/ChequebookJournalError.js';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
import { ChequebookReceiptPoller } from '../../src/domain/chequebook/ChequebookReceiptPoller.js';
import { InMemoryChequebookOperations, operationCandidate } from '../support/chequebookOperations.js';

const settled: ChequebookReceiptObservation = { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };
const pending: ChequebookReceiptObservation = { kind: 'pending', reason: 'awaiting_receipt' };
const node = (index: number) => `0x${index.toString(16).padStart(2, '0').repeat(20)}`;
const hash = (index: number) => `0x${index.toString(16).padStart(2, '0').repeat(32)}`;

/** Lets every already-resolved promise chain in the poller run to completion. */
async function drain(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) await new Promise(resolve => setImmediate(resolve));
}

function injectedTicks() {
  const scheduled: { call: () => void; milliseconds: number }[] = [];
  let cancellations = 0;
  return {
    scheduled,
    cancellations: () => cancellations,
    schedule(call: () => void, milliseconds: number) {
      const entry = { call, milliseconds };
      scheduled.push(entry);
      return () => {
        cancellations++;
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    async fire(): Promise<void> {
      const next = scheduled.shift();
      assert.ok(next, 'a next tick was scheduled');
      next.call();
      await drain();
    },
  };
}

function harness(options: { observation?: (id: string) => ChequebookReceiptObservation; failOn?: () => string | null } = {}) {
  const repository = new InMemoryChequebookOperations();
  const lines: string[] = [];
  const inspected: string[] = [];
  const receipts = new ChequebookReceiptCheck(repository, async operation => {
    inspected.push(operation.transactionHash);
    return options.observation?.(operation.transactionHash) ?? pending;
  });
  const checked: string[] = [];
  const check = {
    async check(id: string): Promise<ChequebookOperation> {
      checked.push(id);
      if (options.failOn?.() === id) throw new ChequebookJournalError();
      return receipts.check(id);
    },
  };
  const ticks = injectedTicks();
  async function submitted(index: number): Promise<ChequebookOperation> {
    const { operation } = await repository.admit(operationCandidate({ profileName: `alias-${index}`, nodeAddress: node(index) }));
    await repository.claimDispatch(operation.id);
    return repository.recordSubmission(operation.id, { state: 'submitted', transactionHash: hash(index), failureReason: null });
  }
  function poller(overrides: { intervalMs?: number; batchLimit?: number } = {}) {
    return new ChequebookReceiptPoller(repository, check, { intervalMs: 50, schedule: ticks.schedule, log: line => lines.push(line), ...overrides });
  }
  function age(id: string, milliseconds: number) {
    const row = repository.rows.get(id)!;
    repository.rows.set(id, { ...row, receiptCheckedAt: new Date(Date.parse(row.receiptCheckedAt!) - milliseconds).toISOString() });
  }
  return { repository, receipts, ticks, lines, checked, inspected, submitted, poller, age };
}

describe('ChequebookReceiptPoller', () => {
  it('checks a submitted row on start and again one interval later', async t => {
    const h = harness();
    const row = await h.submitted(1);
    const poller = h.poller();
    t.after(() => poller.stop());
    poller.start();
    await drain();
    assert.deepEqual(h.checked, [row.id]);
    assert.equal(h.ticks.scheduled[0]?.milliseconds, 50);
    await h.ticks.fire();
    assert.deepEqual(h.checked, [row.id], 'a row checked within the interval is not owed another check');
    h.age(row.id, 60_000);
    await h.ticks.fire();
    assert.deepEqual(h.checked, [row.id, row.id]);
    const polled = await h.repository.findById(row.id);
    assert.equal(polled?.state, 'submitted');
    assert.equal(polled?.revision, String(BigInt(row.revision) + 1n), 'a poll that sees nothing new does not move the revision under the operator');
  });

  it('stops polling a row once the chain answers with a terminal receipt', async t => {
    const h = harness({ observation: () => settled });
    const row = await h.submitted(1);
    const poller = h.poller();
    t.after(() => poller.stop());
    poller.start();
    await drain();
    assert.equal((await h.repository.findById(row.id))?.state, 'settled');
    await h.ticks.fire();
    assert.deepEqual(h.checked, [row.id]);
  });

  it('never checks a spent budget, a submitting row, an unknown row or a conflicted row', async t => {
    const h = harness();
    const spent = await h.submitted(1);
    h.repository.rows.set(spent.id, { ...h.repository.rows.get(spent.id)!, receiptPollUntil: new Date(Date.now() - 1000).toISOString() });
    const conflicted = await h.submitted(2);
    h.repository.rows.set(conflicted.id, { ...h.repository.rows.get(conflicted.id)!, failureReason: 'hash_conflict' });
    const submitting = (await h.repository.admit(operationCandidate({ profileName: 'alias-3', nodeAddress: node(3) }))).operation;
    const { operation: fourth } = await h.repository.admit(operationCandidate({ profileName: 'alias-4', nodeAddress: node(4) }));
    await h.repository.claimDispatch(fourth.id);
    const unknown = await h.repository.recordSubmission(fourth.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    const poller = h.poller();
    t.after(() => poller.stop());
    poller.start();
    await drain();
    await h.ticks.fire();
    assert.deepEqual(h.checked, []);
    assert.deepEqual(h.inspected, []);
    assert.deepEqual([spent, conflicted, submitting, unknown].map(row => row.state), ['submitted', 'submitted', 'submitting', 'unknown']);
    assert.deepEqual(h.lines, []);
  });

  it('carries on through a journal failure on one row and still schedules the next tick', async t => {
    let failing: string | null = null;
    const h = harness({ observation: () => settled, failOn: () => failing });
    const first = await h.submitted(1);
    const second = await h.submitted(2);
    failing = first.id;
    const poller = h.poller();
    t.after(() => poller.stop());
    poller.start();
    await drain();
    assert.deepEqual(new Set(h.checked), new Set([first.id, second.id]));
    assert.equal((await h.repository.findById(second.id))?.state, 'settled');
    assert.equal((await h.repository.findById(first.id))?.state, 'submitted');
    failing = null;
    await h.ticks.fire();
    assert.equal((await h.repository.findById(first.id))?.state, 'settled');
    assert.equal((await h.repository.findById(second.id))?.state, 'settled');
  });

  it('starts no batch while one is still running, however long a check takes', async t => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = harness();
    const row = await h.submitted(1);
    const slow = { check: async (id: string) => { h.checked.push(id); await held; return h.receipts.check(id); } };
    const poller = new ChequebookReceiptPoller(h.repository, slow, { intervalMs: 50, schedule: h.ticks.schedule, log: line => h.lines.push(line) });
    t.after(async () => { release(); await poller.stop(); });
    poller.start();
    await drain();
    assert.deepEqual(h.checked, [row.id]);
    assert.deepEqual(h.ticks.scheduled, [], 'the next tick is scheduled only after the batch ends');
    release();
    await drain();
    assert.equal(h.ticks.scheduled.length, 1);
    assert.deepEqual(h.checked, [row.id]);
  });

  it('waits for the running batch and schedules nothing more once stopped', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = harness();
    const row = await h.submitted(1);
    let finished = false;
    const slow = { check: async (id: string) => { await held; finished = true; return h.receipts.check(id); } };
    const poller = new ChequebookReceiptPoller(h.repository, slow, { intervalMs: 50, schedule: h.ticks.schedule, log: line => h.lines.push(line) });
    poller.start();
    await drain();
    const stopping = poller.stop();
    release();
    await stopping;
    assert.equal(finished, true);
    assert.deepEqual(h.ticks.scheduled, []);
    assert.equal((await h.repository.findById(row.id))?.receiptCheckedAt !== null, true);
    await poller.stop();
    assert.deepEqual(h.ticks.scheduled, []);
  });

  it('stops between rows instead of waiting out the whole batch', async () => {
    const h = harness();
    await h.submitted(1);
    await h.submitted(2);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const slow = { check: async (id: string) => { h.checked.push(id); await held; return h.receipts.check(id); } };
    const poller = new ChequebookReceiptPoller(h.repository, slow, { intervalMs: 50, schedule: h.ticks.schedule, log: line => h.lines.push(line) });
    poller.start();
    await drain();
    assert.equal(h.checked.length, 1, 'the batch is inside its first row');
    const stopping = poller.stop();
    release();
    await stopping;
    assert.equal(h.checked.length, 1, 'a row the poller had not reached when it was told to stop is never checked');
    assert.deepEqual(h.ticks.scheduled, []);
  });

  it('refuses to start again after it has been stopped', async () => {
    const h = harness();
    const row = await h.submitted(1);
    const poller = h.poller();
    await poller.stop();
    poller.start();
    await drain();
    assert.deepEqual(h.checked, []);
    assert.deepEqual(h.ticks.scheduled, []);
    assert.equal((await h.repository.findById(row.id))?.receiptCheckedAt, null);
  });

  it('cancels a scheduled tick when it is stopped between batches', async () => {
    const h = harness();
    await h.submitted(1);
    const poller = h.poller();
    poller.start();
    await drain();
    assert.equal(h.ticks.scheduled.length, 1);
    await poller.stop();
    assert.equal(h.ticks.cancellations(), 1);
    assert.deepEqual(h.ticks.scheduled, []);
  });

  it('logs one line naming operation ids and observation kinds, and nothing else', async t => {
    let failing: string | null = null;
    const h = harness({ observation: () => settled, failOn: () => failing });
    const first = await h.submitted(1);
    const second = await h.submitted(2);
    failing = second.id;
    const poller = h.poller();
    t.after(() => poller.stop());
    poller.start();
    await drain();
    assert.equal(h.lines.length, 1);
    const line = h.lines[0]!;
    assert.match(line, new RegExp(`${first.id} settled`));
    assert.match(line, new RegExp(`${second.id} journal_error`));
    for (const secret of ['http', 'socket', 'Error', 'stack', hash(1), node(1)]) assert.equal(line.includes(secret), false, `${secret} must not reach the log`);
    failing = null;
    await h.ticks.fire();
    assert.equal(h.lines.length, 2);
    await h.ticks.fire();
    assert.equal(h.lines.length, 2, 'a tick that changed nothing writes no line');
  });

  it('reads at most one batch of due rows and defaults to the shared interval', async t => {
    const h = harness();
    for (const index of [1, 2, 3]) await h.submitted(index);
    const poller = h.poller({ batchLimit: 2 });
    t.after(() => poller.stop());
    poller.start();
    await drain();
    assert.equal(h.checked.length, 2);
    const shared = new ChequebookReceiptPoller(h.repository, { check: async () => { throw new ChequebookJournalError(); } }, { schedule: h.ticks.schedule });
    shared.start();
    await drain();
    assert.equal(h.ticks.scheduled.at(-1)?.milliseconds, RECEIPT_POLL_INTERVAL_MS);
    await shared.stop();
  });
});
