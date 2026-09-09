import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createProtocolClient, launchChrome, waitFor } from './support/chrome.mjs';

const origin = 'http://127.0.0.1:54291';
test('the transfer controller preserves intent through lost responses, auth and target changes', async t => {
  const browser = await launchChrome(t, origin);
  await browser.call('Page.navigate', { url: `${origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate("typeof document.querySelector('#controller')?.onclick === 'function'"));
  await browser.evaluate("document.querySelector('#controller').click()");
  const result = await waitFor(() => browser.evaluate("document.querySelector('#result').textContent"),
    value => value !== 'Ready' && value !== 'Running', 'controller test result');
  assert.ok(!result.startsWith('FAILED:'), result);
  assert.equal(JSON.parse(result).passed, 10);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

test('native IndexedDB keeps one immutable intent across concurrent browser connections', async t => {
  const browser = await launchChrome(t, origin);
  await browser.call('Page.navigate', { url: `${origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
  await browser.evaluate("document.querySelector('#run').click()");
  const result = await waitFor(() => browser.evaluate("document.querySelector('#result').textContent"),
    value => value !== 'Ready' && value !== 'Running', 'native intent test result');
  assert.ok(!result.startsWith('FAILED:'), result);
  assert.equal(JSON.parse(result).passed, 9);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  t.diagnostic(`Verified ${browser.version} with an isolated temporary profile`);
});

async function anotherTab(t, browser) {
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  const tabs = await fetch(`http://127.0.0.1:${browser.debuggingPort}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const socket = new WebSocket(tabs.find(tab => tab.id === targetId).webSocketDebuggerUrl);
  t.after(() => socket.close());
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  const { call } = createProtocolClient(socket);
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    void call(new URL(request.url).origin === origin ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      new URL(request.url).origin === origin ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  });
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return { call, async evaluate(expression) {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  } };
}

test('two real tabs cannot replace each other’s confirmed intent after reload or terminal navigation', async t => {
  const first = await launchChrome(t, origin);
  const second = await anotherTab(t, first);
  const name = `t09-tabs-${crypto.randomUUID()}`;
  const setup = `(async () => {
    const { IndexedDbTransferIntentStore: Store } = await import('/src/transfers/transferIntentStore.ts');
    globalThis.store = new Store(indexedDB, ${JSON.stringify(name)});
    globalThis.input = { requestId: crypto.randomUUID(), accountId: 7, profileName: 'synthetic-test',
      profileInstanceId: '11111111-1111-4111-8111-111111111111', direction: 'deposit',
      amountPlur: '5000000000000000', createdAt: '2026-09-08T00:00:00.000Z' };
    return true;
  })()`;
  for (const tab of [first, second]) {
    await tab.call('Page.navigate', { url: `${origin}/dev/t09-intent-tests.html` });
    await waitFor(() => tab.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
    await tab.evaluate(setup);
  }
  const confirmed = await Promise.all([first.evaluate('store.confirm(input, null)'), second.evaluate('store.confirm(input, null)')]);
  assert.equal(confirmed.filter(result => result.kind === 'created').length, 1);
  assert.equal(confirmed[0].intent.requestId, confirmed[1].intent.requestId);
  const originalId = confirmed[0].intent.requestId;
  await first.evaluate('store.close()');
  await first.call('Page.reload');
  await waitFor(() => first.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
  await first.evaluate(setup);
  assert.equal((await first.evaluate('store.current(input.accountId, input.profileInstanceId)')).requestId, originalId);
  const newIntent = await second.evaluate(`store.confirm({ ...input, requestId: crypto.randomUUID() }, ${JSON.stringify(originalId)})`);
  assert.equal(newIntent.kind, 'created');
  const stale = await first.evaluate(`store.confirm(input, ${JSON.stringify(originalId)})`);
  assert.equal(stale.kind, 'existing');
  assert.equal(stale.intent.requestId, newIntent.intent.requestId);
  assert.equal((await first.evaluate(`store.find(${JSON.stringify(originalId)})`)).requestId, originalId);
  await Promise.all([first.evaluate('store.close()'), second.evaluate('store.close()')]);
  assert.deepEqual(first.blockedRequests, []);
});
