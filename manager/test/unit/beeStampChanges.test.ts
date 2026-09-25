/**
 * The two requests the manager sends a Bee node to change a batch it holds.
 *
 * Unit test, no node: fetch is faked, so nothing reaches a Bee and no money
 * moves. `pnpm test` in manager/.
 *
 * Both are on-chain, and bee holds the request until it has a transaction to
 * answer with, so both get the budget buying a batch gets rather than the ten
 * seconds a read gets.
 */
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { BeeClient, ON_CHAIN_TIMEOUT_MS } from '../../src/domain/BeeClient.js';
import { BeeHttpError } from '../../src/domain/errors/index.js';

const NODE = 'http://127.0.0.1:10015';
const BATCH = 'a'.repeat(64);
const TX = `0x${'b'.repeat(64)}`;

interface SentRequest {
  url: string;
  method: string | undefined;
}

/** A node that answers every request with `status` and `body`, and remembers what it was sent. */
function fakeNode(
  t: TestContext,
  status = 202,
  body: unknown = { batchID: BATCH, txHash: TX },
) {
  const sent: SentRequest[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const timeout = t.mock.method(AbortSignal, 'timeout');
  return {
    sent,
    budgets: () => timeout.mock.calls.map((call) => call.arguments[0]),
  };
}

describe('changing a batch on its node', () => {
  it('tops up with a PATCH to /stamps/topup/{batch}/{amount}, on the on-chain budget', async (t) => {
    const node = fakeNode(t);

    const answer = await new BeeClient(NODE).topUpStamp(BATCH, '1571927040');

    assert.deepEqual(node.sent, [
      { url: `${NODE}/stamps/topup/${BATCH}/1571927040`, method: 'PATCH' },
    ]);
    assert.deepEqual(node.budgets(), [ON_CHAIN_TIMEOUT_MS]);
    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
  });

  it('dilutes with a PATCH to /stamps/dilute/{batch}/{depth}, on the on-chain budget', async (t) => {
    const node = fakeNode(t);

    const answer = await new BeeClient(NODE).diluteStamp(BATCH, 24);

    assert.deepEqual(node.sent, [
      { url: `${NODE}/stamps/dilute/${BATCH}/24`, method: 'PATCH' },
    ]);
    assert.deepEqual(node.budgets(), [ON_CHAIN_TIMEOUT_MS]);
    assert.deepEqual(answer, { batchID: BATCH, txHash: TX });
  });

  it('gives a refusal the status bee answered with', async (t) => {
    fakeNode(t, 402, { code: 402, message: 'out of funds' });

    await assert.rejects(
      () => new BeeClient(NODE).topUpStamp(BATCH, '1571927040'),
      (err: unknown) =>
        err instanceof BeeHttpError && err.status === 402 && /out of funds/.test(err.message),
    );
  });
});
