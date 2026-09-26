/**
 * The web2 admin link, set up from the pages, in a real Chrome at a phone's
 * width.
 *
 * Levi ruled on 2026-09-25 that linking a deployment's stream uploader to the
 * web2 admin works out of the box. This drives the Manager settings page's
 * card: an address and a token set once for every new uploader deployment, a
 * token that is never shown and only said to be stored, a value the manager
 * would refuse named under its field, Test connection with the sentence for
 * its outcome, and clearing the stored token.
 *
 * A real headless Chrome over a real Vite, proxying to the real dev mock
 * manager, whose Test connection reads its outcome off the address, so every
 * sentence can be seen offline. Runs with the other suites under
 * `pnpm test:browser`, or on its own:
 * `node --import tsx --conditions=development --test test/admin-link-browser.test.mjs`.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import { DEV_PASSWORD, DEV_USERNAME } from '../dev/mock-auth.mjs';
import {
  buttonWithText,
  clickWhenEnabled,
  fillWhenPresent,
  launchChrome,
  PAGE_TEXT,
  readWhenPresent,
  waitFor,
} from './support/chrome.mjs';
import { evidenceDirectory } from './support/evidence.mjs';
import { freePort, startMockManager } from './support/mock-manager-process.mjs';
import { endViteServer } from './support/teardown.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

/** A cold Vite cache can hold a page behind a dependency re-optimization, and this is only spent while waiting. */
const COLD_OPTIMIZE_BUDGET_MS = 45_000;

const NARROW = 390;

const frontend = fileURLToPath(new URL('../', import.meta.url));

/** Synthetic, and never expected on any page once typed. */
const TOKEN = 'offline-admin-link-token-0123456789abcdef';
const ADMIN_URL = 'https://admin.offline.example';

const SENTENCES = {
  'token-accepted': 'The web2 admin answered and took the token.',
  'token-refused': 'The web2 admin answered but refused the token.',
  unreachable: 'The web2 admin did not answer from where the manager runs.',
  redirected: 'This address answered with a redirect, so give the address the web2 admin itself answers on.',
  'not-admin': 'Something answered at this address, but not the way a web2 admin does.',
};

test('the web2 admin link for new deployments, set on the Manager settings page at a phone width', { timeout: 300_000 }, async (t) => {
  const manager = await startMockManager(t);
  process.env.VITE_MANAGER_URL = manager;
  const server = await createServer({
    root: frontend,
    configFile: resolve(frontend, 'vite.config.ts'),
    cacheDir: viteCacheFor('admin-link'),
    server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  });
  await server.listen();
  t.after(() => endViteServer(t, server));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const { call, evaluate } = await launchChrome(t, origin);
  const evidence = await evidenceDirectory('admin-link-browser-');
  await call('Emulation.setDeviceMetricsOverride', { width: NARROW, height: 900, deviceScaleFactor: 1, mobile: false });

  const body = () => evaluate(PAGE_TEXT);
  const settled = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (finder, description) => {
    await clickWhenEnabled(evaluate, finder, description, COLD_OPTIMIZE_BUDGET_MS);
    await settled();
  };
  const found = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const card = `[...document.querySelectorAll('.MuiPaper-root')].find(paper => paper.querySelector('h3')?.textContent === 'Web2 admin link for new deployments')`;
  const cardText = () => evaluate(`(${card})?.innerText ?? ''`);
  const urlField = found('#manager-admin-link-url');
  const tokenField = found('#manager-admin-link-token');
  const inCard = (text) => `[...((${card})?.querySelectorAll('button') ?? [])].find(button => button.textContent.trim() === ${JSON.stringify(text)})`;
  const noSidewaysScroll = () => evaluate('document.documentElement.scrollWidth <= innerWidth');
  const screenshot = async (name) => {
    const { data } = await call('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(join(evidence, name), Buffer.from(data, 'base64'));
  };
  const testWith = async (url, outcome) => {
    await fillWhenPresent(evaluate, urlField, url, 'the address field');
    await click(inCard('Test connection'), 'the Test connection button');
    await waitFor(cardText, (text) => text.includes(SENTENCES[outcome]), `the ${outcome} sentence`);
  };

  await call('Page.navigate', { url: `${origin}/#/` });
  await waitFor(body, (text) => text.includes('Sign in to the manager'), 'the sign-in page', COLD_OPTIMIZE_BUDGET_MS);
  await fillWhenPresent(evaluate, found('input[name=username]'), DEV_USERNAME, 'the username field');
  await fillWhenPresent(evaluate, found('input[name=password]'), DEV_PASSWORD, 'the password field');
  await click(buttonWithText('Sign in'), 'the Sign in button');
  await waitFor(body, (text) => text.includes('New deployment'), 'the app to boot', COLD_OPTIMIZE_BUDGET_MS);

  await t.test('the Manager settings page is in the navigation, and its card starts with no link', async () => {
    await click(found('button[aria-label="open navigation"]'), 'the navigation button');
    await click(`[...document.querySelectorAll('.MuiListItemButton-root')].find(item => item.textContent.trim() === 'Manager settings')`, 'the Manager settings item');
    await waitFor(cardText, (text) => text.includes('No token is stored.'), 'the card with no token stored', COLD_OPTIMIZE_BUDGET_MS);

    assert.equal(await evaluate('location.hash'), '#/manager-settings');
    assert.equal(await readWhenPresent(evaluate, urlField, 'value', 'the address field'), '');
    assert.equal(await evaluate(`${tokenField}.type`), 'password');
    assert.equal(await evaluate(`${tokenField}.getAttribute('autocomplete')`), 'new-password');
    assert.match(await cardText(), /Type the address to test it\./);
    assert.equal(await evaluate(`(${inCard('Test connection')}).disabled`), true);
    assert.match(await cardText(), /The test runs from where the manager runs, so an address only the deployment's own network can reach reads as unreachable here\./);
    assert.equal(await noSidewaysScroll(), true);
  });

  await t.test('names an address or a token the manager would refuse under its field, and keeps Save off', async () => {
    await fillWhenPresent(evaluate, urlField, 'https://operator:offline-password@admin.offline.example', 'the address field');
    await waitFor(cardText, (text) => text.includes('ADMIN_API_URL cannot carry a user name or a password.'), 'the address refusal');
    await fillWhenPresent(evaluate, urlField, ADMIN_URL, 'the address field');
    await fillWhenPresent(evaluate, tokenField, 'short', 'the token field');
    await waitFor(cardText, (text) => text.includes('ADMIN_API_TOKEN must be at least 32 characters.'), 'the token refusal');

    assert.equal(await evaluate(`(${inCard('Save')}).disabled`), true);
    assert.equal((await body()).includes('offline-password'), false);
    assert.equal(await noSidewaysScroll(), true);
  });

  await t.test('tests the typed address and token before they are saved', async () => {
    await fillWhenPresent(evaluate, tokenField, TOKEN, 'the token field');
    await testWith(ADMIN_URL, 'token-accepted');
    assert.equal((await body()).includes(TOKEN), false);
  });

  await t.test('saves the link, and afterwards says a token is stored without ever showing it', async () => {
    await click(inCard('Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes('A token is stored. It is never shown.'), 'the stored token');

    assert.equal(await readWhenPresent(evaluate, urlField, 'value', 'the address field'), ADMIN_URL);
    assert.equal(await evaluate(`${tokenField}.value`), '');
    assert.equal((await body()).includes(TOKEN), false);
    await evaluate(`(${card}).scrollIntoView({ block: 'start' })`);
    await screenshot('manager-link-saved-phone.png');
  });

  await t.test("tests with the stored token, and says each outcome's sentence", async () => {
    for (const outcome of ['token-refused', 'unreachable', 'redirected', 'not-admin']) {
      await testWith(`https://${outcome}.admin.offline.example`, outcome);
    }
    assert.equal(await noSidewaysScroll(), true);
    await screenshot('manager-link-tested-phone.png');
    await fillWhenPresent(evaluate, urlField, ADMIN_URL, 'the address field');
  });

  await t.test('clears the stored token', async () => {
    await click(inCard('Clear the stored token'), 'the Clear button');
    await waitFor(cardText, (text) => text.includes('The stored token is taken out when you save.'), 'the pending clear');
    await click(inCard('Save'), 'the Save button');
    await waitFor(cardText, (text) => text.includes('No token is stored.'), 'the cleared token');

    assert.match(await cardText(), /Type a token to test it\./);
    assert.equal(await noSidewaysScroll(), true);
  });
});
