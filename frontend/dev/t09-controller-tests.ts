import { TransferController } from '../src/transfers/TransferController';
import { IndexedDbTransferIntentStore } from '../src/transfers/transferIntentStore';
import { permitsNewTransfer, transferHeadline } from '../src/transfers/transferEvidence';
import { chequebookAssertionConfirmation, type ChequebookAdmissionDetail, type ChequebookOperationDetail } from '@streaming-infra-manager/common';

const profile = { name: 'synthetic-test', instanceId: '11111111-1111-4111-8111-111111111111' };
const draft = { direction: 'deposit' as const, amountPlur: '5000000000000000' };
const finalized = { kind: 'settled' as const, receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function detail(intent: { requestId: string; accountId: number; profileName: string; profileInstanceId: string; direction: 'deposit' | 'withdraw'; amountPlur: string },
  state: ChequebookOperationDetail['operation']['state'] = 'submitted'): ChequebookOperationDetail {
  return { operation: { id: crypto.randomUUID(), requestId: intent.requestId, requestedBy: `user:${intent.accountId}`, profileName: intent.profileName,
    profileInstanceId: intent.profileInstanceId, direction: intent.direction, amountPlur: intent.amountPlur, state,
    chainId: 100, nodeAddress: `0x${'11'.repeat(20)}`, chequebookAddress: `0x${'22'.repeat(20)}`, tokenAddress: `0x${'33'.repeat(20)}`,
    startBlockNumber: '500', startBlockHash: `0x${'44'.repeat(32)}`, nonceLowerBound: '9', nonceQueryTag: '0x1f4',
    transactionHash: `0x${'55'.repeat(32)}`, failureReason: null, revision: '0', dispatchStartedAt: '2026-09-08T00:00:00.000Z',
    receiptObservation: null, receiptCheckedAt: null, recoveryObservation: null, recoveryCheckedAt: null, assertion: null,
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' }, responseEvidence: [],
    assertionConfirmation: chequebookAssertionConfirmation(intent.amountPlur) };
}

export async function runControllerTests(): Promise<{ passed: number; tests: string[] }> {
  const tests: string[] = [];
  async function fixture() {
    const name = `t09-controller-${crypto.randomUUID()}`;
    const store = new IndexedDbTransferIntentStore(indexedDB, name);
    const observed = new IndexedDbTransferIntentStore(indexedDB, name);
    const requests: string[] = [];
    let record: ChequebookOperationDetail | null = null;
    let currentProfile: typeof profile | null = profile;
    let loseResponse = false;
    let busy = false;
    let generated = 0;
    const api = {
      async lookup() { return record; },
      async profile() { return currentProfile; },
      async submit(intent: Parameters<typeof detail>[0]): Promise<ChequebookAdmissionDetail> {
        assert((await observed.find(intent.requestId))?.requestId === intent.requestId, 'POST must wait for durable intent completion');
        requests.push(intent.requestId);
        if (loseResponse) throw new Error('Synthetic lost response');
        if (busy) return { ...detail({ ...intent, requestId: crypto.randomUUID() }), kind: 'busy' };
        record = detail(intent);
        return { ...record, kind: 'admitted' };
      },
    };
    const controller = new TransferController(store, api, () => { generated++; return crypto.randomUUID(); });
    controller.setContext(7, profile);
    return { store, api, controller, requests, generated: () => generated, setRecord(value: ChequebookOperationDetail | null) { record = value; },
      lose(value: boolean) { loseResponse = value; }, busy(value: boolean) { busy = value; }, replace(value: typeof profile | null) { currentProfile = value; },
      async close() {
        controller.cancel();
        await Promise.all([store.close(), observed.close()]);
        await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(new Error('Synthetic cleanup failed')); });
      } };
  }

  let h = await fixture();
  try {
    await h.controller.confirmNew(draft, null);
    assert(h.requests.length === 1 && h.controller.state.detail?.operation.state === 'submitted', 'Initial confirmation sends once after persistence');
    const intent = h.controller.state.intent!;
    assert((await h.store.links(intent.requestId)).own?.operationId === h.controller.state.detail?.operation.id, 'Exact response may add a navigation link');
    await h.controller.restore();
    assert(h.requests.length === 1 && h.controller.state.intent?.requestId === intent.requestId, 'Restore must GET the original record without sending');
    tests.push('durable intent precedes POST and restore does not resend');
  } finally { await h.close(); }

  h = await fixture();
  try {
    h.lose(true);
    await h.controller.confirmNew(draft, null);
    const id = h.controller.state.intent!.requestId;
    assert(h.controller.state.issue === 'response_unknown', 'Lost response remains unknown');
    assert((await h.store.links(id)).own === null, 'Lost response needs no operation link');
    const restored = new TransferController(h.store, h.api);
    restored.setContext(7, profile);
    await restored.restore(); await restored.restore();
    assert(restored.state.intent?.requestId === id && h.requests.length === 1 && h.generated() === 1, 'Repeated404 preserves one UUID and never resends');
    h.lose(false);
    await restored.retryExact();
    assert(h.requests.length === 2 && h.requests.every(request => request === id), 'Explicit retry uses only the original UUID');
    restored.cancel();
    tests.push('lost response and repeated404 recover exactly before explicit same-ID retry');
  } finally { await h.close(); }

  h = await fixture();
  try {
    h.busy(true);
    await h.controller.confirmNew(draft, null);
    const intent = h.controller.state.intent!;
    assert(h.controller.state.blocking !== null && h.controller.state.detail === null, 'Busy operation must be displayed separately');
    assert(h.controller.state.blocking!.operation.requestId !== intent.requestId, 'Busy identity must not replace the immutable local UUID');
    assert((await h.store.links(intent.requestId)).own === null, 'Busy response cannot populate the own link');
    h.setRecord(detail(intent));
    await h.controller.restore();
    assert(h.controller.state.detail?.operation.requestId === intent.requestId && h.requests.length === 1, 'Exact lookup recovers own record after busy without sending');
    tests.push('busy response stays separate from exact intent recovery');
  } finally { await h.close(); }

  h = await fixture();
  try {
    await h.controller.confirmNew(draft, null);
    const intent = h.controller.state.intent!;
    const settled = { ...h.controller.state.detail!, operation: { ...h.controller.state.detail!.operation, state: 'settled' as const, receiptObservation: finalized } };
    h.setRecord(settled);
    await h.controller.restore();
    h.setRecord({ ...settled, responseEvidence: [{ transactionHash: `0x${'66'.repeat(32)}`, receivedAt: '2026-09-08T00:00:00.000Z', ownership: 'conflict' }] });
    await h.controller.confirmNew(draft, intent.requestId);
    assert(h.requests.length === 1 && h.generated() === 1 && h.controller.state.intent?.requestId === intent.requestId, 'Fresh conflicting evidence must refuse replacement of a previously settled intent');
    h.setRecord({ operation: settled.operation } as ChequebookOperationDetail);
    await h.controller.confirmNew(draft, intent.requestId);
    assert(h.requests.length === 1 && h.generated() === 1, 'History summaries without complete response evidence cannot authorize replacement');
    for (const patch of [{ receiptObservation: null }, { transactionHash: null },
      { receiptObservation: { ...finalized, kind: 'reverted' as const } }, { receiptObservation: { ...finalized, finalizedBlockNumber: '499' } }]) {
      h.setRecord({ ...settled, operation: { ...settled.operation, ...patch } });
      await h.controller.confirmNew(draft, intent.requestId);
      assert(h.requests.length === 1 && h.generated() === 1, 'A terminal label with missing or inconsistent receipt evidence cannot authorize replacement');
    }
    h.setRecord(settled);
    await h.controller.confirmNew(draft, intent.requestId);
    assert(h.requests.length === 2 && h.requests[1] !== intent.requestId, 'Explicit confirmation may replace a fresh exact terminal record');
    tests.push('replacement requires fresh complete conflict-free exact terminal evidence');
  } finally { await h.close(); }

  for (const change of ['logout', 'replacement', 'cancel'] as const) {
    h = await fixture();
    try {
      const committed = deferred<void>();
      const release = deferred<void>();
      const confirm = h.store.confirm.bind(h.store);
      h.store.confirm = async (...args) => { const result = await confirm(...args); committed.resolve(); await release.promise; return result; };
      const pending = h.controller.confirmNew(draft, null);
      await committed.promise;
      if (change === 'logout') h.controller.setContext(null, null);
      if (change === 'replacement') h.controller.setContext(7, { ...profile, instanceId: '22222222-2222-4222-8222-222222222222' });
      if (change === 'cancel') h.controller.cancel();
      release.resolve(); await pending;
      assert(h.requests.length === 0, `Late store completion after ${change} must not send`);
      assert(await h.store.current(7, profile.instanceId) !== null, 'Cancellation retains the confirmed UUID');
      tests.push(`late durable completion after ${change} cannot dispatch`);
    } finally { await h.close(); }
  }

  h = await fixture();
  try {
    h.replace({ ...profile, instanceId: '22222222-2222-4222-8222-222222222222' });
    await h.controller.confirmNew(draft, null);
    assert(h.requests.length === 0 && h.controller.state.issue === 'target_changed', 'Fresh profile check refuses a replaced target after saving intent');
    assert(h.controller.state.intent !== null, 'Target refusal retains the original immutable intent');
    tests.push('profile recreation after persistence refuses dispatch without replacing the UUID');
  } finally { await h.close(); }

  h = await fixture();
  try {
    h.store.confirm = async () => { throw new Error('Synthetic quota failure'); };
    await h.controller.confirmNew(draft, null);
    assert(h.requests.length === 0 && h.controller.state.issue === 'storage_unavailable', 'Persistence failure refuses sending');
    tests.push('persistence failure refuses dispatch');
  } finally { await h.close(); }

  const asserted = detail({ requestId: crypto.randomUUID(), accountId: 7, profileName: profile.name,
    profileInstanceId: profile.instanceId, ...draft }, 'asserted');
  assert(transferHeadline(asserted) === 'Operator assertion recorded', 'Assertion label remains prominent when older observations are unavailable');
  assert(!permitsNewTransfer(asserted), 'A state string without the saved assertion cannot authorize replacement');
  const confirmedAssertion = { ...asserted, operation: { ...asserted.operation, transactionHash: null,
    assertion: { actor: 'user:7', amountPlur: draft.amountPlur, confirmation: asserted.assertionConfirmation, assertedAt: '2026-09-08T00:00:00.000Z' } } };
  assert(permitsNewTransfer(confirmedAssertion), 'Exact recorded assertion may support the explicitly accepted duplicate-payment risk');
  const conflictingAssertion = { ...confirmedAssertion, responseEvidence: [{ transactionHash: `0x${'99'.repeat(32)}`, receivedAt: '2026-09-08T00:00:00.000Z', ownership: 'conflict' as const }] };
  assert(transferHeadline(conflictingAssertion) === 'Transaction evidence needs review' && !permitsNewTransfer(conflictingAssertion), 'Conflict evidence takes precedence over a terminal assertion');
  const rejected = { ...asserted, operation: { ...asserted.operation, state: 'rejected' as const, transactionHash: null,
    dispatchStartedAt: null, failureReason: 'preflight_failed' as const } };
  assert(permitsNewTransfer(rejected), 'A recorded preflight refusal with no dispatch may support replacement');
  assert(!permitsNewTransfer({ ...rejected, operation: { ...rejected.operation, dispatchStartedAt: '2026-09-08T00:00:00.000Z' } }), 'A dispatched operation cannot be treated as a preflight refusal');
  tests.push('terminal actions and labels depend on consistent receipt, refusal or assertion evidence');
  return { passed: tests.length, tests };
}
