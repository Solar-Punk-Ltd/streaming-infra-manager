import { IndexedDbTransferIntentStore, type ConfirmedTransferInput } from '../src/transfers/transferIntentStore';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function input(overrides: Partial<ConfirmedTransferInput> = {}): ConfirmedTransferInput {
  return { requestId: crypto.randomUUID(), accountId: 7, profileName: 'synthetic-test',
    profileInstanceId: '11111111-1111-4111-8111-111111111111', direction: 'deposit', amountPlur: '5000000000000000',
    createdAt: '2026-09-08T00:00:00.000Z', ...overrides };
}

export async function runIntentTests(): Promise<{ passed: number; tests: string[] }> {
  const tests: string[] = [];
  const name = `t09-test-${crypto.randomUUID()}`;
  const first = new IndexedDbTransferIntentStore(indexedDB, name);
  const second = new IndexedDbTransferIntentStore(indexedDB, name);
  try {
    const a = input();
    const b = input();
    const results = await Promise.all([first.confirm(a, null), second.confirm(b, null)]);
    assert(results.filter(result => result.kind === 'created').length === 1, 'Concurrent confirmation must have one creator');
    assert(results[0].intent.requestId === results[1].intent.requestId, 'Both connections must restore the same winning UUID');
    const winner = results[0].intent;
    assert((await second.find(winner.requestId))?.requestId === winner.requestId, 'A completed confirmation must be visible to another connection');
    tests.push('one atomic confirmation winner and durable completion');

    const reload = new IndexedDbTransferIntentStore(indexedDB, name);
    try {
      assert((await reload.current(a.accountId, a.profileInstanceId))?.requestId === winner.requestId, 'Reload must retain the exact pointer');
    } finally { await reload.close(); }
    tests.push('reload preserves the immutable request UUID');

    const next = input();
    const competingNext = input();
    const nextResults = await Promise.all([first.confirm(next, winner.requestId), second.confirm(competingNext, winner.requestId)]);
    assert(nextResults.filter(result => result.kind === 'created').length === 1, 'Explicit replacement must compare the same pointer atomically');
    const current = nextResults[0].intent;
    assert(nextResults[1].intent.requestId === current.requestId, 'A stale replacement must restore the current pointer');
    assert((await first.find(winner.requestId))?.requestId === winner.requestId, 'Replacing a pointer must retain earlier intents');
    assert((await second.confirm(input(), winner.requestId)).intent.requestId === current.requestId, 'Old terminal tabs cannot replace a newer pointer');
    tests.push('explicit replacement uses current-pointer CAS and preserves history');

    const otherAccount = input({ accountId: 8 });
    assert((await first.confirm(otherAccount, null)).kind === 'created', 'A different account has its own initial pointer');
    const replacementProfile = input({ profileInstanceId: '22222222-2222-4222-8222-222222222222' });
    assert((await first.confirm(replacementProfile, null)).kind === 'created', 'A different deployment lifetime must not be held by an unidentified old request');
    tests.push('coordination is scoped by account and deployment instance');

    let refused = false;
    try { await first.confirm({ ...current, amountPlur: '1' }, current.requestId); } catch { refused = true; }
    assert(refused, 'Existing request UUID cannot be repurposed with a changed amount');
    assert((await second.find(current.requestId))?.amountPlur === current.amountPlur, 'A refused mutation must leave the immutable intent intact');
    tests.push('immutable request identity cannot be overwritten');

    for (const invalid of [input({ accountId: 0 }), input({ profileInstanceId: '' }), input({ amountPlur: '0' }), input({ requestId: 'not-a-uuid' })]) {
      let invalidRefused = false;
      try { await first.confirm(invalid, null); } catch { invalidRefused = true; }
      assert(invalidRefused, 'Invalid durable identity must fail closed');
    }
    tests.push('invalid intent cannot enter persistent storage');

    const aborted = input({ profileInstanceId: '33333333-3333-4333-8333-333333333333' });
    const originalAdd = IDBObjectStore.prototype.add;
    let addSucceeded = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<IDBObjectStore['add']>) {
      const request = originalAdd.apply(this, args);
      if (this.transaction.db.name === name && this.name === 'intents') {
        request.addEventListener('success', () => { addSucceeded = true; this.transaction.abort(); });
      }
      return request;
    };
    let abortRefused = false;
    try { await first.confirm(aborted, null); } catch { abortRefused = true; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    assert(addSucceeded && abortRefused, 'A successful add followed by transaction abort must never grant the send permit');
    assert(await second.current(aborted.accountId, aborted.profileInstanceId) === null, 'An aborted transaction cannot retain a pointer');
    assert(await second.find(aborted.requestId) === null, 'An aborted transaction cannot retain an intent');
    tests.push('request success is insufficient until the whole transaction completes');

    const damaged = input({ profileInstanceId: '44444444-4444-4444-8444-444444444444' });
    const missingId = crypto.randomUUID();
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Synthetic corruption setup failed'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = raw.transaction(['pointers'], 'readwrite');
        transaction.objectStore('pointers').put({ scope: JSON.stringify([damaged.accountId, damaged.profileInstanceId]), requestId: missingId });
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error('Synthetic corruption setup aborted'));
      });
    } finally { raw.close(); }
    let corruptRefused = false;
    try { await first.confirm(damaged, missingId); } catch { corruptRefused = true; }
    assert(corruptRefused, 'A pointer whose original intent is missing must not authorize replacement');
    assert(await second.find(damaged.requestId) === null, 'Corruption must not create a replacement intent');
    tests.push('corrupt saved pointer refuses replacement');

    const operation = { id: crypto.randomUUID(), requestId: current.requestId, profileName: current.profileName,
      profileInstanceId: current.profileInstanceId, requestedBy: `user:${current.accountId}`, direction: current.direction,
      amountPlur: current.amountPlur, chainId: 100, nodeAddress: `0x${'11'.repeat(20)}`,
      chequebookAddress: `0x${'22'.repeat(20)}`, tokenAddress: `0x${'33'.repeat(20)}` };
    const blocker = crypto.randomUUID();
    await first.recordBlocking(current.requestId, blocker);
    assert((await second.links(current.requestId)).own === null, 'A busy operation cannot create an own operation link');
    assert(await first.recordExact(current.requestId, operation), 'Exact immutable identity may record a navigation link');
    assert((await second.links(current.requestId)).own?.operationId === operation.id, 'Exact operation link must survive another connection');
    const originalLink = (await second.links(current.requestId)).own;
    for (const changed of [{ requestedBy: 'user:8' }, { amountPlur: '1' }, { profileInstanceId: replacementProfile.profileInstanceId },
      { requestId: crypto.randomUUID() }, { id: crypto.randomUUID() }, { nodeAddress: `0x${'44'.repeat(20)}` }]) {
      assert(!await first.recordExact(current.requestId, { ...operation, ...changed }), 'Contradictory identity cannot create or overwrite a link');
      assert(JSON.stringify((await second.links(current.requestId)).own) === JSON.stringify(originalLink), 'Conflicting evidence must retain the original navigation link');
    }
    await first.recordBlocking(current.requestId, crypto.randomUUID());
    assert((await second.links(current.requestId)).own?.operationId === operation.id, 'Busy evidence cannot replace a proven own link');
    assert((await second.related(current.accountId, operation.chainId, operation.nodeAddress)).some(link => link.requestId === current.requestId), 'Proven node identity can link related local intents');
    assert((await second.related(8, operation.chainId, operation.nodeAddress)).length === 0, 'Related links are scoped to the signed-in account');
    tests.push('exact observation links cannot be populated or replaced by busy or conflicting records');

    return { passed: tests.length, tests };
  } finally {
    await Promise.all([first.close(), second.close()]);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('The synthetic test database could not be removed'));
      request.onblocked = () => reject(new Error('The synthetic test database is still open'));
    });
  }
}
