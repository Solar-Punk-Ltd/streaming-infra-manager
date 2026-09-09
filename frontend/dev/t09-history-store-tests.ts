import { IndexedDbTransferIntentStore, type StoredTransferIntent } from '../src/transfers/transferIntentStore';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const instanceId = '11111111-1111-4111-8111-111111111111';
const requestId = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

export async function runHistoryStoreTests() {
  const name = `t09-history-store-${crypto.randomUUID()}`;
  const store = new IndexedDbTransferIntentStore(indexedDB, name);
  const pointers = new Map<number, string>();
  try {
    for (let number = 1; number <= 502; number++) {
      const accountId = number <= 500 ? 8 : 7;
      const input: StoredTransferIntent = { requestId: requestId(number), accountId, profileName: 'removed-profile', profileInstanceId: instanceId,
        direction: 'deposit', amountPlur: '5000000000000000', createdAt: '2026-09-08T00:00:00.000Z' };
      await store.confirm(input, pointers.get(accountId) ?? null);
      pointers.set(accountId, input.requestId);
    }
    const transactions: string[] = [];
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      transactions.push(args[1] ?? 'readonly');
      return original.apply(this, args);
    };
    try {
      const first = await store.list(7, { limit: 1 });
      assert(first.intents.length === 0 && first.nextCursor !== null, '500 foreign records must yield continuation, not false exhaustion');
      const second = await store.list(7, { limit: 1, cursor: first.nextCursor });
      assert(second.intents.length === 1 && second.intents[0].requestId === requestId(501), 'Continuation must not skip the first matching request');
      assert(second.nextCursor !== null, 'The second matching request stays reachable');
      const third = await store.list(7, { limit: 1, cursor: second.nextCursor });
      assert(third.intents.length === 1 && third.intents[0].requestId === requestId(502) && third.nextCursor === null, 'Final matching request ends the scan');
      for (const [account, options] of [[8, { cursor: first.nextCursor }], [7, { cursor: 'broken' }], [7, { limit: 0 }], [7, { limit: 101 }]] as const) {
        let refused = false;
        try { await store.list(account, options); } catch { refused = true; }
        assert(refused, 'Malformed or cross-account pagination must be refused');
      }
      assert((await store.current(7, instanceId))?.requestId === requestId(502), 'Reading cannot replace the account7 pointer');
      assert((await store.current(8, instanceId))?.requestId === requestId(500), 'Reading cannot replace the account8 pointer');
      assert(transactions.every(mode => mode === 'readonly'), 'History listing must not write pointers or observation links');
    } finally { IDBDatabase.prototype.transaction = original; }
    return { passed: 1 };
  } finally {
    await store.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(); request.onerror = () => reject(new Error('Synthetic history cleanup failed'));
    });
  }
}
