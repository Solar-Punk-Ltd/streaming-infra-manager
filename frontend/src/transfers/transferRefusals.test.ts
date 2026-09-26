/**
 * The page says why the manager refused a transfer.
 *
 * A refusal before the transfer was recorded arrives as a 503 carrying a cause
 * from the shared closed list, and the page shows that cause's sentence. A
 * refusal by the last check before sending arrives as a recorded operation,
 * and the page shows the sentence for its reason. A cause outside the list is
 * never shown: the page keeps its old unavailable wording rather than echo it.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { BEE_BRIDGE_CHECKS, CHEQUEBOOK_PREFLIGHT_REFUSALS, CHEQUEBOOK_REFUSAL_CAUSES,
  chequebookPreflightSentence, chequebookRefusalSentence, type ChequebookOperation, type ChequebookRefusal } from '@streaming-infra-manager/common';
import { TransferApiError } from './TransferApiError';
import { TransferController } from './TransferController';
import { transferApi } from './transferApi';
import { operationRefusalSentence, transferIssueMessage, TRANSFER_MESSAGES } from './transferMessages';
import type { StoredTransferIntent, TransferIntentStore } from './transferIntentStore';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function answer(status: number, body: unknown): void {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const intent: StoredTransferIntent = { requestId: '22222222-2222-4222-8222-222222222222', accountId: 7, profileName: 'synthetic-test',
  profileInstanceId: '33333333-3333-4333-8333-333333333333', direction: 'deposit', amountPlur: '5000000000000000', createdAt: '2026-09-26T00:00:00.000Z' };
const everyRefusal = (): ChequebookRefusal[] => [
  ...CHEQUEBOOK_REFUSAL_CAUSES.map(cause => ({ cause, check: null })),
  ...BEE_BRIDGE_CHECKS.map(check => ({ cause: 'bridge_not_qualified' as const, check })),
];
const refusedBody = (refusal: ChequebookRefusal) => ({ error: 'chequebook_preparation_unavailable', ...refusal, message: 'the manager\'s own sentence' });

describe('the transfer API reads a refused submission', () => {
  it('turns every cause the manager can answer into a refusal the page can name', async () => {
    for (const refusal of everyRefusal()) {
      answer(503, refusedBody(refusal));
      await assert.rejects(transferApi.submit(intent, new AbortController().signal), error => {
        assert.ok(error instanceof TransferApiError);
        assert.equal(error.reason, 'preparation_refused');
        assert.deepEqual(error.refusal, refusal);
        return true;
      });
    }
  });

  it('never carries a cause from outside the list, and keeps the old unavailable wording for it', async () => {
    for (const body of [{ error: 'chequebook_preparation_unavailable', cause: 'connect ECONNREFUSED 10.0.0.7:2375', check: null },
      { error: 'chequebook_preparation_unavailable', cause: 'docker_unreachable', check: 'bash' },
      { error: 'chequebook_preparation_unavailable' }, { error: 'chequebook_journal_unavailable', cause: 'docker_unreachable', check: null }]) {
      answer(503, body);
      await assert.rejects(transferApi.submit(intent, new AbortController().signal), error => {
        assert.ok(error instanceof TransferApiError);
        assert.equal(error.reason, 'unavailable');
        assert.equal(error.refusal, null);
        return true;
      });
    }
  });
});

describe('the transfer controller keeps the refusal for the page', () => {
  it('shows a refused submission as a named refusal, with the saved request kept', async () => {
    const store = {
      async current() { return null; },
      async confirm(input: StoredTransferIntent) { return { kind: 'created', intent: input }; },
      async recordExact() { return { kind: 'recorded' }; },
      async recordBlocking() {},
    } as unknown as TransferIntentStore;
    const refusal: ChequebookRefusal = { cause: 'bridge_not_qualified', check: 'dev_tcp' };
    const controller = new TransferController(store, {
      async lookup() { return null; },
      async profile() { return { name: intent.profileName, instanceId: intent.profileInstanceId }; },
      async submit() { throw new TransferApiError('preparation_refused', refusal); },
    }, () => intent.requestId);
    controller.setContext(7, { name: intent.profileName, instanceId: intent.profileInstanceId });
    await controller.confirmNew({ direction: 'deposit', amountPlur: intent.amountPlur }, null);
    assert.equal(controller.state.issue, 'preparation_refused');
    assert.deepEqual(controller.state.refusal, refusal);
    assert.equal(controller.state.intent?.requestId, intent.requestId);
    assert.equal(transferIssueMessage(controller.state.issue!, controller.state.refusal), chequebookRefusalSentence(refusal));
  });
});

describe('the words for an issue or a refused operation', () => {
  it('uses the refusal\'s own sentence for a refused submission and the fixed message for everything else', () => {
    for (const refusal of everyRefusal()) assert.equal(transferIssueMessage('preparation_refused', refusal), chequebookRefusalSentence(refusal));
    assert.equal(transferIssueMessage('preparation_refused', null), TRANSFER_MESSAGES.preparation_refused);
    assert.equal(transferIssueMessage('busy', null), TRANSFER_MESSAGES.busy);
  });

  it('says why the last check refused a recorded transfer, for each reason and direction', () => {
    const operation = { direction: 'deposit', state: 'rejected', failureReason: 'preflight_no_gas' } as ChequebookOperation;
    for (const failureReason of CHEQUEBOOK_PREFLIGHT_REFUSALS) {
      for (const direction of ['deposit', 'withdraw'] as const) {
        assert.equal(operationRefusalSentence({ ...operation, failureReason, direction }), chequebookPreflightSentence(failureReason, direction));
      }
    }
    assert.equal(operationRefusalSentence({ ...operation, state: 'unknown', failureReason: 'response_unavailable' }), null);
    assert.equal(operationRefusalSentence({ ...operation, state: 'settled', failureReason: null }), null);
  });
});
