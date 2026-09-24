/**
 * The two requests the Storage card sends to change a batch its node holds.
 *
 * Unit test, no manager: fetch is faked, so nothing leaves the process and no
 * money moves.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { diluteStamp, topUpStamp } from './stampApi';

const globals = globalThis as { fetch: typeof fetch };
const browserFetch = globals.fetch;

afterEach(() => {
  globals.fetch = browserFetch;
});

const BATCH = 'a'.repeat(64);
const TX = `0x${'b'.repeat(64)}`;

interface SentRequest {
  path: string;
  method: string | undefined;
  body: unknown;
}

/** A manager that answers every write with bee's transaction, and remembers what it was sent. */
function recordRequests(): SentRequest[] {
  const sent: SentRequest[] = [];
  globals.fetch = (async (path: string, init?: RequestInit) => {
    sent.push({
      path,
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ batchID: BATCH, txHash: TX }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return sent;
}

describe('changing a batch from the page', () => {
  it('asks the manager to top the batch up by the amount, and hands back the transaction', async () => {
    const sent = recordRequests();

    const answer = await topUpStamp('main-stage', { batch_id: BATCH, amount: '1571927040' });

    assert.deepEqual(sent, [
      {
        path: '/profiles/main-stage/stamp/topup',
        method: 'POST',
        body: { batch_id: BATCH, amount: '1571927040' },
      },
    ]);
    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
  });

  it('asks the manager to dilute the batch to the depth, and hands back the transaction', async () => {
    const sent = recordRequests();

    const answer = await diluteStamp('main-stage', { batch_id: BATCH, depth: 24 });

    assert.deepEqual(sent, [
      {
        path: '/profiles/main-stage/stamp/dilute',
        method: 'POST',
        body: { batch_id: BATCH, depth: 24 },
      },
    ]);
    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
  });
});
