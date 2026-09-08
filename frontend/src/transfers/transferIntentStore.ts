import type { ChequebookOperation, TransferDirection } from '@streaming-infra-manager/common';

export interface ConfirmedTransferInput {
  readonly requestId: string;
  readonly accountId: number;
  readonly profileName: string;
  readonly profileInstanceId: string;
  readonly direction: TransferDirection;
  readonly amountPlur: string;
  readonly createdAt: string;
}

export type StoredTransferIntent = ConfirmedTransferInput;
export type LinkedOperation = Pick<ChequebookOperation, 'id' | 'requestId' | 'profileName' | 'profileInstanceId' | 'requestedBy' |
  'direction' | 'amountPlur' | 'chainId' | 'nodeAddress' | 'chequebookAddress' | 'tokenAddress'>;
export interface ProvenTransferLink {
  readonly requestId: string;
  readonly accountId: number;
  readonly operationId: string;
  readonly chainId: number;
  readonly nodeAddress: string;
  readonly chequebookAddress: string;
  readonly tokenAddress: string;
}
export interface TransferObservationLinks {
  readonly own: ProvenTransferLink | null;
  readonly blockingOperationId: string | null;
}
export type ConfirmedTransferResult = {
  readonly kind: 'created' | 'existing';
  readonly intent: StoredTransferIntent;
};

export interface TransferIntentStore {
  confirm(input: ConfirmedTransferInput, expectedCurrentRequestId: string | null): Promise<ConfirmedTransferResult>;
  current(accountId: number, profileInstanceId: string): Promise<StoredTransferIntent | null>;
  find(requestId: string): Promise<StoredTransferIntent | null>;
  recordExact(requestId: string, operation: LinkedOperation): Promise<boolean>;
  recordBlocking(requestId: string, operationId: string): Promise<void>;
  links(requestId: string): Promise<TransferObservationLinks>;
  related(accountId: number, chainId: number, nodeAddress: string): Promise<readonly ProvenTransferLink[]>;
}

export class TransferPersistenceError extends Error {
  constructor() {
    super('This browser could not safely read or save the transfer. Sending is paused. Check saved transfers before trying again.');
    this.name = 'TransferPersistenceError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENTS = 'intents';
const POINTERS = 'pointers';
const LINKS = 'links';
const BY_NODE = 'byNode';
const DATABASE_NAME = 'streaming-infra-transfer-intents';
type IntentPointer = { readonly scope: string; readonly requestId: string };
type LinkRecord = { readonly requestId: string; readonly own: ProvenTransferLink | null; readonly blockingOperationId: string | null;
  readonly nodeKey?: [number, number, string] };

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TransferPersistenceError();
  return value;
}

function scopeOf(accountId: number, profileInstanceId: string): string {
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new TransferPersistenceError();
  return JSON.stringify([accountId, uuid(profileInstanceId)]);
}

function savedIntent(value: unknown): StoredTransferIntent {
  if (!value || typeof value !== 'object') throw new TransferPersistenceError();
  const input = value as ConfirmedTransferInput;
  scopeOf(input.accountId, input.profileInstanceId);
  if (typeof input.profileName !== 'string' || !input.profileName.trim() || input.profileName.length > 200 ||
      !['deposit', 'withdraw'].includes(input.direction) || typeof input.amountPlur !== 'string' || !/^[1-9][0-9]{0,29}$/.test(input.amountPlur) ||
      typeof input.createdAt !== 'string' || input.createdAt.length > 40 || !Number.isFinite(Date.parse(input.createdAt))) throw new TransferPersistenceError();
  return Object.freeze({ requestId: uuid(input.requestId), accountId: input.accountId, profileName: input.profileName,
    profileInstanceId: input.profileInstanceId, direction: input.direction, amountPlur: input.amountPlur, createdAt: input.createdAt });
}

function sameIntent(a: StoredTransferIntent, b: StoredTransferIntent): boolean {
  return a.requestId === b.requestId && a.accountId === b.accountId && a.profileName === b.profileName &&
    a.profileInstanceId === b.profileInstanceId && a.direction === b.direction && a.amountPlur === b.amountPlur && a.createdAt === b.createdAt;
}

export function isExactTransfer(intent: StoredTransferIntent, operation: LinkedOperation): boolean {
  return operation.requestId === intent.requestId && operation.requestedBy === `user:${intent.accountId}` &&
    operation.profileName === intent.profileName && operation.profileInstanceId === intent.profileInstanceId &&
    operation.direction === intent.direction && operation.amountPlur === intent.amountPlur;
}

function provenLink(value: unknown): ProvenTransferLink | null {
  if (!value || typeof value !== 'object') return null;
  const link = value as ProvenTransferLink;
  if (!Number.isSafeInteger(link.accountId) || link.accountId < 1 || !Number.isSafeInteger(link.chainId) || link.chainId < 1 ||
      ![link.requestId, link.operationId].every(value => typeof value === 'string' && UUID.test(value)) ||
      ![link.nodeAddress, link.chequebookAddress, link.tokenAddress].every(value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value))) return null;
  return Object.freeze({ requestId: link.requestId, accountId: link.accountId, operationId: link.operationId,
    chainId: link.chainId, nodeAddress: link.nodeAddress, chequebookAddress: link.chequebookAddress, tokenAddress: link.tokenAddress });
}

/** Read/CAS/write stays inside native request callbacks. Only transaction completion grants the caller a send permit. */
export class IndexedDbTransferIntentStore implements TransferIntentStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory, private readonly name = DATABASE_NAME) {}

  async confirm(input: ConfirmedTransferInput, expectedCurrentRequestId: string | null): Promise<ConfirmedTransferResult> {
    const intent = savedIntent(input);
    const scope = scopeOf(intent.accountId, intent.profileInstanceId);
    if (expectedCurrentRequestId !== null) uuid(expectedCurrentRequestId);
    return this.transaction('readwrite', (transaction, complete) => {
      const intents = transaction.objectStore(INTENTS);
      const pointers = transaction.objectStore(POINTERS);
      const pointerRequest = pointers.get(scope);
      pointerRequest.onsuccess = () => {
        this.inside(transaction, () => {
          const pointer = this.pointer(pointerRequest.result, scope);
          const actual = pointer?.requestId ?? null;
          if (actual !== expectedCurrentRequestId) {
            if (!pointer) throw new TransferPersistenceError();
            const current = intents.get(pointer.requestId);
            current.onsuccess = () => this.inside(transaction, () => complete({ kind: 'existing', intent: this.forScope(current.result, scope) }));
            return;
          }
          const writeIntent = () => {
            const existing = intents.get(intent.requestId);
            existing.onsuccess = () => this.inside(transaction, () => {
              if (existing.result !== undefined) {
                const saved = savedIntent(existing.result);
                if (!sameIntent(saved, intent) || saved.requestId !== actual) throw new TransferPersistenceError();
                complete({ kind: 'existing', intent: saved });
                return;
              }
              intents.add(intent);
              pointers.put({ scope, requestId: intent.requestId } satisfies IntentPointer);
              complete({ kind: 'created', intent });
            });
          };
          if (pointer) {
            const previous = intents.get(pointer.requestId);
            previous.onsuccess = () => this.inside(transaction, () => { this.forScope(previous.result, scope); writeIntent(); });
          } else writeIntent();
        });
      };
    });
  }

  async current(accountId: number, profileInstanceId: string): Promise<StoredTransferIntent | null> {
    const scope = scopeOf(accountId, profileInstanceId);
    return this.transaction('readonly', (transaction, complete) => {
      const request = transaction.objectStore(POINTERS).get(scope);
      request.onsuccess = () => this.inside(transaction, () => {
        const pointer = this.pointer(request.result, scope);
        if (!pointer) { complete(null); return; }
        const intent = transaction.objectStore(INTENTS).get(pointer.requestId);
        intent.onsuccess = () => this.inside(transaction, () => complete(this.forScope(intent.result, scope)));
      });
    });
  }

  async find(requestId: string): Promise<StoredTransferIntent | null> {
    uuid(requestId);
    return this.transaction('readonly', (transaction, complete) => {
      const request = transaction.objectStore(INTENTS).get(requestId);
      request.onsuccess = () => this.inside(transaction, () => complete(request.result === undefined ? null : savedIntent(request.result)));
    });
  }

  async recordExact(requestId: string, operation: LinkedOperation): Promise<boolean> {
    uuid(requestId);
    return this.transaction('readwrite', (transaction, complete) => {
      const saved = transaction.objectStore(INTENTS).get(requestId);
      saved.onsuccess = () => this.inside(transaction, () => {
        const intent = savedIntent(saved.result);
        const link = provenLink({ requestId, accountId: intent.accountId, operationId: operation.id, chainId: operation.chainId,
          nodeAddress: operation.nodeAddress, chequebookAddress: operation.chequebookAddress, tokenAddress: operation.tokenAddress });
        if (!link || !isExactTransfer(intent, operation)) { complete(false); return; }
        const existing = transaction.objectStore(LINKS).get(requestId);
        existing.onsuccess = () => this.inside(transaction, () => {
          const record = existing.result as LinkRecord | undefined;
          const previous = provenLink(record?.own);
          if (record?.own && (!previous || JSON.stringify(previous) !== JSON.stringify(link))) { complete(false); return; }
          transaction.objectStore(LINKS).put({ requestId, own: link,
            blockingOperationId: typeof record?.blockingOperationId === 'string' && UUID.test(record.blockingOperationId) ? record.blockingOperationId : null,
            nodeKey: [link.accountId, link.chainId, link.nodeAddress] } satisfies LinkRecord);
          complete(true);
        });
      });
    });
  }

  async recordBlocking(requestId: string, operationId: string): Promise<void> {
    uuid(requestId); uuid(operationId);
    return this.transaction('readwrite', (transaction, complete) => {
      const saved = transaction.objectStore(INTENTS).get(requestId);
      saved.onsuccess = () => this.inside(transaction, () => {
        savedIntent(saved.result);
        const request = transaction.objectStore(LINKS).get(requestId);
        request.onsuccess = () => this.inside(transaction, () => {
          const previous = request.result as LinkRecord | undefined;
          const own = provenLink(previous?.own);
          if (previous?.own && (!own || own.requestId !== requestId)) { complete(); return; }
          transaction.objectStore(LINKS).put({ requestId, own, blockingOperationId: operationId,
            ...(own ? { nodeKey: [own.accountId, own.chainId, own.nodeAddress] } : {}) } satisfies LinkRecord);
          complete();
        });
      });
    });
  }

  async links(requestId: string): Promise<TransferObservationLinks> {
    uuid(requestId);
    return this.transaction('readonly', (transaction, complete) => {
      const request = transaction.objectStore(LINKS).get(requestId);
      request.onsuccess = () => this.inside(transaction, () => {
        const value = request.result as LinkRecord | undefined;
        const own = provenLink(value?.own);
        complete({ own: own?.requestId === requestId ? own : null,
          blockingOperationId: typeof value?.blockingOperationId === 'string' && UUID.test(value.blockingOperationId) ? value.blockingOperationId : null });
      });
    });
  }

  async related(accountId: number, chainId: number, nodeAddress: string): Promise<readonly ProvenTransferLink[]> {
    if (!Number.isSafeInteger(accountId) || accountId < 1 || !Number.isSafeInteger(chainId) || chainId < 1 || !/^0x[0-9a-f]{40}$/.test(nodeAddress)) throw new TransferPersistenceError();
    return this.transaction('readonly', (transaction, complete) => {
      const request = transaction.objectStore(LINKS).index(BY_NODE).getAll([accountId, chainId, nodeAddress]);
      request.onsuccess = () => this.inside(transaction, () => complete((request.result as LinkRecord[]).flatMap(record => {
        const link = provenLink(record.own);
        return link?.requestId === record.requestId && link.accountId === accountId && link.chainId === chainId && link.nodeAddress === nodeAddress ? [link] : [];
      })));
    });
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    if (database) (await database).close();
  }

  private pointer(value: unknown, scope: string): IntentPointer | null {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || (value as IntentPointer).scope !== scope) throw new TransferPersistenceError();
    return { scope, requestId: uuid((value as IntentPointer).requestId) };
  }

  private forScope(value: unknown, scope: string): StoredTransferIntent {
    const intent = savedIntent(value);
    if (scopeOf(intent.accountId, intent.profileInstanceId) !== scope) throw new TransferPersistenceError();
    return intent;
  }

  private inside(transaction: IDBTransaction, action: () => void): void {
    try { action(); } catch { transaction.abort(); }
  }

  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise((resolve, reject) => {
      let refused = false;
      const refuse = () => { refused = true; reject(new TransferPersistenceError()); };
      let request: IDBOpenDBRequest;
      try { request = this.factory.open(this.name, 2); } catch { refuse(); return; }
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(INTENTS)) request.result.createObjectStore(INTENTS, { keyPath: 'requestId' });
          if (!request.result.objectStoreNames.contains(POINTERS)) request.result.createObjectStore(POINTERS, { keyPath: 'scope' });
          if (!request.result.objectStoreNames.contains(LINKS)) request.result.createObjectStore(LINKS, { keyPath: 'requestId' }).createIndex(BY_NODE, 'nodeKey');
        } catch { request.transaction?.abort(); }
      };
      request.onerror = refuse;
      request.onblocked = refuse;
      request.onsuccess = () => {
        if (refused) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
    return this.database;
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (transaction: IDBTransaction, complete: (value: T) => void) => void): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = database.transaction([INTENTS, POINTERS, LINKS], mode, { durability: 'strict' }); }
      catch { reject(new TransferPersistenceError()); return; }
      let hasResult = false;
      let result: T;
      transaction.oncomplete = () => hasResult ? resolve(result) : reject(new TransferPersistenceError());
      transaction.onabort = () => reject(new TransferPersistenceError());
      transaction.onerror = () => reject(new TransferPersistenceError());
      this.inside(transaction, () => action(transaction, value => { result = value; hasResult = true; }));
    });
  }
}
