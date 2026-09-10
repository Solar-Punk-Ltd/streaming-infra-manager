/**
 * The operator's own path, connected end to end.
 *
 * A real sign-in, the real money router, a real PostgreSQL journal, the owned
 * Docker transport and a synthetic Bee. The browser is the only client, and
 * nothing between it and the database is a mock. What is synthetic is the Bee,
 * the chain and the database.
 *
 * It needs a disposable PostgreSQL on T09_TEST_PG_PORT. Without it every case
 * skips out loud rather than passing quietly.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { launchViteFor } from './support/transfer-fixture.mjs';

const pgPort = Number(process.env.T09_TEST_PG_PORT);
const HAS_DATABASE = Number.isInteger(pgPort) && pgPort > 0 && pgPort < 65536;
const SKIP_REASON = 'T09_TEST_PG_PORT is not set, so no disposable PostgreSQL is available for the connected browser suite';
const serverPath = fileURLToPath(new URL('../../manager/test/support/connectedChequebookServer.ts', import.meta.url));
const managerDirectory = fileURLToPath(new URL('../../manager/', import.meta.url));
const POLLED_SENTENCE = "The manager checks the chain for this transaction's receipt about every 20 seconds until";

async function connectedManager(t) {
  const child = fork(serverPath, [], { cwd: managerDirectory, silent: true,
    execArgv: ['--import', 'tsx', '--conditions=development'],
    env: { ...process.env, T09_TEST_PG_PORT: String(pgPort) } });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32_768); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
      child.disconnect();
      try { await exited; }
      catch { child.kill('SIGKILL'); await once(child, 'exit'); }
    }
    if (output.trim()) t.diagnostic(`Connected manager output: ${output.slice(-2000)}`);
  });
  const [ready] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(60_000) }),
    once(child, 'exit').then(() => { throw new Error(`The connected manager exited before startup: ${output.slice(-2000)}`); }),
  ]);
  assert.equal(ready.ready, true, `the connected manager reported ${JSON.stringify(ready)}`);
  let nextCommand = 0;
  async function command(message) {
    const id = ++nextCommand;
    const reply = new Promise(resolve => {
      const listen = value => { if (value?.id === id) { child.off('message', listen); resolve(value); } };
      child.on('message', listen);
    });
    child.send({ ...message, id });
    return Promise.race([reply, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The connected manager did not answer')), 10_000))]);
  }
  return { ...ready, url: `http://127.0.0.1:${ready.port}`, command,
    counts: () => command({ kind: 'counts' }),
    answerReceipt: answer => command({ kind: 'receipt', answer }),
    dropNextResponse: () => command({ kind: 'drop-next-response' }) };
}

async function signedInBrowser(t, manager, fixture, path) {
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Sign in from a page with no app on it, so the app itself boots with the session already in place.
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate('document.readyState === "complete"'), Boolean, 'the sign-in page to finish loading');
  const login = await browser.evaluate(`(async () => {
    const response = await fetch('/auth/login', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'streaming-infra-manager' },
      body: ${JSON.stringify(JSON.stringify({ username: manager.username, password: manager.password }))} });
    return response.status;
  })()`);
  assert.equal(login, 204, 'the browser signed in through the real login route');
  await browser.call('Page.navigate', { url: `${fixture.origin}${path}` });
  await waitFor(() => browser.evaluate('document.readyState === "complete"'), Boolean, 'the app to finish loading');
  return browser;
}

async function visible(browser, text, timeoutMs) {
  try { await waitFor(() => browser.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), Boolean, text, timeoutMs); }
  catch (error) {
    error.message += `\nOn screen: ${String(await browser.evaluate('document.body?.innerText')).slice(0, 1500)}`;
    throw error;
  }
}

/** The offline dialog harness starts on a made-up account. The connected cases use the one that signed in. */
async function useSignedInAccount(browser) {
  const id = await browser.evaluate(`fetch('/auth/session', { credentials: 'same-origin', headers: { 'x-requested-with': 'streaming-infra-manager' } })
    .then(response => response.json()).then(session => session.id)`);
  assert.equal(Number.isSafeInteger(id) && id > 0, true, 'the session route named the signed-in account');
  await waitFor(() => browser.evaluate('typeof window.t09Ui?.account === "function"'), Boolean, 'the dialog harness');
  await browser.evaluate(`t09Ui.account(${id})`);
  return id;
}
async function click(browser, text) {
  await waitFor(() => browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}); return !!button && !button.disabled; })()`), Boolean, `enabled ${text} button`);
  await browser.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
async function amount(browser, value) {
  await waitFor(() => browser.evaluate("!!document.querySelector('[role=dialog] input') && !document.querySelector('[role=dialog] input').disabled"), Boolean, 'editable amount');
  await browser.evaluate(`(() => { const input = document.querySelector('[role="dialog"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function moveBzz(browser, value = '0.5') {
  await click(browser, 'Fill chequebook');
  await amount(browser, value);
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
}
async function savedRequestId(browser, manager, accountId) {
  const requestId = await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); const intent = await store.current(${accountId}, ${JSON.stringify(manager.profileInstanceId)}); await store.close(); return intent?.requestId ?? null; })()`);
  assert.ok(requestId, 'the browser saved its request');
  return requestId;
}
async function screenshot(browser, fixture, name) {
  const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
  const path = join(fixture.evidence, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}

test('a real deposit reaches settlement in the dialog without a click', { skip: HAS_DATABASE ? false : SKIP_REASON }, async t => {
  const manager = await connectedManager(t);
  const fixture = await launchViteFor(t, manager.url);
  const browser = await signedInBrowser(t, manager, fixture, '/dev/t09-dialog-tests.html');
  await visible(browser, 'Storage and funding');
  await useSignedInAccount(browser);
  await moveBzz(browser);
  await visible(browser, 'Waiting for transaction confirmation', 30_000);
  await visible(browser, POLLED_SENTENCE);
  assert.equal((await manager.counts()).beePosts, 1, 'the synthetic Bee received one transfer');
  await manager.answerReceipt('success');
  await visible(browser, 'Transfer verified on chain', 30_000);
  t.diagnostic(await screenshot(browser, fixture, 'connected-settled'));
  assert.equal((await manager.counts()).beePosts, 1, 'settling sent no second transfer');
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

test('a lost Bee response stays unresolved and blocks the next move', { skip: HAS_DATABASE ? false : SKIP_REASON }, async t => {
  const manager = await connectedManager(t);
  const fixture = await launchViteFor(t, manager.url);
  const browser = await signedInBrowser(t, manager, fixture, '/dev/t09-dialog-tests.html');
  await visible(browser, 'Storage and funding');
  const accountId = await useSignedInAccount(browser);
  await manager.dropNextResponse();
  await moveBzz(browser);
  await visible(browser, 'Submission outcome unknown', 30_000);
  const afterSubmit = await manager.counts();
  assert.equal(afterSubmit.beePosts, 1);
  assert.equal(afterSubmit.receiptReads, 0, 'a row with no hash is never inspected for a receipt');
  const requestId = await savedRequestId(browser, manager, accountId);
  t.diagnostic(await screenshot(browser, fixture, 'connected-unknown'));

  const pages = await signedInBrowser(t, manager, fixture, `/#/transfers/request/${requestId}`);
  await visible(pages, 'Submission outcome unknown', 30_000);
  await click(pages, 'Search transaction history');
  await visible(pages, 'The action response was received', 30_000);
  await visible(pages, 'Submission outcome unknown');
  assert.equal((await manager.counts()).receiptReads, 0, 'recovery asked the chain for no receipt');

  const otherOperator = await signedInBrowser(t, manager, fixture, '/dev/t09-dialog-tests.html');
  await visible(otherOperator, 'Storage and funding');
  await useSignedInAccount(otherOperator);
  await moveBzz(otherOperator);
  await visible(otherOperator, 'Another transfer blocks this node', 30_000);
  assert.equal((await manager.counts()).beePosts, 1, 'the blocked intent sent no second transfer');
  assert.deepEqual(browser.errors, []);
});

test('the transfer history and detail pages read the real journal', { skip: HAS_DATABASE ? false : SKIP_REASON }, async t => {
  const manager = await connectedManager(t);
  const fixture = await launchViteFor(t, manager.url);
  const dialog = await signedInBrowser(t, manager, fixture, '/dev/t09-dialog-tests.html');
  await visible(dialog, 'Storage and funding');
  const accountId = await useSignedInAccount(dialog);
  await moveBzz(dialog);
  await visible(dialog, 'Waiting for transaction confirmation', 30_000);
  const requestId = await savedRequestId(dialog, manager, accountId);

  const pages = await signedInBrowser(t, manager, fixture, '/#/transfers');
  await visible(pages, 'Transfer history', 30_000);
  await visible(pages, manager.profileName);
  await pages.evaluate(`window.location.hash = '#/transfers/request/${requestId}'`);
  await visible(pages, 'Saved transfer', 30_000);
  await visible(pages, requestId);
  await visible(pages, POLLED_SENTENCE);
  await visible(pages, 'Waiting for transaction confirmation');
  t.diagnostic(await screenshot(pages, fixture, 'connected-detail-polling'));
  await manager.answerReceipt('success');
  await visible(pages, 'Transfer verified on chain', 30_000);
  assert.equal(await pages.evaluate(`document.body.innerText.includes(${JSON.stringify(POLLED_SENTENCE)})`), false);
  assert.equal((await manager.counts()).beePosts, 1);
  assert.deepEqual(pages.errors, []);
});
